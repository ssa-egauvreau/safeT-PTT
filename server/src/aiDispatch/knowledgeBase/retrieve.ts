// Retrieval-Augmented Generation for the AI dispatcher: embed the radio
// transcript, rank the agency's stored chunks by cosine similarity, and return
// the top matches as a labelled context block to inject into the LLM request.
// Every failure path returns "" so the dispatcher behaves exactly as it does
// without a knowledge base.

import { getKbCategoryLabel, listKbChunksForAgency, type KbChunkRow } from "../../store.js";
import { embedTexts, getEmbeddingModelName } from "./embeddings.js";

const ENABLED = (process.env.KB_ENABLED ?? "on").trim().toLowerCase() !== "off";
const TOP_K = Number(process.env.KB_RETRIEVE_TOP_K) || 5;
/**
 * Hard cap on how long retrieval may delay a dispatch reply. Embedding the query
 * waits on the model load; on a cold model we'd rather skip the knowledge base
 * (return "") than make an officer wait on the air. The background load keeps
 * running, so the next transmission picks it up warm.
 */
const RETRIEVE_TIMEOUT_MS = Math.max(250, Number(process.env.KB_RETRIEVE_TIMEOUT_MS) || 2500);
/** Drop weak matches so unrelated traffic gets no (misleading) context. */
const MIN_SCORE = Number(process.env.KB_MIN_SCORE) || 0.25;
/** Added to a chunk's score when it belongs to the property named on the air. */
const PROPERTY_BOOST = Number(process.env.KB_PROPERTY_BOOST) || 0.15;
/** Cap injected characters so a big corpus can't blow up the (uncached) user turn. */
const MAX_CONTEXT_CHARS = Number(process.env.KB_MAX_CONTEXT_CHARS) || 4000;

// transformers.js does not expose reliable cancellation once an ONNX forward pass
// starts, so retrieval embeds are gated to one in-flight query. Timed-out cold
// loads can then be aborted before inference instead of piling up stale work.
let retrievalEmbedInFlight: Promise<number[][] | null> | null = null;

/** Cosine similarity of two equal-length vectors (already normalized → dot product). */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

export interface RetrievedChunk {
  documentId: number;
  title: string;
  category: string;
  score: number;
  content: string;
}

/**
 * Ranks an agency's knowledge chunks against a query. Exposed (alongside
 * {@link retrieveKnowledge}) so the ranking can be exercised directly.
 */
export function rankChunks(
  queryEmbedding: number[],
  chunks: KbChunkRow[],
  opts: { propertyCode?: string | null; topK?: number } = {},
): RetrievedChunk[] {
  const topK = opts.topK ?? TOP_K;
  const propertyCode = opts.propertyCode?.trim() || null;

  const scored = chunks.map((chunk) => {
    let score = cosine(queryEmbedding, chunk.embedding);
    if (propertyCode && chunk.property_code && chunk.property_code === propertyCode) {
      score += PROPERTY_BOOST;
    }
    return {
      documentId: chunk.document_id,
      title: chunk.title,
      category: chunk.category,
      score,
      content: chunk.content,
    };
  });

  return scored
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
}

/** Formats ranked chunks into the labelled block appended to the LLM user turn. */
export function formatKnowledgeContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const label = getKbCategoryLabel(chunk.category);
    const entry = `[${label}: ${chunk.title}]\n${chunk.content}`;
    if (used + entry.length > MAX_CONTEXT_CHARS && lines.length > 0) {
      break;
    }
    lines.push(entry);
    used += entry.length;
  }
  return lines.join("\n\n");
}

function startRetrievalEmbed(query: string, signal: AbortSignal): Promise<number[][] | null> | null {
  if (retrievalEmbedInFlight) {
    console.warn("[kb] retrieval query embed already in flight; skipping this request.");
    return null;
  }

  const trackedPromise: Promise<number[][] | null> = embedTexts([query], { signal }).finally(() => {
    if (retrievalEmbedInFlight === trackedPromise) {
      retrievalEmbedInFlight = null;
    }
  });
  retrievalEmbedInFlight = trackedPromise;
  return trackedPromise;
}

/**
 * Returns relevant agency knowledge for a transcript as a context string, or ""
 * when KB is disabled, the model can't load, or nothing scores above threshold.
 */
export async function retrieveKnowledge(
  agencyId: number,
  queryText: string,
  opts: { propertyCode?: string | null; topK?: number } = {},
): Promise<string> {
  if (!ENABLED) {
    return "";
  }
  const query = queryText.trim();
  if (!query) {
    return "";
  }
  try {
    const chunks = await listKbChunksForAgency(agencyId, getEmbeddingModelName());
    if (chunks.length === 0) {
      return "";
    }
    const abortController = new AbortController();
    const embedPromise = startRetrievalEmbed(query, abortController.signal);
    if (!embedPromise) {
      return "";
    }
    let timer: NodeJS.Timeout | undefined;
    const embedded = await Promise.race([
      embedPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          abortController.abort();
          console.warn(`[kb] retrieval query embed exceeded ${RETRIEVE_TIMEOUT_MS}ms; skipping.`);
          resolve(null);
        }, RETRIEVE_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
    if (!embedded || !embedded[0]) {
      return "";
    }
    const ranked = rankChunks(embedded[0], chunks, opts);
    const context = formatKnowledgeContext(ranked);
    if (context) {
      console.log(
        `[ai-dispatch] kb retrieved ${ranked.length} chunk(s) for agency=${agencyId} top_score=${ranked[0]?.score.toFixed(3)}`,
      );
    }
    return context;
  } catch (error) {
    console.warn(`[kb] retrieval failed for agency ${agencyId}`, error);
    return "";
  }
}
