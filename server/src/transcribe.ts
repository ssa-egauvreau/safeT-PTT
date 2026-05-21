// Background transcription of recorded transmissions using a self-hosted Whisper
// model (transformers.js / ONNX). Best-effort: failures never block recording.

import { enqueueAiDispatchForTransmission } from "./aiDispatch/engine.js";
import { decodeWavToFloat32 } from "./wav.js";
import { getTransmissionAudio, listPendingTranscriptionIds, setTranscript } from "./store.js";

const ENABLED = (process.env.TRANSCRIPTION ?? "on").trim().toLowerCase() !== "off";
const MODEL = process.env.WHISPER_MODEL?.trim() || "Xenova/whisper-tiny.en";

type TranscriberState = "idle" | "loading" | "ready" | "broken";

let pipelineFn: ((audio: Float32Array, options?: unknown) => Promise<{ text?: string }>) | null = null;
let state: TranscriberState = "idle";
const queue: number[] = [];
let working = false;

/** Loads the Whisper pipeline once; returns null if it cannot be loaded. */
async function ensurePipeline(): Promise<typeof pipelineFn> {
  if (pipelineFn || state === "broken") {
    return pipelineFn;
  }
  state = "loading";
  try {
    // Indirect specifier keeps the server build independent of this optional package.
    const moduleName = "@huggingface/transformers";
    const transformers = (await import(moduleName)) as {
      pipeline: (task: string, model: string) => Promise<typeof pipelineFn>;
    };
    pipelineFn = await transformers.pipeline("automatic-speech-recognition", MODEL);
    state = "ready";
    console.log(`Transcriber ready (model ${MODEL}).`);
  } catch (error) {
    state = "broken";
    console.warn("Transcriber unavailable — transmissions will be recorded without transcripts.", error);
  }
  return pipelineFn;
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
      return;
    }
    const samples = decodeWavToFloat32(record.audio);
    if (samples.length === 0) {
      await setTranscript(id, "done", "");
      return;
    }
    const result = await run(samples, { chunk_length_s: 30, stride_length_s: 5 });
    const text = (result?.text ?? "").trim();
    await setTranscript(id, "done", text);
    if (text) {
      enqueueAiDispatchForTransmission(id);
    }
  } catch (error) {
    console.warn(`Transcription failed for transmission ${id}`, error);
    await setTranscript(id, "failed", null).catch(() => undefined);
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
    void setTranscript(id, "disabled", null).catch(() => undefined);
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
