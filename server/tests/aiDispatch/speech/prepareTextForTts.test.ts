/**
 * Tests for `server/src/aiDispatch/speech/prepareTextForTts.ts`.
 *
 * Every spoken AI-dispatch reply runs through `prepareTextForTts` before it
 * is handed to ElevenLabs. A regression here is audible on the air — a
 * dispatcher reading "10-97" as "ten to ninety-seven", "913" as "nine hundred
 * thirteen", "32-08" as "thirty-two to eight", or phone numbers as a single
 * long integer — and is the kind of bug that erodes trust in the system
 * faster than anything else. The transformations are layered and
 * order-sensitive, so the tests pin a handful of representative inputs
 * through the full pipeline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareTextForTts } from "../../../src/aiDispatch/speech/prepareTextForTts.js";

test("prepareTextForTts: 10-codes are spoken as 'ten' + pause + suffix (never read as 'to')", () => {
  // "10-97" must NOT read as "ten to ninety-seven". The pipeline inserts an
  // SSML break and reads each side as words.
  const out = prepareTextForTts("10-97");
  assert.ok(/\bten\b/.test(out), `expected 'ten' in output, got: ${out}`);
  assert.ok(/\bninety\b/.test(out), `expected 'ninety' in output, got: ${out}`);
  assert.ok(/\bseven\b/.test(out), `expected 'seven' in output, got: ${out}`);
  assert.ok(out.includes("<break"), "10-code must insert an SSML break, not a hyphen");
  assert.ok(!/\bto\b/.test(out), "must never read a 10-code dash as 'to'");
});

test("prepareTextForTts: single-digit 10-codes (10-4) read each digit as a word", () => {
  const out = prepareTextForTts("10-4");
  assert.ok(/\bten\b/.test(out));
  assert.ok(/\bfour\b/.test(out));
  assert.ok(out.includes("<break"));
});

test("prepareTextForTts: command-staff codes 27-000 / 27-030 use their hand-crafted pronunciations", () => {
  // These are radio-specific phrasings; a regression that fell through to the
  // generic two-digit handler would read "27-000" as "twenty seven, zero zero
  // zero" instead of "twenty seven thousand".
  assert.equal(prepareTextForTts("27-000"), "twenty seven thousand");
  assert.equal(prepareTextForTts("27-030"), "zero thirty");
});

test("prepareTextForTts: account codes in XX-YY form are spokenized (32-08, not 'thirty-two to eight')", () => {
  const out = prepareTextForTts("Unit 32-08 respond");
  // The exact spoken form is "thirty-two-oh-eight" with breaks; verify the
  // pieces individually so a small format tweak doesn't break the test.
  assert.ok(/thirty/.test(out));
  assert.ok(/\btwo\b/.test(out));
  assert.ok(/\boh\b/.test(out));
  assert.ok(/\beight\b/.test(out));
  assert.ok(!/\bto\b/.test(out), "account-code dash must not read as 'to'");
});

test("prepareTextForTts: known three-digit info codes (913) speak as grouped words", () => {
  // SPELL_CODES → "913" must read as "nine thirteen", not "nine one three"
  // or "nine hundred thirteen".
  const out = prepareTextForTts("Suspect at 913 in progress");
  assert.ok(out.includes("nine thirteen"), `expected 'nine thirteen' in: ${out}`);
});

test("prepareTextForTts: alphanumeric info codes (459A) keep their phonetic letter ('Alpha')", () => {
  // "459A" → "four fifty-nine Alpha"; the trailing letter is critical because
  // dispatch uses A/B/E/S to distinguish audible alarm vs silent alarm.
  const out = prepareTextForTts("Code 459A at building");
  assert.match(out, /Alpha/);
  assert.ok(/four fifty/.test(out));
});

test("prepareTextForTts: 'CA' inside an address expands to 'California' (not read as a call type)", () => {
  // Without state expansion, ", CA" would later get expanded by the call-type
  // map ("CA" → "citizen assist" in some agencies), turning an address into
  // a CAD code mid-sentence.
  const out = prepareTextForTts("at 1234 Main St, CA 92614");
  assert.match(out, /California/);
  assert.ok(!out.includes(", CA"), "raw state abbreviation must not survive");
});

test("prepareTextForTts: street-type abbreviations expand inside non-address text too", () => {
  const out = prepareTextForTts("Meet on Main St near Oak Ave.");
  assert.match(out, /Street/);
  assert.match(out, /Avenue/);
});

test("prepareTextForTts: 'address is X' phrase routes through the address spokenizer", () => {
  // This is the LLM-output path: the dispatcher often says "the address is
  // 1234 Main St, Irvine, CA 92614". Numbers get spelled out and the trailing
  // zip is dropped (the spokenized address contract).
  const out = prepareTextForTts("address is 1234 Main St, Irvine, CA 92614");
  assert.ok(/Main Street/.test(out), `expected 'Main Street' in: ${out}`);
  assert.ok(/California/.test(out));
  assert.ok(!/92614/.test(out), "zip should be stripped from the spoken address");
  assert.ok(!/1234/.test(out), "house number should be spelled out, not left as digits");
});

test("prepareTextForTts: embedded US phone numbers split into 3-3-4 digit groups", () => {
  // Phones must read as "7 1 4, 5 5 5, 1 2 3 4". A regression that left the
  // raw integer in place would have TTS read it as "seven billion one hundred…".
  const out = prepareTextForTts("Call 7145551234");
  assert.match(out, /7 1 4/);
  assert.match(out, /5 5 5/);
  assert.match(out, /1 2 3 4/);
});

test("prepareTextForTts: 'UNIT' is normalized to lowercase so TTS reads 'unit', not 'U-N-I-T'", () => {
  // ElevenLabs spells out all-caps tokens. Officers expect to hear the word
  // "unit", not "you-en-eye-tee".
  const out = prepareTextForTts("UNIT 27 respond");
  assert.match(out, /\bunit\b/);
  assert.ok(!/\bUNIT\b/.test(out));
});

test("prepareTextForTts: adds pacing breaks after sentence terminators when none are present yet", () => {
  // Pacing breaks improve intelligibility on the radio. The pipeline must
  // skip pacing if other breaks were already added (e.g. 10-code path).
  const out = prepareTextForTts("Hello world.");
  assert.ok(out.includes("<break"), `expected an SSML break after the period: ${out}`);
});

test("prepareTextForTts: pacing pass is skipped when other transformations already inserted breaks", () => {
  // 10-codes insert breaks; the pacing pass must not double-up by also
  // injecting after every comma in the same string.
  const breaksFor1097 = (prepareTextForTts("10-97").match(/<break/g) ?? []).length;
  assert.ok(breaksFor1097 >= 1, "10-97 must insert at least one SSML break");
  // No commas / sentence terminators in "10-97" → pacing has nothing to add.
  const breaksAfterPunctuation = (prepareTextForTts("10-97, copy.").match(/<break/g) ?? []).length;
  assert.equal(
    breaksAfterPunctuation,
    breaksFor1097,
    "pacing must not stack on top of dash-breaks once any <break> is present",
  );
});

test("prepareTextForTts: empty / whitespace input passes through (no crash, no fabricated output)", () => {
  assert.equal(prepareTextForTts(""), "");
  // Whitespace-only is preserved verbatim by the pipeline (no normalization).
  // We just need it to not throw.
  assert.doesNotThrow(() => prepareTextForTts("   "));
});

test("prepareTextForTts: leaves plain prose that has no codes, addresses, or hyphens unchanged", () => {
  const plain = "Stand by for further instructions";
  assert.equal(
    prepareTextForTts(plain),
    plain,
    "no transformation should apply; no <break> added without punctuation",
  );
});
