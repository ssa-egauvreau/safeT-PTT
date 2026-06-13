// Local in-process text embeddings for the AI dispatcher knowledge base
// (transformers.js / ONNX). Mirrors the lazy, degrade-to-null loader in
// transcribe.ts: a failed model load (Railway OOM / cold start) never throws —
// callers treat a null result as "no knowledge base" and proceed unchanged.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const MODEL = process.env.KB_EMBED_MODEL?.trim() || "Xenova/all-MiniLM-L6-v2";
/** q8 quarters the memory footprint vs fp32 — same reasoning as WHISPER_DTYPE. */
const DTYPE = process.env.KB_EMBED_DTYPE?.trim() || "q8";
/** After a failed model load, wait before retrying (Railway OOM / cold start). */
const LOAD_RETRY_MS = Number(process.env.KB_EMBED_LOAD_RETRY_MS) || 120_000;
/** Cap how long a caller waits on the first model load before giving up for now. */
const LOAD_TIMEOUT_MS = Number(process.env.KB_EMBED_LOAD_TIMEOUT_MS) || 180_000;
/**
 * Texts embedded per forward pass. The whole batch becomes one padded tensor, so
 * a large document embedded all at once can OOM a constrained box — keep it small.
 */
const BATCH_SIZE = Math.max(1, Number(process.env.KB_EMBED_BATCH_SIZE) || 16);

type EmbedPipeline = (
  texts: string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ tolist: () => number[][] }>;

interface EmbedTextsOptions {
  signal?: AbortSignal;
}

let pipelineFn: EmbedPipeline | null = null;
let loadPromise: Promise<EmbedPipeline | null> | null = null;
let state: "idle" | "loading" | "ready" | "broken" = "idle";
let lastLoadFailedAt = 0;

/** The model chunks are currently embedded with — stamped on each indexed document. */
export function getEmbeddingModelName(): string {
  return MODEL;
}

export function getEmbeddingDiagnostics(): {
  model: string;
  state: string;
  last_load_failed_at: string | null;
} {
  return {
    model: MODEL,
    state,
    last_load_failed_at: lastLoadFailedAt > 0 ? new Date(lastLoadFailedAt).toISOString() : null,
  };
}

/**
 * Persist the model cache to the Railway volume (or MODEL_CACHE_DIR) so the
 * embedding model downloads once, not on every deploy. Same best-effort policy
 * and cache dir as the transcription worker — both models share it. See
 * transcribeWorker.applyModelCacheDir.
 */
function applyModelCacheDir(env: { cacheDir?: string } | undefined): void {
  if (!env) return;
  const explicit = process.env.MODEL_CACHE_DIR?.trim();
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const dir = explicit || (vol ? join(vol, "model-cache") : "");
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    env.cacheDir = dir;
    console.log(`[kb] embedding model cache: ${dir}`);
  } catch (error) {
    console.warn(`[kb] could not use model cache dir ${dir}; using default (re-downloads each boot).`, error);
  }
}

async function ensurePipeline(): Promise<EmbedPipeline | null> {
  if (pipelineFn) {
    return pipelineFn;
  }
  if (state === "broken") {
    if (Date.now() - lastLoadFailedAt < LOAD_RETRY_MS) {
      return null;
    }
    console.log("[kb] retrying embedding model load after previous failure");
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
          ) => Promise<EmbedPipeline>;
          env?: { cacheDir?: string };
        };
        applyModelCacheDir(transformers.env);
        pipelineFn = await transformers.pipeline("feature-extraction", MODEL, {
          dtype: DTYPE,
          device: "cpu",
        });
        state = "ready";
        lastLoadFailedAt = 0;
        console.log(`[kb] embedding model ready (model ${MODEL}, dtype ${DTYPE}).`);
      } catch (error) {
        state = "broken";
        lastLoadFailedAt = Date.now();
        pipelineFn = null;
        console.warn("[kb] embedding model unavailable — knowledge base retrieval disabled.", error);
      } finally {
        loadPromise = null;
      }
      return pipelineFn;
    })();
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[kb] embedding model load exceeded ${LOAD_TIMEOUT_MS}ms; skipping for now.`);
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

/**
 * Triggers the model load in the background so the first retrieval at dispatch
 * time isn't stuck waiting on a cold load. Safe to call once at startup.
 */
export function warmEmbeddings(): void {
  void ensurePipeline().catch(() => undefined);
}

/**
 * Embeds texts into normalized vectors (cosine similarity == dot product).
 * Processes in small batches to bound peak memory. Returns null when the model
 * cannot be loaded so callers degrade gracefully.
 */
export async function embedTexts(
  texts: string[],
  options: EmbedTextsOptions = {},
): Promise<number[][] | null> {
  if (texts.length === 0) {
    return [];
  }
  if (options.signal?.aborted) {
    return null;
  }
  const run = await ensurePipeline();
  if (!run || options.signal?.aborted) {
    return null;
  }
  try {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      if (options.signal?.aborted) {
        return null;
      }
      const batch = texts.slice(i, i + BATCH_SIZE);
      const output = await run(batch, { pooling: "mean", normalize: true });
      if (options.signal?.aborted) {
        return null;
      }
      for (const vec of output.tolist()) {
        vectors.push(vec);
      }
    }
    return vectors;
  } catch (error) {
    if (options.signal?.aborted) {
      return null;
    }
    console.warn("[kb] embedding inference failed", error);
    return null;
  }
}
