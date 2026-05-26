/**
 * Regression tests for `server/src/aiDispatch/speech/precachePhrases.ts`.
 *
 * Why this matters
 * ----------------
 * The TTS precache is what makes the AI dispatcher feel "instant" on the
 * radio for the most common acks ("Copy 352.", "10-4.", "Affirm, you're
 * 10-2."). At boot the server walks `buildPrecachePhraseList()` for every
 * agency and synthesises each phrase against ElevenLabs once, then keys
 * the resulting MP3 by `normalizeForTtsPrecache(phrase)`. Every live
 * dispatcher reply runs the same normaliser on the outgoing text and
 * either returns the cached audio in ~0 ms or falls through to a live
 * synthesis (≥ 250-400 ms — long enough that the unit hears dead air
 * before the response starts).
 *
 * Two silent regressions hide behind this code:
 *
 *   1. **Asymmetric normalisation** — if the precache *seeds* under one
 *      key and the lookup runs a different normaliser, every cache read
 *      misses and every reply pays the full live-synthesis latency. The
 *      contract here is that both producer and consumer route through
 *      `normalizeForTtsPrecache`. A regression that started lower-casing
 *      one side but not the other, or that stopped collapsing whitespace
 *      on one side, would silently undo the precache without any error.
 *
 *   2. **Phrase-list drift** — `buildPrecachePhraseList` is the single
 *      source of truth for what gets warmed at boot. A regression that
 *      dropped the per-unit "Copy {unit}" or "{unit}, 913" variants
 *      would force every plate-related ack onto the live path. Pin
 *      both the canonical unit ids and the trailing-punctuation shape
 *      so a refactor that swapped a hyphen for an en-dash, or that
 *      dropped a unit from the roster, gets noticed.
 *
 * Tests are pure-functional — no DB, no fetch, no env reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrecachePhraseList,
  normalizeForTtsPrecache,
} from "../../../src/aiDispatch/speech/precachePhrases.js";

// ===== normalizeForTtsPrecache ==========================================

test("normalizeForTtsPrecache: trims, lowercases, strips trailing terminal punctuation", () => {
  // The cache key shape pinned here is what both the producer (boot-time
  // precache) and the consumer (live tts.ts) use — any of the three
  // transformations regressing makes every lookup miss.
  assert.equal(normalizeForTtsPrecache("Copy."), "copy");
  assert.equal(normalizeForTtsPrecache("Copy"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy?"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy!"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy..."), "copy");
  assert.equal(normalizeForTtsPrecache("  Copy  "), "copy");
});

test("normalizeForTtsPrecache: collapses internal whitespace to a single space", () => {
  // Run-of-the-mill cleanup the dispatcher LLM occasionally produces
  // ("Copy 352,  standby" or "Copy\t352"). Without the collapse the
  // cache key would be "copy 352,  standby" while the seed used
  // "copy 352, standby" — silent miss on a very common ack shape.
  assert.equal(normalizeForTtsPrecache("Copy  352"), "copy 352");
  assert.equal(normalizeForTtsPrecache("Copy\t352"), "copy 352");
  assert.equal(normalizeForTtsPrecache("Copy\n352"), "copy 352");
  assert.equal(normalizeForTtsPrecache("  Copy   352  "), "copy 352");
});

test("normalizeForTtsPrecache: strips ONLY the trailing terminal run, not embedded punctuation", () => {
  // Mid-string punctuation must survive (it changes how the TTS engine
  // pronounces the line); only the closing run of [.!?] is removed.
  assert.equal(normalizeForTtsPrecache("Copy 352, 10-8."), "copy 352, 10-8");
  assert.equal(normalizeForTtsPrecache("Copy. Standby."), "copy. standby");
  assert.equal(normalizeForTtsPrecache("Affirm, 352, 10-2."), "affirm, 352, 10-2");
});

test("normalizeForTtsPrecache: idempotent — running it twice yields the same key", () => {
  // The producer at boot writes `normalize(phrase)`; the consumer at
  // runtime calls `normalize(outgoingText)`. Idempotence guarantees the
  // two keys match even if a downstream caller accidentally double-
  // normalises.
  for (const v of [
    "Copy 352.",
    "  Affirm   352  ",
    "  Copy. Standby.   ",
    "Copy\t352, 10-8!",
  ]) {
    const once = normalizeForTtsPrecache(v);
    const twice = normalizeForTtsPrecache(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(v)}`);
  }
});

test("normalizeForTtsPrecache: coerces non-string input via String() without throwing", () => {
  // The runtime caller passes the dispatcher's outgoing text directly; a
  // future regression that fed a number or undefined through the
  // normaliser must not crash the synthesis path. The current impl uses
  // String(text) so undefined/null collapse to the literal strings
  // "undefined"/"null" — that's not a useful precache key but it is
  // deterministic, and it must not throw. Pin the actual behaviour so a
  // future refactor that *did* start throwing on a non-string is caught.
  assert.doesNotThrow(() => normalizeForTtsPrecache(undefined as unknown as string));
  assert.doesNotThrow(() => normalizeForTtsPrecache(null as unknown as string));
  assert.equal(normalizeForTtsPrecache(123 as unknown as string), "123");
  // Numbers with terminal-punctuation-looking digits don't trip the
  // trailing [.!?]+ stripper.
  assert.equal(normalizeForTtsPrecache(10.4 as unknown as string), "10.4");
});

test("normalizeForTtsPrecache: handles empty / whitespace-only / pure-punctuation input", () => {
  // The producer skips these on its side; the consumer must produce the
  // same empty key so a precache lookup with garbage input misses cleanly
  // rather than colliding with a real cached phrase.
  assert.equal(normalizeForTtsPrecache(""), "");
  assert.equal(normalizeForTtsPrecache("   "), "");
  assert.equal(normalizeForTtsPrecache("..."), "");
  assert.equal(normalizeForTtsPrecache("!!!"), "");
  assert.equal(normalizeForTtsPrecache("?!.?!"), "");
});

// ===== buildPrecachePhraseList ==========================================

test("buildPrecachePhraseList: returns a non-empty, de-duplicated list of unique strings", () => {
  // The phrase list is the single source of truth for what gets warmed
  // at boot; a refactor that returned an empty array would silently
  // degrade every "instant ack" reply to a full live synthesis.
  const phrases = buildPrecachePhraseList();
  assert.ok(phrases.length > 0, "phrase list must not be empty");
  assert.equal(
    new Set(phrases).size,
    phrases.length,
    "phrase list must be deduplicated (Set already enforces this in the impl)",
  );
  for (const p of phrases) {
    assert.equal(typeof p, "string");
    assert.ok(p.length > 0, "no empty phrases");
  }
});

test("buildPrecachePhraseList: includes every short canonical ack the AI uses", () => {
  // The deterministic dispatcher (dispatchAck.ts) emits these exact
  // strings as the on-air reply; if any drops out of the precache the
  // most common ack becomes the *slowest* one. Pin them explicitly.
  const phrases = new Set(buildPrecachePhraseList());
  for (const required of [
    "Copy",
    "10-4",
    "Standby",
    "Negative",
    "Affirm",
    "That's affirm",
    "Received",
    "I copy",
    "Roger",
  ]) {
    assert.ok(phrases.has(required), `precache must include ${JSON.stringify(required)}`);
  }
});

test("buildPrecachePhraseList: includes per-unit Copy + plate-pending (913) + standby variants", () => {
  // The dispatcher addresses individual units a lot. Pin one representative
  // unit's full set so a refactor that dropped the per-unit loop is caught.
  const phrases = new Set(buildPrecachePhraseList());
  assert.ok(phrases.has("Copy 352"), 'must precache "Copy 352"');
  assert.ok(phrases.has("352, 913"), 'must precache the 913 plate-pending ack');
  assert.ok(phrases.has("Affirm 352, 10-2"));
  assert.ok(phrases.has("Affirm, you're 10-2"));
  assert.ok(phrases.has("Copy 352, 10-8"));
  assert.ok(phrases.has("Copy 352, 10-7"));
  assert.ok(phrases.has("Copy 352, 10-23"));
  assert.ok(phrases.has("Copy 352, 10-97"));
  assert.ok(phrases.has("Copy 352, 10-98"));
  assert.ok(phrases.has("Copy 352, 10-19"));
  assert.ok(phrases.has("Copy 352, code 4"));
  assert.ok(phrases.has("352, copy. Standby."));
});

test("buildPrecachePhraseList: includes command-tier (27-xxx) standby variants", () => {
  // Command staff use the 27-000 / 27-010 / 27-020 / 27-030 callsigns;
  // pin one to catch a refactor that dropped the command-unit loop.
  const phrases = new Set(buildPrecachePhraseList());
  assert.ok(phrases.has("27-000, copy. Standby."));
  assert.ok(phrases.has("27-010, copy. Standby."));
});

test("buildPrecachePhraseList: every phrase has a stable normaliser key (round-trip safe)", () => {
  // The contract that ties this file together: every seeded phrase
  // becomes the cache key via `normalizeForTtsPrecache`. The runtime
  // lookup must hit on the exact same key. Walk the list and confirm
  // that the normaliser produces a non-empty, idempotent key for every
  // seeded phrase — a regression that produced an empty key (e.g. a
  // phrase that was all-punctuation, or that the normaliser collapsed
  // wholesale) would silently exclude it from the warmed cache.
  for (const p of buildPrecachePhraseList()) {
    const key = normalizeForTtsPrecache(p);
    assert.ok(key.length > 0, `phrase ${JSON.stringify(p)} normalises to empty key`);
    assert.equal(
      normalizeForTtsPrecache(key),
      key,
      `phrase ${JSON.stringify(p)} key is not idempotent`,
    );
  }
});
