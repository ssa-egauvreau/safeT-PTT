/**
 * Tests for `server/src/aiDispatch/speech/precachePhrases.ts`.
 *
 * The precache list is the one place the TTS layer can pre-warm ElevenLabs
 * audio for every short readback the AI dispatcher will ever say to the
 * field. The TTS cost for an uncached phrase is real money per character and
 * blocks the dispatch ack until ElevenLabs responds — a regression that
 * narrows the list (or drops the canonical "Copy <unit>" prefix) means:
 *
 *   - Every "Copy 040, 10-8" style ack hits a cold ElevenLabs round-trip on
 *     the air, adding ~600 ms of perceived dispatcher silence.
 *   - The agency's monthly ElevenLabs character quota burns down faster
 *     because cached phrases stop being deduplicated.
 *
 * A regression that *adds* duplicates costs nothing functionally but
 * inflates the precache warm-up time on cold start; we pin uniqueness here
 * so the Set semantics inside the builder stays intentional.
 *
 * `normalizeForTtsPrecache` is the lookup key for every cache read — its
 * fold rules (trim, collapse whitespace, strip trailing punctuation, lower)
 * must stay aligned with the keys the builder emits, otherwise the cache
 * misses on the exact phrases it tried to warm.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrecachePhraseList,
  normalizeForTtsPrecache,
} from "../../../src/aiDispatch/speech/precachePhrases.js";

const RADIO_UNITS = ["151", "231", "334", "351", "352", "401", "402", "403"];
const COMMAND_UNITS = ["27-000", "27-010", "27-020", "27-030"];

test("buildPrecachePhraseList: emits a non-empty list with no duplicate entries", () => {
  // The builder uses a Set internally; the public contract is that the
  // returned array reflects that uniqueness so callers can iterate it once.
  const list = buildPrecachePhraseList();
  assert.ok(list.length > 0, "list must not be empty");
  assert.equal(new Set(list).size, list.length, "list must have no duplicates");
});

test("buildPrecachePhraseList: every entry is a non-empty trimmed string", () => {
  for (const phrase of buildPrecachePhraseList()) {
    assert.equal(typeof phrase, "string", `phrase ${JSON.stringify(phrase)} must be a string`);
    assert.ok(phrase.length > 0, `phrase ${JSON.stringify(phrase)} must not be empty`);
    assert.equal(
      phrase,
      phrase.trim(),
      `phrase ${JSON.stringify(phrase)} must not have leading/trailing whitespace`,
    );
  }
});

test("buildPrecachePhraseList: includes every canonical one-word ack", () => {
  // These are the SSA-standard short responses the AI dispatcher uses
  // when there isn't a unit number to attach. Dropping any of them shifts
  // a hot-path "Copy" / "10-4" through ElevenLabs every time.
  const list = new Set(buildPrecachePhraseList());
  for (const phrase of [
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
    assert.ok(list.has(phrase), `expected canonical ack "${phrase}" in precache list`);
  }
});

test("buildPrecachePhraseList: includes 'Copy <unit>' for every documented radio unit", () => {
  // The single highest-frequency ack on the air — once per dispatch, once
  // per traffic stop, once per status change. Cold-cached on any single
  // unit means every dispatch ack to that unit pays the ElevenLabs round-trip.
  const list = new Set(buildPrecachePhraseList());
  for (const unit of RADIO_UNITS) {
    assert.ok(list.has(`Copy ${unit}`), `expected "Copy ${unit}" in precache list`);
  }
});

test("buildPrecachePhraseList: includes the 913 traffic-stop ack for every radio unit", () => {
  // "<unit>, 913" — "I'll be 913 (out at a location)". One per traffic stop.
  const list = new Set(buildPrecachePhraseList());
  for (const unit of RADIO_UNITS) {
    assert.ok(list.has(`${unit}, 913`), `expected "${unit}, 913" in precache list`);
  }
});

test("buildPrecachePhraseList: includes the 10-2 readbacks for every radio unit", () => {
  // Two forms: explicit unit and generic "you're 10-2" — both are hot.
  const list = new Set(buildPrecachePhraseList());
  for (const unit of RADIO_UNITS) {
    assert.ok(list.has(`Affirm ${unit}, 10-2`), `expected "Affirm ${unit}, 10-2"`);
  }
  // The generic form must also be present (covers the "(no unit) you're 10-2" case).
  assert.ok(new Set(buildPrecachePhraseList()).has("Affirm, you're 10-2"));
});

test("buildPrecachePhraseList: includes every status-change ack pair (10-7/8/19/23/97/98 + code 4)", () => {
  // This is the entire 10-code surface the dispatcher acknowledges on a
  // routine status change. Adding a 10-code without seeding it means the
  // FIRST live use is a 600 ms cold start on the air, every time.
  const list = new Set(buildPrecachePhraseList());
  for (const unit of RADIO_UNITS) {
    for (const code of ["10-8", "10-7", "10-23", "10-97", "10-98", "10-19", "code 4"]) {
      assert.ok(
        list.has(`Copy ${unit}, ${code}`),
        `expected "Copy ${unit}, ${code}" in precache list`,
      );
    }
  }
});

test("buildPrecachePhraseList: 'standby' covers both bare and unit-prefixed forms", () => {
  const list = new Set(buildPrecachePhraseList());
  assert.ok(list.has("Copy. Standby."), "expected the bare 'Copy. Standby.'");
  for (const unit of RADIO_UNITS) {
    assert.ok(
      list.has(`${unit}, copy. Standby.`),
      `expected "${unit}, copy. Standby." for radio unit ${unit}`,
    );
  }
  for (const unit of COMMAND_UNITS) {
    assert.ok(
      list.has(`${unit}, copy. Standby.`),
      `expected "${unit}, copy. Standby." for command unit ${unit}`,
    );
  }
});

test("buildPrecachePhraseList: is deterministic across calls (a re-warm fetches the same set)", () => {
  // The startup precache loop calls this once per process; a future caller
  // (e.g. an admin "rewarm cache" button) calling it again must NOT race
  // against the live ack path by returning a different set.
  const a = buildPrecachePhraseList();
  const b = buildPrecachePhraseList();
  assert.deepEqual([...a].sort(), [...b].sort());
});

// ---- normalizeForTtsPrecache --------------------------------------------

test("normalizeForTtsPrecache: lower-cases, collapses whitespace, strips terminal punctuation", () => {
  // Pin the entire fold contract — the cache uses this as the key so
  // any drift between the writer and reader silently misses every lookup.
  assert.equal(normalizeForTtsPrecache("  Copy 040,  10-8.  "), "copy 040, 10-8");
  assert.equal(normalizeForTtsPrecache("STANDBY!"), "standby");
  assert.equal(normalizeForTtsPrecache("Affirm?"), "affirm");
  assert.equal(normalizeForTtsPrecache("Roger."), "roger");
});

test("normalizeForTtsPrecache: a canonical precache phrase round-trips through itself", () => {
  // Belt-and-braces: every phrase the builder emits, when normalized, must
  // remain non-empty and idempotent (normalising the result returns the
  // same key). Without this, a writer-vs-reader fold drift silently loses
  // every precached entry on every cold start.
  for (const phrase of buildPrecachePhraseList()) {
    const key = normalizeForTtsPrecache(phrase);
    assert.ok(key.length > 0, `phrase ${JSON.stringify(phrase)} normalized to empty key`);
    assert.equal(
      normalizeForTtsPrecache(key),
      key,
      `normalize is not idempotent for phrase ${JSON.stringify(phrase)}`,
    );
  }
});

test("normalizeForTtsPrecache: strips only TRAILING terminal punctuation, not interior", () => {
  // "10-4." → "10-4"; but "Copy 040, 10-8" must keep the comma since the
  // comma is an interior token (and the TTS pacing reads it as a pause).
  assert.equal(normalizeForTtsPrecache("10-4."), "10-4");
  assert.equal(normalizeForTtsPrecache("Copy 040, 10-8"), "copy 040, 10-8");
  assert.equal(normalizeForTtsPrecache("Copy 040, 10-8."), "copy 040, 10-8");
});

test("normalizeForTtsPrecache: collapses runs of any whitespace to a single space", () => {
  // Tabs and newlines can sneak in via copy-pasted admin text; the key
  // must look the same whether the source spelled the gap as "  ", "\t",
  // or "\n".
  assert.equal(normalizeForTtsPrecache("Copy\t040,\n10-8"), "copy 040, 10-8");
});

test("normalizeForTtsPrecache: coerces a non-string input to its String() form", () => {
  // The TTS pipeline passes through anything stringifiable. Numbers and
  // null/undefined coerce; the helper must not throw on those.
  assert.equal(normalizeForTtsPrecache(913 as unknown as string), "913");
  assert.equal(normalizeForTtsPrecache(null as unknown as string), "null");
  assert.equal(normalizeForTtsPrecache(undefined as unknown as string), "undefined");
});

test("normalizeForTtsPrecache: empty / whitespace-only input collapses to empty string", () => {
  assert.equal(normalizeForTtsPrecache(""), "");
  assert.equal(normalizeForTtsPrecache("   "), "");
  assert.equal(normalizeForTtsPrecache("\t\n  "), "");
});
