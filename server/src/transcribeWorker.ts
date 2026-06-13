// Worker-thread host for the Whisper pipeline (transformers.js / ONNX).
//
// Transcription used to run on the main thread, in the same event loop that
// forwards every 20 ms voice frame through the WebSocket relay. Whisper's
// JS-side feature extraction (log-mel spectrogram) is synchronous CPU work
// measured in hundreds of ms to seconds per transmission, so every recorded
// talk-spurt stalled the relay for everyone connected — heard in the field as
// audio cutting in and out and reported by handsets as buffer underruns / PLC
// on the Link Health dashboard. Hosting the pipeline in a worker_thread keeps
// the relay's event loop free; ONNX inference still competes for container
// CPU, but the relay only needs sub-millisecond slices to forward frames.
//
// Protocol (single in-flight job; the main thread serializes):
//   main → worker  { type: "transcribe", id, wav: ArrayBuffer }
//   worker → main  { type: "state", state: "loading" | "ready" | "broken" }
//   worker → main  { type: "result", id, ok: true, text } |
//                  { type: "result", id, ok: false, error }

import { parentPort } from "node:worker_threads";

// This module hosts the ONNX/transformers.js pipeline. It can run either as a
// worker_thread (parentPort set) or — preferred — as a forked child process
// (process.send set). onnxruntime-node is NOT safe to run from multiple V8
// isolates in one process: driving concurrent inference from several
// worker_threads aborts the process with "HandleScope ... without proper
// locking". Separate child processes have independent isolates, so the pool
// uses fork() and this worker speaks whichever channel it was started on.
const useProcessIpc = !parentPort && typeof process.send === "function";

const MODEL = process.env.WHISPER_MODEL?.trim() || "Xenova/whisper-tiny.en";
const DTYPE = process.env.WHISPER_DTYPE?.trim() || "q8";
/** After a failed model load, wait before retrying (Railway OOM / cold start). */
const LOAD_RETRY_MS = Number(process.env.WHISPER_LOAD_RETRY_MS) || 120_000;
/**
 * Hard cap on the model load itself. transformers.pipeline() fetches the model
 * from the HF Hub on a cold container and inits ONNX; that fetch has no timeout
 * of its own, so a stalled download leaves the worker stuck posting "loading"
 * forever — every transmission then sits at "Transcribing…" and the queue grows
 * unbounded (seen in production: state "loading", queue climbing, never a
 * failure recorded). Bounding the load turns that hang into a "broken" state the
 * existing retry path recovers from. Kept below the main thread's per-job
 * LOAD_TIMEOUT_MS (180s) so the worker reports broken before the main side
 * blunt-times-out the job.
 */
const MODEL_LOAD_TIMEOUT_MS = Number(process.env.WHISPER_MODEL_LOAD_TIMEOUT_MS) || 150_000;

type WhisperPipeline = (audio: Float32Array, options?: unknown) => Promise<{ text?: string }>;

let pipelineFn: WhisperPipeline | null = null;
let loadPromise: Promise<WhisperPipeline | null> | null = null;
let lastLoadFailedAt = 0;

interface TranscribeJob {
  type?: string;
  id?: number;
  wav?: ArrayBuffer;
}

function post(message: unknown): void {
  if (useProcessIpc) {
    process.send?.(message);
  } else {
    parentPort?.postMessage(message);
  }
}

/**
 * Mono 16-bit WAV → normalized Float32 samples (whisper input). Duplicated
 * from wav.ts on purpose: the dev/test runtime (tsx) cannot map `./wav.js`
 * specifiers to `.ts` sources inside worker threads, so this module must not
 * import anything from the project by relative path. Keep in sync with
 * `decodeWavToFloat32` in wav.ts.
 */
const WAV_HEADER_BYTES = 44;
function decodeWavToFloat32(wav: Buffer): Float32Array {
  let dataStart = WAV_HEADER_BYTES;
  let dataLen = Math.max(0, wav.length - WAV_HEADER_BYTES);

  // Walk subchunks to find "data" (handles any extra chunks before it).
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  dataLen = Math.min(dataLen, wav.length - dataStart);
  const sampleCount = Math.max(0, Math.floor(dataLen / 2));
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = wav.readInt16LE(dataStart + i * 2) / 32768;
  }
  return out;
}

/** Loads the Whisper pipeline once; returns null if it cannot be loaded. Retries after cooldown. */
async function ensurePipeline(): Promise<WhisperPipeline | null> {
  if (pipelineFn) {
    return pipelineFn;
  }
  if (lastLoadFailedAt > 0 && Date.now() - lastLoadFailedAt < LOAD_RETRY_MS) {
    return null;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      post({ type: "state", state: "loading" });
      try {
        const moduleName = "@huggingface/transformers";
        const transformers = (await import(moduleName)) as {
          pipeline: (
            task: string,
            model: string,
            options?: Record<string, unknown>,
          ) => Promise<WhisperPipeline>;
        };
        const loading = transformers.pipeline("automatic-speech-recognition", MODEL, {
          dtype: DTYPE,
          device: "cpu",
        });
        let loadTimer: ReturnType<typeof setTimeout> | undefined;
        const loadTimeout = new Promise<never>((_, reject) => {
          loadTimer = setTimeout(
            () => reject(new Error(`model load exceeded ${MODEL_LOAD_TIMEOUT_MS}ms`)),
            MODEL_LOAD_TIMEOUT_MS,
          );
        });
        try {
          pipelineFn = await Promise.race([loading, loadTimeout]);
        } finally {
          clearTimeout(loadTimer);
        }
        lastLoadFailedAt = 0;
        post({ type: "state", state: "ready" });
        console.log(`Transcriber ready (model ${MODEL}, dtype ${DTYPE}).`);
      } catch (error) {
        pipelineFn = null;
        lastLoadFailedAt = Date.now();
        post({ type: "state", state: "broken" });
        console.warn(
          "Transcriber unavailable — transmissions will be recorded without transcripts.",
          error,
        );
      } finally {
        loadPromise = null;
      }
      return pipelineFn;
    })();
  }
  return loadPromise;
}

function onJob(msg: TranscribeJob): void {
  if (!msg || msg.type !== "transcribe" || typeof msg.id !== "number" || !msg.wav) {
    return;
  }
  const id = msg.id;
  // worker_threads transfer an ArrayBuffer; fork IPC (advanced serialization)
  // delivers a Buffer. Buffer.from handles both.
  const wav = Buffer.from(msg.wav as ArrayBuffer);
  void (async () => {
    try {
      const run = await ensurePipeline();
      if (!run) {
        post({ type: "result", id, ok: false, error: "model_unavailable" });
        return;
      }
      const samples = decodeWavToFloat32(wav);
      if (samples.length === 0) {
        post({ type: "result", id, ok: true, text: "" });
        return;
      }
      const result = await run(samples, { chunk_length_s: 30, stride_length_s: 5 });
      post({ type: "result", id, ok: true, text: (result?.text ?? "").trim() });
    } catch (error) {
      post({
        type: "result",
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

if (useProcessIpc) {
  process.on("message", onJob);
} else {
  parentPort?.on("message", onJob);
}
