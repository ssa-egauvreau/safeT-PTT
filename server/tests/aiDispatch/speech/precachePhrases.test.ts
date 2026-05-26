/**
 * Regression tests for `server/src/aiDispatch/speech/precachePhrases.ts`.
 *
 * The TTS precache is a flat list of short utterances (acks, "copy 351,
 * 10-7", "standby", etc.) that are pre-rendered through ElevenLabs at
 * agency boot and on every sounds-version bump. The cache lookup uses
 * `normalizeForTtsPrecache(text)` as the key, so any drift between the
 * synthesis-time normalization and the runtime normalization invalidates
 * the cache — every "Copy 351, 10-4" then pays an ElevenLabs round-trip
 * instead of resolving from the local Buffer cache.
 *
 * What these tests pin:
 *
 *  1. `buildPrecachePhraseList` emits a deduplicated, non-empty list with
 *     the canonical short acks ("Copy", "Standby", "Negative", etc.) and
 *     per-radio-unit lines (`Copy 351`, `351, 913`, etc.). Drop-out of
 *     any of these means the most-spoken AI dispatcher lines stop being
 *     precached and run live every time.
 *
 *  2. `normalizeForTtsPrecache` produces a stable cache key for the
 *     "same line, casing/punctuation/whitespace varies" cases the engine
 *     actually emits: trailing punctuation collapse, multi-space collapse,
 *     case fold, and trim. A regression in any of these silently misses
 *     the cache.
 *
 * Both functions are pure and tested directly — no environment, no DB,
 * no fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrecachePhraseList,
  normalizeForTtsPrecache,
} from "../../../src/aiDispatch/speech/precachePhrases.js";

// ---------- buildPrecachePhraseList ---------------------------------------

test("buildPrecachePhraseList: returns a non-empty deduplicated list", () => {
  const phrases = buildPrecachePhraseList();
  assert.ok(phrases.length > 0);
  assert.equal(new Set(phrases).size, phrases.length, "phrases should be unique");
});

test("buildPrecachePhraseList: includes the canonical short acks", () => {
  const phrases = new Set(buildPrecachePhraseList());
  // These are the most-spoken radio replies; they MUST be in the precache
  // or every dispatcher response pays an ElevenLabs round-trip.
  for (const ack of [
    "Copy",
    "10-4",
    "Standby",
    "Negative",
    "Affirm",
    "That's affirm",
    "Received",
    "I copy",
    "Roger",
    "Copy. Standby.",
  ]) {
    assert.ok(phrases.has(ack), `missing canonical ack: "${ack}"`);
  }
});

test("buildPrecachePhraseList: includes per-radio-unit standby acks for each known unit", () => {
  const phrases = new Set(buildPrecachePhraseList());
  // Sample of the radio-unit list embedded in the source. If the unit
  // roster changes, this test will fail loudly so a developer notices
  // that the precache is now skipping the new unit.
  for (const unit of ["151", "231", "334", "351", "352", "401", "402", "403"]) {
    assert.ok(phrases.has(`Copy ${unit}`), `missing "Copy ${unit}"`);
    assert.ok(phrases.has(`${unit}, 913`), `missing "${unit}, 913"`);
    assert.ok(phrases.has(`${unit}, copy. Standby.`), `missing "${unit}, copy. Standby."`);
    assert.ok(phrases.has(`Affirm ${unit}, 10-2`), `missing "Affirm ${unit}, 10-2"`);
    assert.ok(phrases.has(`Copy ${unit}, 10-8`), `missing "Copy ${unit}, 10-8"`);
    assert.ok(phrases.has(`Copy ${unit}, code 4`), `missing "Copy ${unit}, code 4"`);
  }
});

test("buildPrecachePhraseList: includes command-unit standby acks", () => {
  const phrases = new Set(buildPrecachePhraseList());
  for (const unit of ["27-000", "27-010", "27-020", "27-030"]) {
    assert.ok(phrases.has(`${unit}, copy. Standby.`), `missing "${unit}, copy. Standby."`);
  }
});

test("buildPrecachePhraseList: every phrase is non-empty after trim", () => {
  // A regression that interpolated an empty unit string would push blank
  // entries into the cache, which then silently match every empty input.
  for (const phrase of buildPrecachePhraseList()) {
    assert.ok(phrase.trim().length > 0, `empty/whitespace phrase: ${JSON.stringify(phrase)}`);
  }
});

// ---------- normalizeForTtsPrecache ---------------------------------------

test("normalizeForTtsPrecache: trims surrounding whitespace", () => {
  assert.equal(normalizeForTtsPrecache("  Copy  "), "copy");
  assert.equal(normalizeForTtsPrecache("\tStandby\n"), "standby");
});

test("normalizeForTtsPrecache: collapses internal whitespace runs to a single space", () => {
  // The engine sometimes interpolates extra spaces between unit and code.
  // Without this collapse, "Copy  351" misses a cache entry keyed on
  // "Copy 351", forcing a live ElevenLabs call for the same audio.
  assert.equal(normalizeForTtsPrecache("Copy   351,   10-4"), "copy 351, 10-4");
  assert.equal(normalizeForTtsPrecache("Copy\t351\t10-4"), "copy 351 10-4");
});

test("normalizeForTtsPrecache: strips trailing terminal punctuation", () => {
  // "Copy.", "Copy!", and "Copy" must hash to the same key — the LLM
  // picks punctuation inconsistently, but the rendered audio is the same.
  assert.equal(normalizeForTtsPrecache("Copy."), "copy");
  assert.equal(normalizeForTtsPrecache("Copy!"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy?"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy!!!"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy.!?"), "copy");
});

test("normalizeForTtsPrecache: lowercases for case-insensitive lookup", () => {
  assert.equal(normalizeForTtsPrecache("COPY"), "copy");
  assert.equal(normalizeForTtsPrecache("CoPy"), "copy");
  assert.equal(normalizeForTtsPrecache("STANDBY"), "standby");
});

test("normalizeForTtsPrecache: same key for typical equivalent inputs", () => {
  // Pin the rule that all of these must collide on the cache. Each pair
  // is a known emission shape from the engine for the same audio.
  const cases: [string, string][] = [
    ["Copy 351, 10-4.", "  copy   351,  10-4  "],
    ["Standby.", "STANDBY"],
    ["Copy. Standby.", "Copy. Standby"],
    ["27-010, copy. Standby.", "27-010, COPY. standby."],
  ];
  for (const [a, b] of cases) {
    assert.equal(
      normalizeForTtsPrecache(a),
      normalizeForTtsPrecache(b),
      `expected same cache key for ${JSON.stringify(a)} and ${JSON.stringify(b)}`,
    );
  }
});

test("normalizeForTtsPrecache: preserves internal punctuation that affects audio", () => {
  // Hyphens, commas, and digits drive ElevenLabs prosody and must not be
  // collapsed away — that would turn "10-4" and "104" into the same key.
  assert.equal(normalizeForTtsPrecache("10-4"), "10-4");
  assert.equal(normalizeForTtsPrecache("351, 913"), "351, 913");
  assert.notEqual(normalizeForTtsPrecache("10-4"), normalizeForTtsPrecache("104"));
});

test("normalizeForTtsPrecache: tolerates non-string-ish input via String() coercion", () => {
  // The runtime call sites occasionally pass numbers (account codes) or
  // null after a guard. Coercion via String() is the documented fallback;
  // pin the contract so a future refactor doesn't crash on the boundary.
  // @ts-expect-error — exercising the runtime coercion path explicitly.
  assert.equal(normalizeForTtsPrecache(351), "351");
  // @ts-expect-error — exercising the runtime coercion path explicitly.
  assert.equal(normalizeForTtsPrecache(null), "null");
});

test("normalizeForTtsPrecache: idempotent (normalize(normalize(x)) === normalize(x))", () => {
  // Idempotency is what lets the cache key be re-normalized on the
  // lookup side without drifting from the synthesis-time key.
  for (const raw of ["Copy.", "  Standby!  ", "27-010, COPY. STANDBY.", "10-4."]) {
    const once = normalizeForTtsPrecache(raw);
    assert.equal(normalizeForTtsPrecache(once), once);
  }
});
