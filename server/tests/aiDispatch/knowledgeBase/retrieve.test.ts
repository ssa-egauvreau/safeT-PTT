/**
 * Tests for `server/src/aiDispatch/knowledgeBase/retrieve.ts`.
 *
 * `rankChunks` and `formatKnowledgeContext` are the two pure helpers behind
 * the AI dispatcher's RAG flow. Together they decide:
 *   1. Which knowledge snippets get attached to a dispatch reply.
 *   2. How they're labelled so the LLM (and reviewers) can trust the source.
 *
 * The risky regressions covered here:
 *   - Ranking that ignores cosine similarity → the wrong snippet gets cited.
 *   - Property-match boost not applied → a generic snippet outranks the
 *     site-specific one the officer is standing in front of.
 *   - MIN_SCORE filter removed → unrelated noise is injected into the prompt
 *     (and confidently spoken on the radio).
 *   - Context block exceeds the char cap → the user turn balloons and either
 *     truncates important fields or runs over the model's context window.
 *
 * `retrieveKnowledge` itself does I/O (DB + ONNX), so it is exercised
 * indirectly: every input to the LLM goes through these two pure helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { KbChunkRow } from "../../../src/store.js";
import {
  formatKnowledgeContext,
  rankChunks,
  type RetrievedChunk,
} from "../../../src/aiDispatch/knowledgeBase/retrieve.js";

/** Build a KbChunkRow inline so individual tests can stay readable. */
function chunkRow(overrides: Partial<KbChunkRow> & Pick<KbChunkRow, "embedding">): KbChunkRow {
  return {
    id: "row-id",
    document_id: 1,
    title: "Post order",
    category: "post_order",
    property_code: null,
    content: "stub content",
    ...overrides,
  } as KbChunkRow;
}

test("rankChunks: orders results by cosine similarity (highest score first)", () => {
  const query = [1, 0];
  const chunks: KbChunkRow[] = [
    chunkRow({ document_id: 1, title: "Far", embedding: [0.3, 0.9] }), // ~0.3
    chunkRow({ document_id: 2, title: "Near", embedding: [1, 0] }), //   1.0
    chunkRow({ document_id: 3, title: "Mid", embedding: [0.7, 0.7] }), //  0.7
  ];
  const ranked = rankChunks(query, chunks);
  assert.deepEqual(
    ranked.map((r) => r.title),
    ["Near", "Mid", "Far"],
  );
});

test("rankChunks: drops candidates whose cosine score falls below MIN_SCORE (0.25 default)", () => {
  const query = [1, 0];
  const chunks: KbChunkRow[] = [
    chunkRow({ document_id: 1, title: "Strong", embedding: [1, 0] }), //   1.0
    chunkRow({ document_id: 2, title: "Weak", embedding: [0.1, 0.99] }), // 0.1 — below 0.25
  ];
  const ranked = rankChunks(query, chunks);
  assert.equal(ranked.length, 1, "weak match must be filtered out");
  assert.equal(ranked[0]!.title, "Strong");
});

test("rankChunks: returns an empty list when nothing scores above MIN_SCORE", () => {
  const query = [1, 0];
  const chunks: KbChunkRow[] = [
    chunkRow({ document_id: 1, title: "Bad A", embedding: [0.05, 0.99] }),
    chunkRow({ document_id: 2, title: "Bad B", embedding: [0.1, 0.99] }),
  ];
  assert.deepEqual(rankChunks(query, chunks), []);
});

test("rankChunks: property-match boost lifts a relevant site doc past a generic one", () => {
  // Without the boost the two chunks tie at 0.30 and order is undefined.
  // With the boost (default 0.15) the site doc rises by 0.15 to 0.45.
  const query = [1, 0];
  const chunks: KbChunkRow[] = [
    chunkRow({
      document_id: 1,
      title: "Generic policy",
      embedding: [0.30, 0.95],
      property_code: null,
    }),
    chunkRow({
      document_id: 2,
      title: "Site post order",
      embedding: [0.30, 0.95],
      property_code: "P-001",
    }),
  ];

  const ranked = rankChunks(query, chunks, { propertyCode: "P-001" });
  assert.equal(ranked[0]!.title, "Site post order");
  // The boosted score should be ~0.15 higher than the generic one.
  assert.ok(
    ranked[0]!.score > ranked[1]!.score + 0.1,
    `expected boost gap, got scores ${ranked[0]!.score} vs ${ranked[1]!.score}`,
  );
});

test("rankChunks: a propertyCode that does NOT match leaves the score untouched", () => {
  const query = [1, 0];
  const chunks: KbChunkRow[] = [
    chunkRow({ document_id: 1, title: "Other site", embedding: [1, 0], property_code: "P-OTHER" }),
  ];
  const ranked = rankChunks(query, chunks, { propertyCode: "P-001" });
  assert.equal(ranked[0]!.score, 1, "mismatched property must not earn the boost");
});

test("rankChunks: topK caps how many chunks make it back to the prompt", () => {
  const query = [1, 0];
  const chunks: KbChunkRow[] = Array.from({ length: 8 }, (_, i) =>
    chunkRow({ document_id: i, title: `Doc ${i}`, embedding: [1, 0] }),
  );
  const ranked = rankChunks(query, chunks, { topK: 3 });
  assert.equal(ranked.length, 3);
});

test("rankChunks: dimension mismatch is treated as zero similarity (and filtered out)", () => {
  // Real production cause: a model swap leaves old vectors at a different
  // dimension. The store filters these on read, but the ranker must also
  // refuse to mix dimensions instead of throwing or returning garbage.
  const query = [1, 0, 0]; // 3-d query
  const chunks: KbChunkRow[] = [
    chunkRow({ document_id: 1, title: "Old 2d vector", embedding: [1, 0] }),
  ];
  assert.deepEqual(rankChunks(query, chunks), []);
});

test("rankChunks: empty chunk list returns empty (no DB rows, no work)", () => {
  assert.deepEqual(rankChunks([1, 0], []), []);
});

test("formatKnowledgeContext: empty list yields '' so the user turn stays unchanged", () => {
  assert.equal(formatKnowledgeContext([]), "");
});

test("formatKnowledgeContext: each chunk is labelled with its category-friendly name and title", () => {
  const ranked: RetrievedChunk[] = [
    {
      documentId: 1,
      title: "Building 7 patrol",
      category: "post_order",
      score: 0.9,
      content: "Walk the loading dock every two hours.",
    },
  ];
  const out = formatKnowledgeContext(ranked);
  // "post_order" → "Post orders" via getKbCategoryLabel.
  assert.match(out, /^\[Post orders: Building 7 patrol\]\n/);
  assert.ok(out.includes("Walk the loading dock every two hours."));
});

test("formatKnowledgeContext: unknown category falls back to a generic 'Reference' label", () => {
  // A regression that surfaced the raw category id would push opaque tokens
  // ("call_classifications") into the prompt, where the LLM treats them as
  // structured signals instead of a label.
  const ranked: RetrievedChunk[] = [
    {
      documentId: 7,
      title: "Misc note",
      category: "not_a_real_category_id",
      score: 0.5,
      content: "anything",
    },
  ];
  assert.match(formatKnowledgeContext(ranked), /^\[Reference: Misc note\]/);
});

test("formatKnowledgeContext: chunks are separated by a blank line so the LLM sees discrete entries", () => {
  const ranked: RetrievedChunk[] = [
    { documentId: 1, title: "A", category: "post_order", score: 0.9, content: "alpha" },
    { documentId: 2, title: "B", category: "post_order", score: 0.8, content: "bravo" },
  ];
  const out = formatKnowledgeContext(ranked);
  const entries = out.split("\n\n");
  assert.equal(entries.length, 2, "two chunks must produce two blank-line-separated entries");
  assert.match(entries[0]!, /^\[Post orders: A\]\nalpha$/);
  assert.match(entries[1]!, /^\[Post orders: B\]\nbravo$/);
});

test("formatKnowledgeContext: stops adding chunks once the total would exceed MAX_CONTEXT_CHARS", () => {
  // MAX_CONTEXT_CHARS defaults to 4000 — pad each chunk so two fit but a
  // third would overflow. A regression that ignored the cap would balloon
  // every user turn the LLM ever sees.
  const big = "x".repeat(1800);
  const ranked: RetrievedChunk[] = [
    { documentId: 1, title: "A", category: "post_order", score: 0.9, content: big },
    { documentId: 2, title: "B", category: "post_order", score: 0.8, content: big },
    { documentId: 3, title: "C", category: "post_order", score: 0.7, content: big },
  ];
  const out = formatKnowledgeContext(ranked);
  assert.ok(out.includes("[Post orders: A]"));
  assert.ok(out.includes("[Post orders: B]"));
  assert.ok(!out.includes("[Post orders: C]"), "third chunk would push past the char cap");
});

test("formatKnowledgeContext: the first chunk is always included even if it alone exceeds the cap", () => {
  // The cap is a soft cap — dropping the only candidate altogether would
  // leave the dispatcher with no context at all and surface as a quality
  // regression long before anyone realises the cap is to blame.
  const huge = "y".repeat(8000);
  const ranked: RetrievedChunk[] = [
    { documentId: 1, title: "Only", category: "post_order", score: 0.9, content: huge },
  ];
  const out = formatKnowledgeContext(ranked);
  assert.ok(out.includes("[Post orders: Only]"));
  assert.ok(out.includes("yyyyyyyyy"));
});
