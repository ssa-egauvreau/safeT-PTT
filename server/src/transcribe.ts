// Background transcription of recorded transmissions using a self-hosted Whisper
// model (transformers.js / ONNX). Best-effort: failures never block recording.
//
// The Whisper pipeline runs in a forked CHILD PROCESS (see transcribeWorker.ts),
// NOT on the main event loop: this process is also the realtime voice relay, and
// a single in-process inference used to stall frame forwarding long enough to
// register as buffer underruns / PLC on every connected handset. The main thread
// keeps the queue, the DB writes, and the AI-dispatch hand-off; the worker only
// ever sees WAV bytes and returns text.
//
// Child processes (not worker_threads): onnxruntime-node's native addon shares
// V8 handle state across isolates in one process, so running inference from
// several worker_threads at once aborts the whole server with "HandleScope ...
// without proper locking". Separate processes have fully independent isolates,
// so the pool scales safely.

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";
import { enqueueAiDispatchForTransmission } from "./aiDispatch/engine.js";
import { getPool } from "./db.js";
import {
  getTransmissionAudio,
  listPendingTranscriptionIds,
  reapStalePendingTranscriptions,
  setTranscript,
} from "./store.js";

const ENABLED = (process.env.TRANSCRIPTION ?? "on").trim().toLowerCase() !== "off";
const MODEL = process.env.WHISPER_MODEL?.trim() || "Xenova/whisper-tiny.en";
/** After a worker crash or failed model load, wait before respawning (Railway OOM / cold start). */
const LOAD_RETRY_MS = Number(process.env.WHISPER_LOAD_RETRY_MS) || 120_000;
/**
 * A 'pending' transmission older than this is reaped to 'failed' so the console
 * stops showing a perpetual "Transcribing…". Tuned well above a healthy
 * worker's drain time; raise it if you run a slow model on a deep backlog.
 */
const STALE_PENDING_MS = Number(process.env.TRANSCRIPTION_STALE_MS) || 30 * 60_000;
/**
 * Cap how long a single transcription waits on the worker (model load + inference). Without this
 * a hung or very slow first-time model download (HF Hub fetch on a cold Railway container) blocks
 * the whole queue forever — every transmission sits at "Transcribing…". On timeout the queue
 * gives up on this item while the load keeps running in the worker for the next one.
 */
const LOAD_TIMEOUT_MS = Number(process.env.WHISPER_LOAD_TIMEOUT_MS) || 180_000;

/**
 * How many Whisper worker threads run concurrently. Each processes one clip at
 * a time, so N workers transcribe N clips in parallel — the lever for keeping
 * up with a busy fleet. Defaults to the container's CPU allotment
 * (`availableParallelism` honors the cgroup quota on Railway), capped at 3 so a
 * cold start doesn't load three+ models at once on a small box. Override with
 * TRANSCRIPTION_WORKERS; raise it on a bigger plan, hard-capped at 8.
 */
const DEFAULT_WORKERS = Math.max(1, Math.min(safeParallelism(), 3));
const WORKER_COUNT = Math.max(
  1,
  Math.min(Number(process.env.TRANSCRIPTION_WORKERS) || DEFAULT_WORKERS, 8),
);

function safeParallelism(): number {
  try {
    return availableParallelism();
  } catch {
    return 2;
  }
}

/**
 * Cloud transcription (OpenAI Whisper API). Clips on AI-dispatch channels route
 * here because it's more accurate than the local tiny model — and that's exactly
 * the traffic the AI dispatcher acts on. Scanner/bridge and other audio stays on
 * the free local pool, so OpenAI is billed only for AI-dispatch channels (see the
 * routing note on [enqueueTranscription]). Enabled whenever a key is present,
 * unless explicitly turned off. Key: TRANSCRIBE_CLOUD_API_KEY, else OPENAI_API_KEY.
 */
const CLOUD_FALLBACK_FLAG = (process.env.TRANSCRIBE_CLOUD_FALLBACK ?? "auto").trim().toLowerCase();
const CLOUD_API_KEY =
  process.env.TRANSCRIBE_CLOUD_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
const CLOUD_MODEL = process.env.TRANSCRIBE_CLOUD_MODEL?.trim() || "whisper-1";
const CLOUD_API_URL =
  process.env.TRANSCRIBE_CLOUD_URL?.trim() || "https://api.openai.com/v1/audio/transcriptions";
/** Bound concurrent cloud requests so an OOM'd box draining a backlog doesn't fan out unboundedly. */
const CLOUD_MAX_CONCURRENCY = Math.max(1, Number(process.env.TRANSCRIBE_CLOUD_CONCURRENCY) || 2);
let cloudInflight = 0;

function cloudTranscriptionEnabled(): boolean {
  return CLOUD_FALLBACK_FLAG !== "off" && CLOUD_API_KEY.length > 0;
}

/**
 * Transcribes one WAV clip via the cloud Whisper API (OpenAI). Returns the text
 * (possibly empty for silence), or null on any failure. Used only for clips on
 * AI-dispatch channels — see the routing note on [enqueueTranscription].
 */
async function transcribeViaCloud(wav: Buffer): Promise<string | null> {
  if (!CLOUD_API_KEY) {
    return null;
  }
  try {
    const form = new FormData();
    // Copy into a plain Uint8Array (fresh ArrayBuffer) — Buffer's backing store
    // can be a SharedArrayBuffer, which BlobPart's types reject.
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", CLOUD_MODEL);
    form.append("response_format", "json");
    form.append("language", "en");
    const res = await fetch(CLOUD_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${CLOUD_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[transcribe] cloud ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  } catch (error) {
    console.warn("[transcribe] cloud request failed", error);
    return null;
  }
}

/**
 * Runs one AI-dispatch-channel clip through the cloud (more accurate). On cloud
 * failure it falls back to the local pool when that's available, so a billing or
 * network hiccup never leaves the dispatcher without a transcript; only if local
 * is off too does it record "failed".
 */
async function runViaCloud(id: number): Promise<void> {
  cloudInflight++;
  let requeuedLocal = false;
  try {
    const record = await getTransmissionAudio(id);
    if (!record) {
      return;
    }
    const text = await transcribeViaCloud(record.audio);
    if (text !== null) {
      await setTranscript(id, "done", text);
      enqueueAiDispatchForTransmission(id);
      return;
    }
    // Cloud failed. Prefer a local retry over dropping an AI-dispatch transcript.
    if (ENABLED) {
      console.warn(`[transcribe] cloud failed for ${id}; falling back to local pool`);
      priorityQueue.unshift(id); // keep its high-lane position
      requeuedLocal = true;
      return;
    }
    await setTranscript(id, "failed", null);
    enqueueAiDispatchForTransmission(id);
  } catch (error) {
    console.warn(`Cloud transcription failed for transmission ${id}`, error);
    await setTranscript(id, "failed", null).catch(() => undefined);
    enqueueAiDispatchForTransmission(id);
  } finally {
    cloudInflight--;
    // Keep the id in `inQueue` if we handed it to the local pool — that path owns
    // the cleanup. Otherwise we're done with it.
    if (!requeuedLocal) {
      inQueue.delete(id);
    }
    drainCloudQueue();
    if (requeuedLocal) {
      dispatch();
    }
  }
}

/** Cloud lane scheduler: starts queued AI-channel clips up to the concurrency cap. */
function drainCloudQueue(): void {
  while (cloudInflight < CLOUD_MAX_CONCURRENCY && cloudQueue.length > 0) {
    const id = cloudQueue.shift()!;
    void runViaCloud(id);
  }
}

type TranscriberState = "idle" | "loading" | "ready" | "broken";

let state: TranscriberState = "idle";
let lastLoadFailedAt = 0;
/**
 * Two lanes, drained high-then-low. The high lane carries handset audio and any
 * clip on an AI-dispatch channel, so the AI dispatcher's transcripts never wait
 * behind a busy scanner/SDR bridge firehose in the low lane. Both share the
 * `inQueue` dedup below.
 */
const priorityQueue: number[] = [];
const queue: number[] = [];
/**
 * Cloud lane — clips on AI-dispatch channels, routed to the OpenAI Whisper API
 * (more accurate) instead of the local pool. Kept separate so OpenAI is billed
 * ONLY for AI-dispatch traffic; scanner/bridge audio never touches the cloud.
 * Shares the `inQueue` dedup below.
 */
const cloudQueue: number[] = [];
/**
 * Ids currently queued or in flight. Without this, the periodic recovery sweep
 * (which re-reads every 'pending' row, including the ones already sitting in
 * the in-memory `queue`) would push duplicates and the queue would balloon on
 * a backlog the workers haven't drained yet.
 */
const inQueue = new Set<number>();

/** One pool slot: its own worker process, in-flight job, and crash-cooldown clock. */
interface WorkerSlot {
  worker: ChildProcess | null;
  /** Set synchronously when work is assigned so a re-entrant dispatch() can't
   *  hand the same slot a second clip before its inflight is wired up. */
  busy: boolean;
  diedAt: number;
  inflight: { id: number; resolve: (text: string | null) => void } | null;
}

const slots: WorkerSlot[] = Array.from({ length: WORKER_COUNT }, () => ({
  worker: null,
  busy: false,
  diedAt: 0,
  inflight: null,
}));

/**
 * Warm-up gate. The model is downloaded into a shared on-disk HuggingFace
 * cache the first time it's loaded. If all workers cold-load an uncached model
 * at once they race to write the same files and corrupt the download — every
 * worker then reports "broken". So until one worker has loaded the model
 * (proving it's cached), only a single "cold loader" slot is allowed to spawn;
 * once it's ready the rest fan out and load from disk. `modelWarmed` latches
 * for the process lifetime.
 */
let modelWarmed = false;
let coldLoader: WorkerSlot | null = null;

export interface TranscriptionDiagnostics {
  enabled: boolean;
  model: string;
  state: TranscriberState;
  database_configured: boolean;
  queue_depth: number;
  workers: number;
  workers_busy: number;
  last_load_failed_at: string | null;
  /** Cloud Whisper fallback configured (key present + not turned off). */
  cloud_fallback: boolean;
}

export function getTranscriptionDiagnostics(): TranscriptionDiagnostics {
  return {
    enabled: ENABLED,
    model: MODEL,
    state,
    database_configured: getPool() !== null,
    queue_depth: priorityQueue.length + queue.length + cloudQueue.length,
    workers: WORKER_COUNT,
    workers_busy: slots.filter((s) => s.busy).length,
    last_load_failed_at: lastLoadFailedAt > 0 ? new Date(lastLoadFailedAt).toISOString() : null,
    cloud_fallback: cloudTranscriptionEnabled(),
  };
}

interface WorkerMessage {
  type?: string;
  state?: TranscriberState;
  id?: number;
  ok?: boolean;
  text?: string;
  error?: string;
}

/**
 * Returns the live worker for `slot`, spawning one if needed. The compiled
 * build ships transcribeWorker.js next to this file; under tsx (dev / tests)
 * only the .ts source exists, and the worker inherits the parent's tsx loader
 * via execArgv. Returns null while inside the slot's post-crash cooldown so a
 * worker that OOMs on load doesn't respawn-loop the container.
 */
function ensureSlotWorker(slot: WorkerSlot): ChildProcess | null {
  if (slot.worker) {
    return slot.worker;
  }
  if (slot.diedAt > 0 && Date.now() - slot.diedAt < LOAD_RETRY_MS) {
    return null;
  }
  const compiled = new URL("./transcribeWorker.js", import.meta.url);
  const source = new URL("./transcribeWorker.ts", import.meta.url);
  const url = existsSync(fileURLToPath(compiled)) ? compiled : source;
  let spawned: ChildProcess;
  try {
    // Forked process (not a thread) so onnxruntime gets its own V8 isolate.
    // `serialization: "advanced"` lets the WAV Buffer cross IPC intact; execArgv
    // is inherited so the dev/test tsx loader still resolves the .ts worker.
    spawned = fork(fileURLToPath(url), [], { serialization: "advanced" });
  } catch (error) {
    slot.diedAt = Date.now();
    lastLoadFailedAt = slot.diedAt;
    state = "broken";
    console.warn("Transcription worker failed to start", error);
    return null;
  }
  spawned.unref();
  spawned.on("message", (msg: WorkerMessage) => {
    if (msg?.type === "state" && msg.state) {
      state = msg.state;
      lastLoadFailedAt = msg.state === "broken" ? Date.now() : 0;
      if (msg.state === "ready") {
        // Model is cached on disk now — open the gate and wake idle slots.
        modelWarmed = true;
        coldLoader = null;
        dispatch();
      }
      return;
    }
    if (msg?.type === "result" && slot.inflight && msg.id === slot.inflight.id) {
      const done = slot.inflight;
      slot.inflight = null;
      done.resolve(msg.ok ? msg.text ?? "" : null);
    }
  });
  const onGone = (reason: string) => (detail?: unknown): void => {
    if (slot.worker !== spawned) {
      return;
    }
    slot.worker = null;
    slot.diedAt = Date.now();
    lastLoadFailedAt = slot.diedAt;
    state = "broken";
    // If the cold loader died, let another slot take over the warm-up.
    if (coldLoader === slot) {
      coldLoader = null;
    }
    console.warn(`Transcription worker ${reason}`, detail ?? "");
    if (slot.inflight) {
      const done = slot.inflight;
      slot.inflight = null;
      done.resolve(null);
    }
  };
  spawned.on("error", onGone("error"));
  spawned.on("exit", (code) => {
    if (code !== 0) {
      onGone(`exited with code ${code}`)();
    } else if (slot.worker === spawned) {
      slot.worker = null;
    }
  });
  slot.worker = spawned;
  slot.diedAt = 0;
  return slot.worker;
}

/** Ships one WAV to a slot's worker; resolves with the transcript, or null on any failure/timeout. */
function sendToSlot(slot: WorkerSlot, w: ChildProcess, id: number, wav: Buffer): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      if (slot.inflight && slot.inflight.id === id) {
        console.warn(
          `Transcription for transmission ${id} exceeded ${LOAD_TIMEOUT_MS}ms; skipping it while the worker continues.`,
        );
        slot.inflight = null;
        resolve(null);
      }
    }, LOAD_TIMEOUT_MS);
    slot.inflight = {
      id,
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
    };
    try {
      // Advanced IPC serialization copies the Buffer to the child intact.
      w.send({ type: "transcribe", id, wav }, (error) => {
        if (error && slot.inflight?.id === id) {
          console.warn(`Could not hand transmission ${id} to the transcription worker`, error);
          slot.inflight = null;
          clearTimeout(timer);
          resolve(null);
        }
      });
    } catch (error) {
      console.warn(`Could not hand transmission ${id} to the transcription worker`, error);
      clearTimeout(timer);
      slot.inflight = null;
      resolve(null);
    }
  });
}

/** Runs one transmission end-to-end on a claimed slot, then frees it and pulls the next. */
async function runOnSlot(slot: WorkerSlot, w: ChildProcess, id: number): Promise<void> {
  try {
    const record = await getTransmissionAudio(id);
    if (!record) {
      return;
    }
    const text = await sendToSlot(slot, w, id, record.audio);
    await setTranscript(id, text === null ? "failed" : "done", text);
    // Queue AI even on empty/failed STT so the activity log can record the skip
    // instead of the transmission silently vanishing from the AI dispatch log.
    enqueueAiDispatchForTransmission(id);
  } catch (error) {
    console.warn(`Transcription failed for transmission ${id}`, error);
    await setTranscript(id, "failed", null).catch(() => undefined);
    enqueueAiDispatchForTransmission(id);
  } finally {
    slot.busy = false;
    inQueue.delete(id);
    dispatch();
  }
}

/** Assigns queued clips to every idle, spawnable worker — the pool's scheduler. */
function dispatch(): void {
  for (const slot of slots) {
    if (priorityQueue.length === 0 && queue.length === 0) {
      break;
    }
    if (slot.busy) {
      continue;
    }
    const needsSpawn = slot.worker === null;
    // Warm-up gate: until the model is cached (first worker ready), only the
    // single cold-loader slot may spawn — others would race the download.
    if (needsSpawn && !modelWarmed && coldLoader !== null && coldLoader !== slot) {
      continue;
    }
    const w = ensureSlotWorker(slot);
    if (!w) {
      continue; // in crash cooldown / failed to spawn — another slot may take it
    }
    if (needsSpawn && !modelWarmed) {
      coldLoader = slot; // this slot owns the one-time cold load
    }
    // High lane first so AI / handset clips beat the low-priority bridge firehose.
    const id = (priorityQueue.length > 0 ? priorityQueue.shift() : queue.shift())!;
    slot.busy = true;
    void runOnSlot(slot, w, id);
  }
}

/**
 * Queues a freshly recorded transmission for transcription. Deduped so a
 * recovery sweep can't double-enqueue an id already waiting in a lane.
 *
 * Routing (the golden rule): a clip on an **AI-dispatch channel** (`cloud: true`)
 * goes to the OpenAI Whisper API when a cloud key is configured — it's more
 * accurate, and that's where it matters. Everything else (handset chatter,
 * scanner/SDR-bridge audio) stays on the free local Whisper pool. OpenAI is
 * therefore billed ONLY for AI-dispatch traffic. With no cloud key, AI clips
 * fall back to the local high lane. `priority` puts a local clip in the high lane.
 */
export function enqueueTranscription(
  id: number,
  opts?: { priority?: boolean; cloud?: boolean },
): void {
  const routeToCloud = !!opts?.cloud && cloudTranscriptionEnabled();
  // Nothing can transcribe this clip: local off and it's not a cloud-routed
  // AI-dispatch clip. Record 'disabled' so it doesn't sit at "Transcribing…".
  if (!routeToCloud && !ENABLED) {
    void setTranscript(id, "disabled", null)
      .then(() => enqueueAiDispatchForTransmission(id))
      .catch(() => undefined);
    return;
  }
  if (inQueue.has(id)) {
    return;
  }
  inQueue.add(id);
  if (routeToCloud) {
    cloudQueue.push(id);
    drainCloudQueue();
    return;
  }
  if (opts?.priority) {
    priorityQueue.push(id);
  } else {
    queue.push(id);
  }
  dispatch();
}

/**
 * Drains every transmission left at 'pending' — by an earlier crash/restart
 * (the in-memory queue does not survive a restart) or never enqueued at all.
 * Reads in batches and stops when caught up, so a backlog of thousands isn't
 * capped at the old single-shot LIMIT 200 that orphaned the overflow forever.
 * Safe to call periodically: the `inQueue` dedup means already-queued ids are
 * skipped, so it converges as the worker drains.
 */
export async function recoverPendingTranscriptions(): Promise<void> {
  if (!ENABLED && !cloudTranscriptionEnabled()) {
    return;
  }
  try {
    // First, retire anything so old it will never be useful as a live
    // transcript — otherwise the console shows a permanent "Transcribing…".
    const reaped = await reapStalePendingTranscriptions(STALE_PENDING_MS);
    if (reaped > 0) {
      console.log(`Reaped ${reaped} stale pending transcription(s) to 'failed'.`);
    }
    // Fetch the oldest pending rows (capped). Anything beyond the cap is picked
    // up on the next periodic sweep once the worker has drained some of these —
    // far better than the old single-shot LIMIT 200 that orphaned the rest.
    const ids = await listPendingTranscriptionIds(5000);
    const fresh = ids.filter((id) => !inQueue.has(id));
    // We don't carry per-id AI-channel routing across a restart, so recover on
    // whatever pool is available: the local lane when it's on (the common case),
    // else the cloud lane (local-off / cloud-only deployments).
    for (const id of fresh) {
      inQueue.add(id);
      if (ENABLED) {
        queue.push(id);
      } else {
        cloudQueue.push(id);
      }
    }
    if (fresh.length > 0) {
      console.log(`Re-queued ${fresh.length} pending transcription(s).`);
      if (ENABLED) {
        dispatch();
      } else {
        drainCloudQueue();
      }
    }
  } catch (error) {
    console.warn("Could not recover pending transcriptions", error);
  }
}
