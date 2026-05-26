/**
 * Tests for `server/src/aiDispatch/speech/addressSpeech.ts`.
 *
 * `spokenizeAddress` is the last hop between structured CAD/location data and
 * what the AI dispatcher actually says on the air via ElevenLabs. A regression
 * here means officers and dispatchers hear malformed or wrong location info on
 * the radio — high blast radius, very hard to notice in code review.
 *
 * Specifically protected:
 *   - empty / null / undefined → "" (does not crash the TTS pipeline),
 *   - trailing ZIP and ", USA" / ", United States" are stripped (TTS would
 *     otherwise read the ZIP digit-by-digit and tack a useless country name on
 *     every address),
 *   - US state abbreviations after a comma are expanded ("CA" → "California");
 *     unknown abbreviations are left untouched so we don't invent state names,
 *   - directionals expand (N → "North", NE → "Northeast", …) only when they
 *     are standalone tokens followed by a space — "NorthMain" must not be
 *     touched, "S Main" must become "South Main",
 *   - the street-type table (St, Ave, Blvd, Rd, Dr, Ln, Ct, Pl, Pkwy, Hwy,
 *     Way, Ter, Cir, Apt, Ste, Bldg) expands case-insensitively and tolerates
 *     a trailing period,
 *   - number-to-words follows the four documented buckets:
 *       n<100        → numberToWords  ("99"   → "ninety-nine"),
 *       n<1000 tens=0→ "<hundreds> hundred",
 *       n<1000 tens<10→"<digit> oh <digit>"   (105   → "one oh five"),
 *       n<1000       → "<digit> <numberToWords(tens)>",
 *       n<10000 right=0→"<numberToWords> hundred",
 *       n<10000 right<10→"<numberToWords> oh <digit>" (1805 → "eighteen oh five"),
 *       n<10000      → "<numberToWords> <numberToWords>" (1234 → "twelve thirty-four"),
 *       n>=10000     → digit-by-digit ("12345" → "one two three four five").
 *
 * Lock all of those down explicitly so the next refactor of the formatter
 * can't silently change on-air speech.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { spokenizeAddress } from "../../../src/aiDispatch/speech/addressSpeech.js";

// ---------- empty / null guards -----------------------------------------

test("spokenizeAddress: empty / null / undefined → ''", () => {
  assert.equal(spokenizeAddress(null), "");
  assert.equal(spokenizeAddress(undefined), "");
  assert.equal(spokenizeAddress(""), "");
});

// ---------- ZIP / country tail stripping --------------------------------

test("spokenizeAddress: strips trailing 5-digit ZIP", () => {
  // The 5-digit zip at the end of the address would otherwise be read by TTS
  // as five separate digits ("nine two eight oh five") which is noise.
  assert.equal(
    spokenizeAddress("1805 Main St, Anaheim, CA 92805"),
    "eighteen oh five Main Street, Anaheim, California",
  );
});

test("spokenizeAddress: strips trailing ZIP+4", () => {
  assert.equal(
    spokenizeAddress("1805 Main St, Anaheim, CA 92805-1234"),
    "eighteen oh five Main Street, Anaheim, California",
  );
});

test("spokenizeAddress: strips ', USA' and ', United States' country tail", () => {
  assert.equal(
    spokenizeAddress("12345 Disney Way, Anaheim, CA, USA"),
    "one two three four five Disney Way, Anaheim, California",
  );
  assert.equal(
    spokenizeAddress("12345 Disney Way, Anaheim, CA, United States"),
    "one two three four five Disney Way, Anaheim, California",
  );
});

// ---------- state expansion ---------------------------------------------

test("spokenizeAddress: expands US state abbreviation in the ', CA <ZIP>' tail", () => {
  // The ZIP regex anchors the state lookup. NY → "New York" verifies a
  // multi-word state name as well.
  assert.equal(
    spokenizeAddress("1234 Main St, NY 10101"),
    "twelve thirty-four Main Street, New York",
  );
});

test("spokenizeAddress: expands trailing ', CA' with no ZIP", () => {
  assert.equal(
    spokenizeAddress("500 SW Disney Way, Anaheim, CA"),
    "five hundred Southwest Disney Way, Anaheim, California",
  );
});

test("spokenizeAddress: unknown 2-letter abbreviation is left intact (no fabricated states)", () => {
  // "ZZ" is not a real state — we must NOT invent one. Important so the AI
  // doesn't confidently speak the wrong state on the air.
  assert.equal(
    spokenizeAddress("1234 Main St, ZZ 10101"),
    "twelve thirty-four Main Street, ZZ",
  );
});

// ---------- directionals -------------------------------------------------

test("spokenizeAddress: single-letter directionals (N/S/E/W) expand only as standalone tokens", () => {
  assert.equal(spokenizeAddress("S Main St"), "South Main Street");
  // Lowercase variant must still expand (the regex is /gi).
  assert.equal(spokenizeAddress("s Main St"), "South Main Street");
  // "NorthMain" must NOT be touched — there's no word boundary + space match.
  assert.equal(spokenizeAddress("NorthMain"), "NorthMain");
});

test("spokenizeAddress: two-letter directionals (NE/NW/SE/SW) expand to compass words", () => {
  assert.equal(spokenizeAddress("500 NE Foo Ave"), "five hundred Northeast Foo Avenue");
  assert.equal(spokenizeAddress("500 NW Foo Ave"), "five hundred Northwest Foo Avenue");
  assert.equal(spokenizeAddress("500 SE Foo Ave"), "five hundred Southeast Foo Avenue");
  assert.equal(spokenizeAddress("500 SW Foo Ave"), "five hundred Southwest Foo Avenue");
});

// ---------- street types -------------------------------------------------

test("spokenizeAddress: expands the full street-type table (case insensitive, optional period)", () => {
  // Locks the documented table from the source: a regression that drops one
  // of these mappings is otherwise silent until somebody hears it on a radio.
  const cases: Array<[string, string]> = [
    ["100 Main St", "one hundred Main Street"],
    ["100 Main St.", "one hundred Main Street."],
    ["100 Main Ave", "one hundred Main Avenue"],
    ["100 Main Ave.", "one hundred Main Avenue."],
    ["100 Main Blvd", "one hundred Main Boulevard"],
    ["100 Main Blvd.", "one hundred Main Boulevard."],
    ["100 Main Rd", "one hundred Main Road"],
    ["100 Main Dr", "one hundred Main Drive"],
    ["100 Main Ln", "one hundred Main Lane"],
    ["100 Main Ct", "one hundred Main Court"],
    ["100 Main Pl", "one hundred Main Place"],
    ["100 Main Pkwy", "one hundred Main Parkway"],
    ["100 Main Hwy", "one hundred Main Highway"],
    ["100 Main Way", "one hundred Main Way"],
    ["100 Main Ter", "one hundred Main Terrace"],
    ["100 Main Cir", "one hundred Main Circle"],
    // Sub-address tokens are also expanded.
    ["100 Main St Apt 3", "one hundred Main Street Apartment three"],
    ["100 Main St Ste 3", "one hundred Main Street Suite three"],
    ["100 Main St Bldg 3", "one hundred Main Street Building three"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(spokenizeAddress(input), expected, input);
  }
});

test("spokenizeAddress: street-type expansion is case-insensitive on the input", () => {
  // The street word is preserved verbatim (lowercase 'disney' stays
  // lowercase) but 'rd.' is converted to 'Road'.
  assert.equal(
    spokenizeAddress("500 disney rd."),
    "five hundred disney Road.",
  );
});

// ---------- number-to-words branches ------------------------------------

test("spokenizeAddress numbers: 0..99 use numberToWords()", () => {
  // Covers each of the small-number sub-branches.
  assert.equal(spokenizeAddress("0 Main St"), "zero Main Street");
  assert.equal(spokenizeAddress("1 Main St"), "one Main Street");
  assert.equal(spokenizeAddress("7 Main St"), "seven Main Street");
  assert.equal(spokenizeAddress("11 Main St"), "eleven Main Street");
  assert.equal(spokenizeAddress("20 Main St"), "twenty Main Street");
  assert.equal(spokenizeAddress("21 Main St"), "twenty-one Main Street");
  assert.equal(spokenizeAddress("99 Main St"), "ninety-nine Main Street");
});

test("spokenizeAddress numbers: 100..999 trailing zero → '<digit> hundred'", () => {
  assert.equal(spokenizeAddress("100 Main St"), "one hundred Main Street");
  assert.equal(spokenizeAddress("500 Main St"), "five hundred Main Street");
});

test("spokenizeAddress numbers: 100..999 with tens<10 use 'oh' connector", () => {
  // 105 → "one oh five" (radio convention, not "one hundred five").
  assert.equal(spokenizeAddress("105 Main St"), "one oh five Main Street");
});

test("spokenizeAddress numbers: 1000..9999 with right pair zero → '<words> hundred'", () => {
  assert.equal(spokenizeAddress("1000 Main St"), "ten hundred Main Street");
});

test("spokenizeAddress numbers: 1000..9999 with right pair <10 use 'oh' connector", () => {
  // SSA radio convention: 1805 Disney is "eighteen oh five Disney".
  assert.equal(spokenizeAddress("1805 Main St"), "eighteen oh five Main Street");
});

test("spokenizeAddress numbers: 1000..9999 with both pairs present → '<words> <words>'", () => {
  assert.equal(spokenizeAddress("1234 Main St"), "twelve thirty-four Main Street");
});

test("spokenizeAddress numbers: >=10000 fall through to digit-by-digit", () => {
  // Five-digit street numbers are uncommon; rendering digit-by-digit avoids
  // generating "twelve thousand three hundred forty-five" which would not
  // sound right on a dispatch radio.
  assert.equal(
    spokenizeAddress("12345 Main St"),
    "one two three four five Main Street",
  );
  assert.equal(
    spokenizeAddress("10005 Main St"),
    "one zero zero zero five Main Street",
  );
});

// ---------- whitespace / trailing comma cleanup -------------------------

test("spokenizeAddress: collapses 2+ spaces and strips trailing comma", () => {
  // After ZIP and ", USA" stripping the input can have a dangling comma /
  // double space — the cleanup at the end of the formatter must handle it.
  assert.equal(
    spokenizeAddress("500  Disney  Way,   Anaheim, CA, USA"),
    "five hundred Disney Way, Anaheim, California",
  );
});
