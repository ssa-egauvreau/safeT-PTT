/**
 * Tests for `server/src/aiDispatch/speech/phoneSpeech.ts`.
 *
 * Spoken phone numbers feed ElevenLabs TTS. If the digit groups regress, the
 * AI dispatcher reads phone numbers as a single long number ("seven hundred
 * fourteen million...") instead of "7 1 4, 5 5 5, 1 2 3 4", which is unusable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPhoneForTts } from "../../../src/aiDispatch/speech/phoneSpeech.js";

test("formatPhoneForTts: 10-digit US phone → 'AAA, BBB, CCCC' digit-by-digit", () => {
  assert.equal(formatPhoneForTts("7145551234"), "7 1 4, 5 5 5, 1 2 3 4");
});

test("formatPhoneForTts: 11-digit US phone with leading 1 strips the country code", () => {
  assert.equal(formatPhoneForTts("17145551234"), "7 1 4, 5 5 5, 1 2 3 4");
});

test("formatPhoneForTts: dashed/parenthesized input is normalized to digits first", () => {
  assert.equal(formatPhoneForTts("(714) 555-1234"), "7 1 4, 5 5 5, 1 2 3 4");
  assert.equal(formatPhoneForTts("714-555-1234"), "7 1 4, 5 5 5, 1 2 3 4");
  assert.equal(formatPhoneForTts("714.555.1234"), "7 1 4, 5 5 5, 1 2 3 4");
  assert.equal(formatPhoneForTts("+1 714 555 1234"), "7 1 4, 5 5 5, 1 2 3 4");
});

test("formatPhoneForTts: 7-digit local phone → 'BBB, CCCC' without area code", () => {
  assert.equal(formatPhoneForTts("5551234"), "5 5 5, 1 2 3 4");
});

test("formatPhoneForTts: empty/null/undefined returns ''", () => {
  assert.equal(formatPhoneForTts(null), "");
  assert.equal(formatPhoneForTts(undefined), "");
  assert.equal(formatPhoneForTts(""), "");
  assert.equal(formatPhoneForTts("no digits at all"), "");
});

test("formatPhoneForTts: oddly-sized inputs fall through to plain digit groups", () => {
  // Not 7, 10, or 11 — read each digit, no commas.
  assert.equal(formatPhoneForTts("12345"), "1 2 3 4 5");
});
