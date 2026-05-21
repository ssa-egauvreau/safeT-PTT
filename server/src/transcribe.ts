// Background transcription of recorded transmissions using a self-hosted Whisper
// model (transformers.js / ONNX). Best-effort: failures never block recording.

import { enqueueAiDispatchForTransmission } from "./aiDispatch/engine.js";
import { getPool } from "./db.js";
import { getTransmissionAudio, listPendingTranscriptionIds, setTranscript } from "./store.js";
import { decodeWavToFloat32 } from "./wav.js";

const ENABLED = (process.env.TRANSCRIPTION ?? "on").trim().toLowerCase() !== "off";
const MODEL = process.env.WHISPER_MODEL?.trim() || "Xenova/whisper-tiny.en";
/**
 * Quantization for the ONNX weights. Default fp32 loads ~4x the memory and is the slowest on CPU;
 * a memory-constrained Railway instance can OOM mid-inference, leaving transmissions stuck on
 * "Transcribing…". q8 quarters the footprint and is much faster on CPU. Override with WHISPER_DTYPE
 * (fp32 / fp16 / q8 / q4) if a model lacks quantized weights.
 */
const DTYPE = process.env.WHISPER_DTYPE?.trim() || "q8";
/** After a failed model load, wait before retrying (Railway OOM / cold start). */
const LOAD_RETRY_MS = Number(process.env.WHISPER_LOAD_RETRY_MS) || 120_000;
/**
 * Cap how long a single transcription worker waits on the model load. Without this a hung or
 * very slow first-time model download (HF Hub fetch on a cold Railway container) blocks the
 * whole queue forever — every transmission sits at "Transcribing…". On timeout the worker
 * gives up on this item while the load keeps running in the background for the next one.
 */
const LOAD_TIMEOUT_MS = Number(process.env.WHISPER_LOAD_TIMEOUT_MS) || 180_000;

type TranscriberState = "idle" | "loading" | "ready" | "broken";

let state: TranscriberState = "idle";
let lastLoadFailedAt = 0;
type WhisperPipeline = (audio: Float32Array, options?: unknown) => Promise<{ text?: string }>;

let pipelineFn: WhisperPipeline | null = null;
let loadPromise: Promise<WhisperPipeline | null> | null = null;
const queue: number[] = [];
let working = false;

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

/** Loads the Whisper pipeline once; returns null if it cannot be loaded. Retries after cooldown. */
async function ensurePipeline(): Promise<WhisperPipeline | null> {
  if (pipelineFn) {
    return pipelineFn;
  }
  if (state === "broken") {
    if (Date.now() - lastLoadFailedAt < LOAD_RETRY_MS) {
      return null;
    }
    console.log("[transcribe] retrying Whisper model load after previous failure");
    state = "idle";
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      state = "loading";
      try {
        const moduleName = "@huggingface/transformers";
        const transformers = (await import(moduleName)) as {
          pipeline: (
            task: string,
            model: string,
            options?: Record<string, unknown>,
          ) => Promise<WhisperPipeline>;
        };
        pipelineFn = await transformers.pipeline("automatic-speech-recognition", MODEL, {
          dtype: DTYPE,
          device: "cpu",
        });
        state = "ready";
        lastLoadFailedAt = 0;
        console.log(`Transcriber ready (model ${MODEL}, dtype ${DTYPE}).`);
      } catch (error) {
        state = "broken";
        lastLoadFailedAt = Date.now();
        pipelineFn = null;
        console.warn(
          "Transcriber unavailable — transmissions will be recorded without transcripts.",
          error,
        );
      } finally {
        // Cleared here (not on timeout) so a slow load keeps running in the background and the
        // next worker can reuse it instead of restarting the download.
        loadPromise = null;
      }
      return pipelineFn;
    })();
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `Whisper model load exceeded ${LOAD_TIMEOUT_MS}ms; skipping this transmission while the load continues.`,
      );
      resolve(null);
    }, LOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([loadPromise ?? Promise.resolve(pipelineFn), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function transcribeOne(id: number): Promise<void> {
  try {
    const record = await getTransmissionAudio(id);
    if (!record) {
      return;
    }
    const run = await ensurePipeline();
    if (!run) {
      await setTranscript(id, "failed", null);
      // Still hand off to AI so the activity log records a "transcript unavailable" skip
      // instead of the transmission silently vanishing from the AI dispatch log.
      enqueueAiDispatchForTransmission(id);
      return;
    }
    const samples = decodeWavToFloat32(record.audio);
    if (samples.length === 0) {
      await setTranscript(id, "done", "");
      enqueueAiDispatchForTransmission(id);
      return;
    }
    const result = await run(samples, { chunk_length_s: 30, stride_length_s: 5 });
    const text = (result?.text ?? "").trim();
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
