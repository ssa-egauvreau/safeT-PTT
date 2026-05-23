/**
 * Tests for `server/src/aiDispatch/speech/numbers.ts`.
 *
 * These helpers shape what dispatchers actually hear on the air (account codes,
 * unit numbers, two-digit reads). The TTS layer assumes precise outputs — a
 * regression here makes the AI dispatcher mis-pronounce SSA account codes
 * (the 4-digit "thirty-twenty-eight" form is the radio-traffic standard).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accountCodeDashForm,
  accountCodeLocnotesForm,
  digitWord,
  numberToWords,
  spokenAccountCode,
  twoDigitSpoken,
} from "../../../src/aiDispatch/speech/numbers.js";

test("digitWord maps 0..9 to one word each", () => {
  assert.equal(digitWord(0), "zero");
  assert.equal(digitWord(1), "one");
  assert.equal(digitWord(7), "seven");
  assert.equal(digitWord(9), "nine");
});

test("numberToWords handles 0..99 (special-casing teens and round tens)", () => {
  assert.equal(numberToWords(0), "zero");
  assert.equal(numberToWords(9), "nine");
  assert.equal(numberToWords(10), "ten");
  assert.equal(numberToWords(13), "thirteen");
  assert.equal(numberToWords(19), "nineteen");
  assert.equal(numberToWords(20), "twenty");
  assert.equal(numberToWords(21), "twenty-one");
  assert.equal(numberToWords(42), "forty-two");
  assert.equal(numberToWords(99), "ninety-nine");
});

test("numberToWords falls through to plain digits outside 0..99", () => {
  assert.equal(numberToWords(-1), "-1");
  assert.equal(numberToWords(100), "100");
});

test("twoDigitSpoken matches numberToWords on the 0..99 range", () => {
  for (const n of [0, 5, 10, 11, 20, 25, 30, 99]) {
    assert.equal(twoDigitSpoken(n), numberToWords(n));
  }
});

test("spokenAccountCode reads four-digit SSA codes radio-style", () => {
  // 1805 → "eighteen-oh-five" (tens < 10 in the back half → "oh-N").
  assert.equal(spokenAccountCode("1805"), "eighteen-oh-five");
  // 3127 → "thirty-one-twenty-seven" (tens >= 10 → two-digit-spoken, joined by `-`).
  assert.equal(spokenAccountCode("3127"), "thirty-one-twenty-seven");
  // Multiple-of-100 ends with "hundred" rather than "oh-zero".
  assert.equal(spokenAccountCode("1800"), "eighteen hundred");
  assert.equal(spokenAccountCode("3200"), "thirty-two hundred");
});

test("spokenAccountCode tolerates dash/format noise (e.g. '32-08')", () => {
  assert.equal(spokenAccountCode("32-08"), "thirty-two-oh-eight");
  assert.equal(spokenAccountCode("18-05"), "eighteen-oh-five");
});

test("spokenAccountCode handles 3-digit codes", () => {
  // 3-digit: first digit "<digit>-oh-<digit>" when the tail < 10, otherwise
  // "<digit> <two-digit>".
  assert.equal(spokenAccountCode("305"), "three-oh-five");
  assert.equal(spokenAccountCode("325"), "three twenty-five");
});

test("spokenAccountCode returns '' for null/undefined/empty/non-digit", () => {
  assert.equal(spokenAccountCode(null), "");
  assert.equal(spokenAccountCode(undefined), "");
  assert.equal(spokenAccountCode(""), "");
  assert.equal(spokenAccountCode("abc"), "");
});

test("spokenAccountCode falls back to digit-by-digit for >4 digit codes", () => {
  assert.equal(spokenAccountCode("12345"), "one two three four five");
});

test("accountCodeDashForm formats 4-digit codes as XX-YY for display", () => {
  assert.equal(accountCodeDashForm("3208"), "32-08");
  assert.equal(accountCodeDashForm("1805"), "18-05");
});

test("accountCodeDashForm leaves non-4-digit codes unchanged after stripping non-digits", () => {
  assert.equal(accountCodeDashForm("123"), "123");
  assert.equal(accountCodeDashForm("12345"), "12345");
  assert.equal(accountCodeDashForm(""), "");
});

test("accountCodeLocnotesForm strips non-digits — 10-8 locnotes must never contain a dash", () => {
  // The 10-8 locnotes string is "<digits-only> <name>" — a dash in the prefix
  // makes the property number unsearchable in the 10-8 UI.
  assert.equal(accountCodeLocnotesForm("32-08"), "3208");
  assert.equal(accountCodeLocnotesForm("32-08 Anaheim Plaza"), "3208");
  assert.equal(accountCodeLocnotesForm(""), "");
});
