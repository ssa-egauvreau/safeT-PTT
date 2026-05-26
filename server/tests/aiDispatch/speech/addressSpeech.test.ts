/**
 * Tests for `server/src/aiDispatch/speech/addressSpeech.ts`,
 * `stateSpeech.ts`, and the `prepareLocationForTts` composition in
 * `locationSpeech.ts`.
 *
 * These helpers shape every street address the AI dispatcher reads on
 * the air via ElevenLabs — info_request "address" / "external_address"
 * answers, "the address is …" replies, unit-location 10-20 readbacks,
 * and the property-database lookup ("account 18-05 is …, at <street>"
 * line). A regression here is audible on every dispatch and is the
 * kind of bug officers pick up on immediately ("dispatch read the zip
 * code", "dispatch read 1805 as 'one thousand eight hundred five'").
 *
 * The pipeline is layered (state-expand → spokenize) and order-sensitive,
 * so the tests pin a handful of representative inputs through both the
 * individual functions and the public `prepareLocationForTts` entry point.
 *
 * Specifically protected:
 *   - State abbreviations (", CA") expand to full names BEFORE the address
 *     spokenizer runs, so a later call-type pass can't mis-read "CA" as
 *     "citizen assist".
 *   - "USA" / "United States" / trailing zip / trailing 2-letter state
 *     are stripped out of the spoken form so the dispatcher doesn't read
 *     "92701" or "USA" out loud.
 *   - 1-, 2-, 3-, 4-, and 5+ digit numbers all map to the documented
 *     spoken forms (numberToWords for <100; "X hundred"/"X oh Y"/"X Y"
 *     for 100-9999; digit-by-digit for ≥ 10000). The 4-digit "1805 → eighteen
 *     oh five" form is the SSA radio standard for street numbers and is the
 *     test case officers depend on most.
 *   - Single-letter directionals (N/S/E/W) and two-letter directionals
 *     (NE/NW/SE/SW) both expand correctly, with the two-letter pass
 *     running first so "NE 6th" doesn't get mis-read as "N E 6th".
 *   - Common street-type abbreviations (St / Ave / Blvd / Pkwy / Lane /
 *     Apt / Bldg) all expand to their full words.
 *   - prepareLocationForTts handles null / undefined / empty / whitespace
 *     inputs without crashing (info_request paths can pass any of these).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { spokenizeAddress } from "../../../src/aiDispatch/speech/addressSpeech.js";
import {
  US_STATE_SPOKEN,
  expandUSStatesForSpeech,
} from "../../../src/aiDispatch/speech/stateSpeech.js";
import { prepareLocationForTts } from "../../../src/aiDispatch/speech/locationSpeech.js";

// ---------- expandUSStatesForSpeech -------------------------------------

test("expandUSStatesForSpeech: ', CA' becomes ', California' (state-only at end)", () => {
  // The ", XX" pattern is what address strings actually carry. Used
  // before the address spokenizer specifically so a later call-type
  // pass can't read "CA" as "citizen assist".
  assert.equal(expandUSStatesForSpeech("Santa Ana, CA"), "Santa Ana, California");
});

test("expandUSStatesForSpeech: leaves the trailing zip in place (zip stripping is the address spokenizer's job)", () => {
  // The spokenizer strips zips later in the pipeline; this helper only
  // touches the state token. Pinning it here keeps the two helpers from
  // accidentally double-handling the zip.
  assert.equal(
    expandUSStatesForSpeech("Phoenix, AZ 85001"),
    "Phoenix, Arizona 85001",
  );
});

test("expandUSStatesForSpeech: only matches a comma-separated, all-caps two-letter token", () => {
  // "CA highway" with no comma must NOT be expanded — that's the same
  // string a dispatcher would speak as "C-A highway". And lowercase
  // "ny" must not match either (avoids false-positives on prose).
  assert.equal(expandUSStatesForSpeech("CA highway"), "CA highway");
  assert.equal(
    expandUSStatesForSpeech("123 Main, ny 10001"),
    "123 Main, ny 10001",
  );
  assert.equal(expandUSStatesForSpeech("Located in TX"), "Located in TX");
});

test("expandUSStatesForSpeech: unknown two-letter tokens pass through unchanged", () => {
  // A future state code we haven't added (or a non-state two-letter
  // token like ", XY") must not be silently rewritten. Locks in the
  // safety property: only the known map drives expansion.
  assert.equal(expandUSStatesForSpeech("Foo, ZZ"), "Foo, ZZ");
});

test("expandUSStatesForSpeech: expands every state on the map (smoke test for the key set)", () => {
  // Pins the table size — adding a state requires deliberately
  // updating the map. A regression that drops states (e.g. accidental
  // overwrite during merge) trips this immediately.
  for (const [abbr, spoken] of Object.entries(US_STATE_SPOKEN)) {
    assert.equal(
      expandUSStatesForSpeech(`Anytown, ${abbr}`),
      `Anytown, ${spoken}`,
      `state ${abbr}`,
    );
  }
});

test("expandUSStatesForSpeech: empty input returns empty (no crash on missing-address paths)", () => {
  assert.equal(expandUSStatesForSpeech(""), "");
});

// ---------- spokenizeAddress: housekeeping ------------------------------

test("spokenizeAddress: null / undefined / empty input returns ''", () => {
  // info_request lookups can hand the spokenizer a missing field; the
  // contract is that it must not crash and must produce a TTS-safe
  // empty string (an undefined would later serialize as "undefined" on
  // the air).
  assert.equal(spokenizeAddress(null), "");
  assert.equal(spokenizeAddress(undefined), "");
  assert.equal(spokenizeAddress(""), "");
});

test("spokenizeAddress: trims surrounding whitespace", () => {
  assert.equal(spokenizeAddress("  trim me  "), "trim me");
});

test("spokenizeAddress: drops trailing 'USA' / 'United States' tokens", () => {
  // Dispatcher should never read "USA" out loud — it's noise on a
  // domestic radio system.
  assert.equal(spokenizeAddress("1234 Main St, USA"), "twelve thirty-four Main Street");
  assert.equal(
    spokenizeAddress("1234 Main St, United States"),
    "twelve thirty-four Main Street",
  );
});

test("spokenizeAddress: strips a trailing 5-digit zip (and zip+4)", () => {
  // 92701 read aloud as a number ("ninety-two thousand seven hundred
  // and one") is wrong on every count — it isn't part of the spoken
  // address.
  assert.equal(
    spokenizeAddress("1234 Main St 92701"),
    "twelve thirty-four Main Street",
  );
  assert.equal(
    spokenizeAddress("1234 Main St 92701-4567"),
    "twelve thirty-four Main Street",
  );
});

test("spokenizeAddress: a state abbreviation immediately before a zip is replaced with the full name and the zip is dropped", () => {
  // ", CA 92614" → ", California". The spokenizer handles this via
  // its own ",\s*([A-Z]{2})\s+\d{5}" regex (independent of
  // expandUSStatesForSpeech) so a caller that hands raw addresses
  // straight in still gets a clean result.
  assert.equal(
    spokenizeAddress("1234 Main St, CA 92614"),
    "twelve thirty-four Main Street, California",
  );
});

test("spokenizeAddress: a trailing two-letter state with no zip is also expanded", () => {
  assert.equal(
    spokenizeAddress("123 Main St, NY"),
    "one twenty-three Main Street, New York",
  );
});

// ---------- spokenizeAddress: directionals ------------------------------

test("spokenizeAddress: single-letter directionals N/S/E/W expand to the full word", () => {
  assert.equal(
    spokenizeAddress("1805 N Main St"),
    "eighteen oh five North Main Street",
  );
  assert.equal(
    spokenizeAddress("100 W Lincoln Ave"),
    "one hundred West Lincoln Avenue",
  );
});

test("spokenizeAddress: two-letter directionals NE/NW/SE/SW expand correctly (no double-pass corruption)", () => {
  // The two-letter regex runs AFTER the single-letter one. If the
  // single-letter pass were ever reordered it would split "NE" into
  // "North E " which is exactly the kind of subtle bug that's hard to
  // spot in production audio.
  assert.equal(
    spokenizeAddress("1234 NE 6th St"),
    "twelve thirty-four Northeast 6th Street",
  );
  assert.equal(
    spokenizeAddress("1234 SW Park Blvd"),
    "twelve thirty-four Southwest Park Boulevard",
  );
});

// ---------- spokenizeAddress: street types ------------------------------

test("spokenizeAddress: every common street-type abbreviation expands", () => {
  // One representative input per abbreviation. If a single map row
  // ever drops, the regression manifests as TTS reading "Pkwy" or
  // "Bldg" letter-by-letter on the air.
  const cases: Array<[string, string]> = [
    ["100 Main St", "one hundred Main Street"],
    ["100 Main Ave", "one hundred Main Avenue"],
    ["100 Main Blvd", "one hundred Main Boulevard"],
    ["100 Main Rd", "one hundred Main Road"],
    ["100 Main Dr", "one hundred Main Drive"],
    ["27 Pine Lane", "twenty-seven Pine Lane"],
    ["100 Main Ct", "one hundred Main Court"],
    ["1200 Center Pl", "twelve hundred Center Place"],
    ["5 Oak Pkwy", "five Oak Parkway"],
    ["100 Foo Hwy", "one hundred Foo Highway"],
    ["100 Main Ter", "one hundred Main Terrace"],
    ["1009 Elm Cir", "ten oh nine Elm Circle"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(spokenizeAddress(input), expected, input);
  }
});

test("spokenizeAddress: 'Apt'/'Bldg'/'Ste' expand inside a comma-separated suite tail", () => {
  // Compose all three so a single regex regression is visible.
  assert.equal(
    spokenizeAddress("1010 Foo Bldg, Apt 5"),
    "ten ten Foo Building, Apartment five",
  );
});

// ---------- spokenizeAddress: numbers ----------------------------------

test("spokenizeAddress: <100 → numberToWords (one..ninety-nine)", () => {
  assert.equal(spokenizeAddress("27 Pine Lane"), "twenty-seven Pine Lane");
  assert.equal(spokenizeAddress("5 Oak Parkway"), "five Oak Parkway");
});

test("spokenizeAddress: 100..999 with tens=0 reads as 'X hundred'", () => {
  assert.equal(spokenizeAddress("100 Main Avenue"), "one hundred Main Avenue");
});

test("spokenizeAddress: 100..999 with tens<10 reads as 'X oh Y'", () => {
  // Three-digit street numbers like 105 / 209 read as "one oh five",
  // not "one hundred five" — it's the radio convention.
  assert.equal(
    spokenizeAddress("123 Main Street, NY"),
    "one twenty-three Main Street, New York",
  );
  // Sanity-check the "X oh Y" branch with a number that takes it.
  assert.equal(spokenizeAddress("305 Main Street"), "three oh five Main Street");
});

test("spokenizeAddress: 1000..9999 with tens<10 reads as 'X oh Y' (the SSA radio standard for street numbers)", () => {
  // 1805 → "eighteen oh five" is the canonical way SSA officers and
  // dispatchers say a 4-digit street number on the air. A regression
  // that read this as "one thousand eight hundred and five" would be
  // immediately obvious — and immediately broken.
  assert.equal(
    spokenizeAddress("1805 Main Street"),
    "eighteen oh five Main Street",
  );
  assert.equal(
    spokenizeAddress("1009 Elm Circle"),
    "ten oh nine Elm Circle",
  );
});

test("spokenizeAddress: 1000..9999 with tens>=10 reads as 'X Y'", () => {
  assert.equal(
    spokenizeAddress("1234 Main Street"),
    "twelve thirty-four Main Street",
  );
});

test("spokenizeAddress: 1000..9999 with tens=0 reads as 'X hundred'", () => {
  assert.equal(
    spokenizeAddress("1200 Center Place"),
    "twelve hundred Center Place",
  );
});

test("spokenizeAddress: 5+ digit numbers fall back to digit-by-digit (avoids 'twelve thousand …' on a zip-shaped house number)", () => {
  // Apartment building numbers can run 5 digits. The fallback to
  // per-digit reading is the safe choice — there's no "natural"
  // four-digit grouping for arbitrary 5-digit street numbers.
  assert.equal(
    spokenizeAddress("12345 Long Highway"),
    "one two three four five Long Highway",
  );
});

test("spokenizeAddress: digits attached to a non-digit suffix ('5th') are not rewritten", () => {
  // "5th" is not a number-only token (\b boundary fails between '5'
  // and 't'), so it must pass through. A regression that dropped the
  // \b would turn "5th Avenue" into "five th Avenue" on the air.
  assert.equal(spokenizeAddress("5th Avenue"), "5th Avenue");
});

// ---------- prepareLocationForTts (composition) -------------------------

test("prepareLocationForTts: full pipeline (state expansion + address spokenizer)", () => {
  // The end-to-end contract for AI-dispatch lookups: given a raw
  // postal-style address, produce a TTS-ready spoken string with
  // numbers spelled out, the state expanded, and the zip stripped.
  assert.equal(
    prepareLocationForTts("1805 N Main St, Santa Ana, CA 92701"),
    "eighteen oh five North Main Street, Santa Ana, California",
  );
  assert.equal(
    prepareLocationForTts("1234 SW Park Blvd, Phoenix, AZ 85001"),
    "twelve thirty-four Southwest Park Boulevard, Phoenix, Arizona",
  );
});

test("prepareLocationForTts: null / undefined / empty input returns the empty string", () => {
  // info_request lookups can pass any of these (a missing
  // location_name field, a property row with a null street, etc).
  // Crashing here would take the entire dispatcher response with it;
  // the contract is to return "" so the caller can fall through to
  // "negative, no address on file."
  assert.equal(prepareLocationForTts(null), "");
  assert.equal(prepareLocationForTts(undefined), "");
  assert.equal(prepareLocationForTts(""), "");
});
