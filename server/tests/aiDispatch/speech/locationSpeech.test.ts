/**
 * Tests for `server/src/aiDispatch/speech/locationSpeech.ts`.
 *
 * `prepareLocationForTts` is the thin glue that runs `expandUSStatesForSpeech`
 * first (so addresses' trailing ", CA" → ", California" before the street
 * formatter sees them) and then hands the result to `spokenizeAddress`.
 *
 * The unit tests for the two underlying helpers cover the heavy lifting; this
 * file pins the contract of the wrapper itself:
 *   - empty / null / undefined are returned as-is without crashing the
 *     dispatch engine,
 *   - all-whitespace input is preserved (the inner formatter is only invoked
 *     when there's an actual non-blank string),
 *   - state expansion runs BEFORE the address number-to-words pass — a
 *     regression that flipped the order would lose state expansion because
 *     spokenizeAddress alone strips ZIP+state into ", California" using its
 *     own table, but the state-name handoff to TTS would be silently fragile.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareLocationForTts } from "../../../src/aiDispatch/speech/locationSpeech.js";

test("prepareLocationForTts: null returns ''", () => {
  assert.equal(prepareLocationForTts(null), "");
});

test("prepareLocationForTts: undefined returns ''", () => {
  assert.equal(prepareLocationForTts(undefined), "");
});

test("prepareLocationForTts: empty string returns ''", () => {
  assert.equal(prepareLocationForTts(""), "");
});

test("prepareLocationForTts: all-whitespace input is preserved (formatter not invoked)", () => {
  // `.trim()` is falsy → early return. A regression that runs the formatter
  // on whitespace would emit something different (likely "").
  assert.equal(prepareLocationForTts("   "), "   ");
});

test("prepareLocationForTts: full integration → ZIP stripped, state expanded, numbers spoken", () => {
  // End-to-end pin — both expandUSStatesForSpeech and spokenizeAddress run.
  assert.equal(
    prepareLocationForTts("1805 Main St, Anaheim, CA 92805"),
    "eighteen oh five Main Street, Anaheim, California",
  );
});

test("prepareLocationForTts: trims outer whitespace before formatting", () => {
  assert.equal(
    prepareLocationForTts("  500 W Disney Way, Anaheim, CA  "),
    "five hundred West Disney Way, Anaheim, California",
  );
});
