/**
 * Tests for `server/src/aiDispatch/platePhonetics.ts`.
 *
 * These helpers feed plate readbacks and unit-id pronunciations into the TTS
 * pipeline. A regression here makes the AI dispatcher read "8VWV621" as
 * "eight-vee-double-you" instead of the NATO phonetic the officer expects,
 * which destroys field usability.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callSignForReadback,
  plateToSpokenPhonetic,
  stateCodeToSpoken,
  vinLast6Spoken,
} from "../../src/aiDispatch/platePhonetics.js";

test("plateToSpokenPhonetic maps letters to NATO and digits to words", () => {
  // Example from the codebase JSDoc: 8VWV621 → 8 Victor Whiskey Victor 6 2 1.
  assert.equal(
    plateToSpokenPhonetic("8VWV621"),
    "eight Victor Whiskey Victor six two one",
  );
});

test("plateToSpokenPhonetic upper-cases lowercase plates first", () => {
  assert.equal(
    plateToSpokenPhonetic("abc123"),
    "Alpha Bravo Charlie one two three",
  );
});

test("plateToSpokenPhonetic ignores non-alphanumeric characters", () => {
  assert.equal(plateToSpokenPhonetic("AB-12"), "Alpha Bravo one two");
  assert.equal(plateToSpokenPhonetic(" A 1 "), "Alpha one");
});

test("plateToSpokenPhonetic returns '' for null/undefined/empty", () => {
  assert.equal(plateToSpokenPhonetic(null), "");
  assert.equal(plateToSpokenPhonetic(undefined), "");
  assert.equal(plateToSpokenPhonetic(""), "");
});

test("vinLast6Spoken reads the last 6 of a VIN phonetically", () => {
  // 17-char VIN: only the last 6 characters are read for radio.
  const vin = "1HGBH41JXMN109186";
  assert.equal(
    vinLast6Spoken(vin),
    "one zero nine one eight six",
  );
});

test("vinLast6Spoken returns '' when the VIN is too short", () => {
  assert.equal(vinLast6Spoken("ABCDE"), ""); // < 6 chars
  assert.equal(vinLast6Spoken(""), "");
  assert.equal(vinLast6Spoken(null), "");
});

test("callSignForReadback keeps 27-0XX command-staff prefix intact", () => {
  // The 27-0XX pattern (three-digit tail starting with 0) is command staff and
  // is read back with the full prefix on air.
  assert.equal(callSignForReadback("27-001"), "27-001");
  assert.equal(callSignForReadback("27-040"), "27-040");
  assert.equal(callSignForReadback("27-099"), "27-099");
});

test("callSignForReadback drops the 27- prefix on a patrol unit (three-digit tail not starting with 0)", () => {
  // Patrol numbers (100..999) read back without the 27- prefix.
  assert.equal(callSignForReadback("27-100"), "100");
  assert.equal(callSignForReadback("27-205"), "205");
  assert.equal(callSignForReadback("27-999"), "999");
});

test("callSignForReadback upper-cases and trims the input", () => {
  assert.equal(callSignForReadback(" 27-040 "), "27-040"); // 27-0XX command-staff stays
  assert.equal(callSignForReadback(" 27-205 "), "205"); // patrol drops prefix
});

test("callSignForReadback leaves non-27 unit ids alone", () => {
  assert.equal(callSignForReadback("DISPATCH"), "DISPATCH");
  assert.equal(callSignForReadback("S-5"), "S-5");
});

test("stateCodeToSpoken expands known state codes (CA → California)", () => {
  assert.equal(stateCodeToSpoken("CA"), "California");
  assert.equal(stateCodeToSpoken("ca"), "California");
  assert.equal(stateCodeToSpoken("NV"), "Nevada");
  assert.equal(stateCodeToSpoken("NY"), "New York");
});

test("stateCodeToSpoken defaults to California for null/undefined (??-style default)", () => {
  // The implementation uses `state ?? "CA"`, so only null/undefined fall through
  // to the default. An empty string falls through to the lookup miss path.
  assert.equal(stateCodeToSpoken(null), "California");
  assert.equal(stateCodeToSpoken(undefined), "California");
});

test("stateCodeToSpoken returns the raw uppercase code for unknown states", () => {
  // Unknown state stays as the 2-letter code (so the TTS reads it as letters).
  assert.equal(stateCodeToSpoken("ZZ"), "ZZ");
  // An empty string is "unknown" under the same lookup miss path.
  assert.equal(stateCodeToSpoken(""), "");
});
