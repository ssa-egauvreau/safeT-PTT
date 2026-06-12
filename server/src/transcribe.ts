// Background transcription of recorded transmissions using a self-hosted Whisper
// model (transformers.js / ONNX). Best-effort: failures never block recording.
//
// The Whisper pipeline runs in a worker_thread (see transcribeWorker.ts), NOT on
// the main event loop: this process is also the realtime voice relay, and a
// single in-process inference used to stall frame forwarding long enough to
// register as buffer underruns / PLC on every connected handset. The main
// thread keeps the queue, the DB writes, and the AI-dispatch hand-off; the
// worker only ever sees WAV bytes and returns text.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { enqueueAiDispatchForTransmission } from "./aiDispatch/engine.js";
import { getPool } from "./db.js";
import { getTransmissionAudio, listPendingTranscriptionIds, setTranscript } from "./store.js";

const ENABLED = (process.env.TRANSCRIPTION ?? "on").trim().toLowerCase() !== "off";
const MODEL = process.env.WHISPER_MODEL?.trim() || "Xenova/whisper-tiny.en";
/** After a worker crash or failed model load, wait before respawning (Railway OOM / cold start). */
const LOAD_RETRY_MS = Number(process.env.WHISPER_LOAD_RETRY_MS) || 120_000;
/**
 * Cap how long a single transcription waits on the worker (model load + inference). Without this
 * a hung or very slow first-time model download (HF Hub fetch on a cold Railway container) blocks
 * the whole queue forever — every transmission sits at "Transcribing…". On timeout the queue
 * gives up on this item while the load keeps running in the worker for the next one.
 */
const LOAD_TIMEOUT_MS = Number(process.env.WHISPER_LOAD_TIMEOUT_MS) || 180_000;

type TranscriberState = "idle" | "loading" | "ready" | "broken";

let state: TranscriberState = "idle";
let lastLoadFailedAt = 0;
const queue: number[] = [];
let working = false;

let worker: Worker | null = null;
let workerDiedAt = 0;
/** Resolver for the single in-flight job (the pump serializes, so at most one). */
let inflight: { id: number; resolve: (text: string | null) => void } | null = null;

export interface TranscriptionDiagnostics {
  enabled: boolean;
  model: string;
  state: TranscriberState;
  database_configured: boolean;
  queue_depth: number;
  last_load_failed_at: string | null;
}

export function getTranscriptionDiagnostics(): TranscriptionDiagnostics {
  return {
    enabled: ENABLED,
    model: MODEL,
    state,
    database_configured: getPool() !== null,
    queue_depth: queue.length,
    last_load_failed_at: lastLoadFailedAt > 0 ? new Date(lastLoadFailedAt).toISOString() : null,
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
 * Returns the live worker, spawning one if needed. The compiled build ships
 * transcribeWorker.js next to this file; under tsx (dev / tests) only the .ts
 * source exists, and the worker inherits the parent's tsx loader via execArgv.
 * Returns null while inside the post-crash cooldown so a worker that OOMs on
 * load doesn't respawn-loop the container.
 */
function ensureWorker(): Worker | null {
  if (worker) {
    return worker;
  }
  if (workerDiedAt > 0 && Date.now() - workerDiedAt < LOAD_RETRY_MS) {
    return null;
  }
  const compiled = new URL("./transcribeWorker.js", import.meta.url);
  const source = new URL("./transcribeWorker.ts", import.meta.url);
  const url = existsSync(fileURLToPath(compiled)) ? compiled : source;
  let spawned: Worker;
  try {
    spawned = new Worker(url);
  } catch (error) {
    workerDiedAt = Date.now();
    lastLoadFailedAt = workerDiedAt;
    state = "broken";
    console.warn("Transcription worker failed to start", error);
    return null;
  }
  spawned.unref();
  spawned.on("message", (msg: WorkerMessage) => {
    if (msg?.type === "state" && msg.state) {
      state = msg.state;
      lastLoadFailedAt = msg.state === "broken" ? Date.now() : 0;
      return;
    }
    if (msg?.type === "result" && inflight && msg.id === inflight.id) {
      const done = inflight;
      inflight = null;
      done.resolve(msg.ok ? msg.text ?? "" : null);
    }
  });
  const onGone = (reason: string) => (detail?: unknown): void => {
    if (worker !== spawned) {
      return;
    }
    worker = null;
    workerDiedAt = Date.now();
    lastLoadFailedAt = workerDiedAt;
    state = "broken";
    console.warn(`Transcription worker ${reason}`, detail ?? "");
    if (inflight) {
      const done = inflight;
      inflight = null;
      done.resolve(null);
    }
  };
  spawned.on("error", onGone("error"));
  spawned.on("exit", (code) => {
    if (code !== 0) {
      onGone(`exited with code ${code}`)();
    } else if (worker === spawned) {
      worker = null;
    }
  });
  worker = spawned;
  workerDiedAt = 0;
  return worker;
}

/** Ships one WAV to the worker; resolves with the transcript, or null on any failure/timeout. */
function runInWorker(id: number, wav: Buffer): Promise<string | null> {
  const w = ensureWorker();
  if (!w) {
    return Promise.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      if (inflight && inflight.id === id) {
        console.warn(
          `Transcription for transmission ${id} exceeded ${LOAD_TIMEOUT_MS}ms; skipping it while the worker continues.`,
        );
        inflight = null;
        resolve(null);
      }
    }, LOAD_TIMEOUT_MS);
    inflight = {
      id,
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
    };
    // Copy into a transferable so the worker never aliases a pg-owned buffer.
    const body = new ArrayBuffer(wav.byteLength);
    new Uint8Array(body).set(wav);
    try {
      w.postMessage({ type: "transcribe", id, wav: body }, [body]);
    } catch (error) {
      console.warn(`Could not hand transmission ${id} to the transcription worker`, error);
      clearTimeout(timer);
      inflight = null;
      resolve(null);
    }
  });
}

async function transcribeOne(id: number): Promise<void> {
  try {
    const record = await getTransmissionAudio(id);
    if (!record) {
      return;
    }
    const text = await runInWorker(id, record.audio);
    if (text === null) {
      await setTranscript(id, "failed", null);
      // Still hand off to AI so the activity log records a "transcript unavailable" skip
      // instead of the transmission silently vanishing from the AI dispatch log.
      enqueueAiDispatchForTransmission(id);
      return;
    }
    await setTranscript(id, "done", text);
    // Queue AI even when STT is empty so the activity log can record "no speech" skips.
    enqueueAiDispatchForTransmission(id);
  } catch (error) {
    console.warn(`Transcription failed for transmission ${id}`, error);
    await setTranscript(id, "failed", null).catch(() => undefined);
    enqueueAiDispatchForTransmission(id);
  }
}

async function pump(): Promise<void> {
  if (working) {
    return;
  }
  working = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      await transcribeOne(id);
    }
  } finally {
    working = false;
  }
}

/** Queues a freshly recorded transmission for transcription. */
export function enqueueTranscription(id: number): void {
  if (!ENABLED) {
    void setTranscript(id, "disabled", null)
      .then(() => enqueueAiDispatchForTransmission(id))
      .catch(() => undefined);
    return;
  }
  queue.push(id);
  void pump();
}

/** Re-queues any transmissions left pending by an earlier crash/restart. */
export async function recoverPendingTranscriptions(): Promise<void> {
  if (!ENABLED) {
    return;
  }
  try {
    const ids = await listPendingTranscriptionIds();
    for (const id of ids) {
      queue.push(id);
    }
    if (ids.length > 0) {
      console.log(`Re-queued ${ids.length} pending transcription(s).`);
      void pump();
    }
  } catch (error) {
    console.warn("Could not recover pending transcriptions", error);
  }
}
