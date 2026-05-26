/**
 * Tests for `server/src/aiDispatch/speech/callTypeSpoken.ts`.
 *
 * This module is mostly a data table the dispatcher uses to substitute SSA
 * call-type tokens with their on-air phrasing before TTS. It's pure data, but
 * a few invariants matter for correctness on the air:
 *
 *   1. `callTypeSpokenKeysByLength()` returns the keys in DESCENDING length
 *      order. The substitution pass walks the keys in order and replaces the
 *      first match, so a regression that flips this to ascending order would
 *      let "925" match before "925v" and the dispatcher would say "nine
 *      twenty-five" for what was actually a suspicious-vehicle call.
 *
 *   2. Every entry in `CALL_TYPE_LOWERCASE_ONLY` must also exist in
 *      `CALL_TYPE_SPOKEN`. The downstream replacer only consults the main
 *      table for substitutions; a member of the lowercase-only set with no
 *      backing entry would be silently unmatchable.
 *
 *   3. The lowercase-only set contains the tokens that collide with English
 *      words or state abbreviations ("ca", "pc", "ped", ...). Locking the set
 *      members ensures a careless add doesn't put "187" into it (which would
 *      stop matching "187 murder" on the air).
 *
 *   4. Pin a handful of high-traffic spoken phrasings so a wording change to
 *      the radio script is loud, not silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALL_TYPE_SPOKEN,
  CALL_TYPE_LOWERCASE_ONLY,
  callTypeSpokenKeysByLength,
} from "../../../src/aiDispatch/speech/callTypeSpoken.js";

test("callTypeSpokenKeysByLength: returns keys longest-first", () => {
  const keys = callTypeSpokenKeysByLength();
  for (let i = 1; i < keys.length; i++) {
    assert.ok(
      keys[i - 1]!.length >= keys[i]!.length,
      `out of order at ${i}: ${keys[i - 1]} (${keys[i - 1]!.length}) < ${keys[i]} (${keys[i]!.length})`,
    );
  }
});

test("callTypeSpokenKeysByLength: '925v' is ordered before '925' (suffix tokens win)", () => {
  // The whole point of the longest-first ordering — locks the substitution
  // contract that "suspicious vehicle" beats plain "suspicious person" when
  // both prefixes are present in the dispatcher transcript.
  const keys = callTypeSpokenKeysByLength();
  const longer = keys.indexOf("925v");
  const shorter = keys.indexOf("925");
  assert.notEqual(longer, -1, "925v must be present");
  assert.notEqual(shorter, -1, "925 must be present");
  assert.ok(longer < shorter, `925v (idx=${longer}) must come before 925 (idx=${shorter})`);
});

test("callTypeSpokenKeysByLength: every 4-char key comes before every 3-char key", () => {
  // Confidence check on the global ordering at the boundary that matters
  // (most suffix-vs-base collisions happen between length 3 and 4).
  const keys = callTypeSpokenKeysByLength();
  const lastFour = keys.findIndex((k) => k.length < 4);
  if (lastFour === -1) {
    return; // table is all >=4 chars, nothing to check
  }
  for (let i = 0; i < lastFour; i++) {
    assert.ok(
      keys[i]!.length >= 4,
      `key ${keys[i]} before first <4 should be length>=4`,
    );
  }
  for (let i = lastFour; i < keys.length; i++) {
    assert.ok(
      keys[i]!.length < 4,
      `key ${keys[i]} after first <4 should be length<4`,
    );
  }
});

test("callTypeSpokenKeysByLength: returns one entry per key in CALL_TYPE_SPOKEN", () => {
  const keys = callTypeSpokenKeysByLength();
  assert.equal(keys.length, Object.keys(CALL_TYPE_SPOKEN).length);
  assert.equal(new Set(keys).size, keys.length, "no duplicates");
});

test("CALL_TYPE_LOWERCASE_ONLY: every member also exists in CALL_TYPE_SPOKEN", () => {
  // The lowercase-only set is a filter applied to CALL_TYPE_SPOKEN matches —
  // a member not in the main table is unreachable. Locks the table↔set
  // invariant so additions stay coherent.
  for (const k of CALL_TYPE_LOWERCASE_ONLY) {
    assert.ok(k in CALL_TYPE_SPOKEN, `${k} missing from CALL_TYPE_SPOKEN`);
  }
});

test("CALL_TYPE_LOWERCASE_ONLY: pins the documented set of collision-prone tokens", () => {
  // These collide with state abbreviations ("ca"/"pc") or common English
  // words ("ped"/"prop"/"fu"/"mi"). A regression that adds e.g. "187" here
  // would stop the dispatcher matching "187" in transcripts at all.
  const expected = new Set(["ca", "c5", "c6", "c7", "fu", "mi", "pc", "ped", "prop"]);
  assert.equal(CALL_TYPE_LOWERCASE_ONLY.size, expected.size);
  for (const k of expected) {
    assert.ok(CALL_TYPE_LOWERCASE_ONLY.has(k), `${k} missing from lowercase-only set`);
  }
});

test("CALL_TYPE_SPOKEN: pins high-traffic phrasings (regression-loud)", () => {
  // Sample the table at the codes officers hear most often. A bad merge that
  // re-words one of these would otherwise pass code review unnoticed.
  assert.equal(CALL_TYPE_SPOKEN["187"], "one eighty-seven, murder");
  assert.equal(CALL_TYPE_SPOKEN["211"], "two eleven, robbery");
  assert.equal(CALL_TYPE_SPOKEN["415"], "four fifteen, disturbing the peace");
  assert.equal(CALL_TYPE_SPOKEN["459"], "four fifty-nine, burglary in progress");
  assert.equal(CALL_TYPE_SPOKEN["961"], "nine sixty-one, car stop");
  assert.equal(CALL_TYPE_SPOKEN.ped, "pedestrian stop");
  assert.equal(CALL_TYPE_SPOKEN.ca, "citizen assist");
});

test("CALL_TYPE_SPOKEN: every value is a non-empty string", () => {
  for (const [k, v] of Object.entries(CALL_TYPE_SPOKEN)) {
    assert.equal(typeof v, "string", k);
    assert.ok(v.length > 0, `${k} → empty phrasing`);
  }
});
