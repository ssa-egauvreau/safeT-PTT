/**
 * Tests for `server/src/aiDispatch/knowledgeBase/chunk.ts`.
 *
 * `chunkText` slices an agency document into the snippets that are embedded
 * (and later ranked by `rankChunks`) for the AI dispatcher RAG flow. A
 * regression here silently degrades every dispatch reply: chunks that are too
 * big OOM the embedding model on a constrained Railway box, and chunks that
 * lose word boundaries either retrieve the wrong snippet or read mid-word in
 * the spoken context. Both failure modes show up as worse answers — not as
 * exceptions — so they need explicit coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkText } from "../../../src/aiDispatch/knowledgeBase/chunk.js";

test("chunkText: empty or whitespace-only input returns no chunks (don't index nothing)", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
  assert.deepEqual(chunkText("\n\n\t   "), []);
});

test("chunkText: text shorter than the size threshold returns a single chunk", () => {
  assert.deepEqual(chunkText("hello world"), ["hello world"]);
});

test("chunkText: collapses internal whitespace and trims before chunking", () => {
  // Newlines, tabs, and runs of spaces must normalize to a single space — the
  // embedder treats whitespace as a separator, and ragged whitespace inflates
  // chunk char counts past the byte budget without adding any signal.
  assert.deepEqual(chunkText("a\n\nb   c\td"), ["a b c d"]);
});

test("chunkText: clamps size below the safe minimum (50) instead of producing tiny chunks", () => {
  // The CHUNK_SIZE floor exists because chunks under ~50 chars are too short
  // to be retrievable signal — a regression that respected the caller's
  // `size: 10` would shred a document into hundreds of unusable fragments.
  const text = "word ".repeat(8).trim(); // 39 chars, well under the 50 floor
  const out = chunkText(text, { size: 10, overlap: 5 });
  assert.equal(out.length, 1, "size is clamped to >= 50, so this short text fits in one chunk");
  assert.equal(out[0], text);
});

test("chunkText: long input splits into multiple chunks that each respect the size cap", () => {
  const longText = "word ".repeat(400).trim(); // ~1999 chars
  const size = 200;
  const out = chunkText(longText, { size, overlap: 50 });

  assert.ok(out.length > 1, "long text must split into multiple chunks");
  for (const chunk of out) {
    assert.ok(
      chunk.length <= size,
      `chunk must not exceed size (got ${chunk.length}): ${JSON.stringify(chunk).slice(0, 60)}…`,
    );
  }
});

test("chunkText: consecutive chunks share an overlap so context is not lost at boundaries", () => {
  // Overlap exists so a sentence split across two chunks still appears whole
  // in one of them. A regression that dropped overlap reverts to "hard cut"
  // chunking which is observably worse on retrieval.
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const out = chunkText(words, { size: 80, overlap: 30 });

  assert.ok(out.length >= 2, "fixture must produce at least two chunks");
  for (let i = 1; i < out.length; i++) {
    const prevTail = out[i - 1]!.slice(-30);
    const nextHead = out[i]!.slice(0, 30);
    // Find at least one whole shared token between the two adjacent chunks.
    const prevTokens = new Set(prevTail.split(" ").filter((t) => t.length > 0));
    const sharedToken = nextHead
      .split(" ")
      .filter((t) => t.length > 0)
      .some((token) => prevTokens.has(token));
    assert.ok(
      sharedToken,
      `chunks ${i - 1} and ${i} share no overlapping token (tail=${prevTail!.slice(-20)} head=${nextHead.slice(0, 20)})`,
    );
  }
});

test("chunkText: overlap=0 produces chunks with no shared tokens between neighbors", () => {
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const out = chunkText(words, { size: 80, overlap: 0 });

  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    const prevTokens = new Set(out[i - 1]!.split(" "));
    const nextTokens = out[i]!.split(" ");
    for (const token of nextTokens) {
      assert.ok(
        !prevTokens.has(token),
        `with overlap=0, chunk ${i} must not repeat token "${token}" from chunk ${i - 1}`,
      );
    }
  }
});

test("chunkText: chunks resume from a word boundary inside the overlap tail (never mid-word)", () => {
  // A regression that resumed mid-word would embed a partial token like
  // "phabet" instead of "alphabet" — which is fine for cosine math but
  // misleads anything that ever surfaces the chunk text to a human.
  const words = Array.from({ length: 80 }, (_, i) => `token${i}`).join(" ");
  const out = chunkText(words, { size: 120, overlap: 40 });
  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    const first = out[i]!.split(" ")[0]!;
    // Either the chunk begins with the first word of the doc, or it begins
    // with one of the original whole tokens (never a partial "ken17").
    assert.match(first, /^token\d+$/, `chunk ${i} should start at a token boundary, got "${first}"`);
  }
});

test("chunkText: preserves every original token across all chunks (no data dropped at split)", () => {
  const tokens = Array.from({ length: 50 }, (_, i) => `t${i}`);
  const out = chunkText(tokens.join(" "), { size: 80, overlap: 25 });
  const seen = new Set(out.flatMap((c) => c.split(" ")));
  for (const token of tokens) {
    assert.ok(seen.has(token), `chunk output must include token "${token}"`);
  }
});
