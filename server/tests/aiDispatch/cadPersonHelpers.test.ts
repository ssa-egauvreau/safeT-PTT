/**
 * Tests for the pure helpers in `server/src/aiDispatch/cadPersonHelpers.ts`.
 *
 * These two helpers gate the AI dispatcher's "subject lookup miss → create &
 * link a person on the open call" path:
 *
 *   - `buildCadPersonLinkFromSubject(subject)` parses the dispatcher's free-text
 *     subject query into the structured `CadPersonLinkFields` body that the
 *     10-8 New Person API expects (relation / first_name / last_name / dob /
 *     notes). A regression here either drops the DOB silently (so the new
 *     person row goes in with no birthday and the radio readback can never
 *     verify identity), or splits the name wrong (single-name input ending
 *     up in `first_name` instead of `last_name`, breaking 10-8 record-find
 *     ordering).
 *
 *   - `personSearchHadNoMatch(line)` decides whether the radio response from
 *     the dispatcher's subject search counts as a miss. A regression here
 *     either misses the trigger phrase (so a real miss is treated as a hit
 *     and the engine never creates a new person on the call) or fires on a
 *     line that contains a hit (so the engine over-writes a successful
 *     match with a freshly created person row — a duplicate identity).
 *
 * Both helpers are pure — covering every branch here pins the contract the
 * non-pure callers in `engine.ts` and `cadDispatchRules.ts` rely on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCadPersonLinkFromSubject,
  personSearchHadNoMatch,
} from "../../src/aiDispatch/cadPersonHelpers.js";

// ---------- buildCadPersonLinkFromSubject -------------------------------

test("buildCadPersonLinkFromSubject: empty / whitespace / single-char subject → null", () => {
  // Less than 2 trimmed chars is "no usable subject" — refusing to create a
  // bogus person row guards against typos and accidental fragments slipping
  // into the 10-8 record from a noisy radio.
  assert.equal(buildCadPersonLinkFromSubject(""), null);
  assert.equal(buildCadPersonLinkFromSubject("   "), null);
  assert.equal(buildCadPersonLinkFromSubject("a"), null);
});

test("buildCadPersonLinkFromSubject: single-name subject lands in last_name (first_name stays null)", () => {
  // Convention: a single token is the last name, since 10-8 record-find
  // queries last name first. Putting it in first_name instead would silently
  // drop the result for a valid match.
  const link = buildCadPersonLinkFromSubject("Smith");
  assert.deepEqual(link, {
    relation: null,
    first_name: null,
    last_name: "Smith",
    dob: null,
    notes: "Subject lookup Smith",
  });
});

test("buildCadPersonLinkFromSubject: two-token subject splits first / last", () => {
  const link = buildCadPersonLinkFromSubject("John Smith");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, null);
  assert.equal(link?.relation, null);
});

test("buildCadPersonLinkFromSubject: 3+ tokens → first token is first_name, rest joined as last_name", () => {
  // Compound surnames (Van Buren, De La Cruz) come through the radio as a
  // single multi-word last_name. Splitting at the first space keeps the
  // contract simple and predictable; locking it here so a clever refactor
  // that tries to "guess" middle names doesn't regress this.
  const link = buildCadPersonLinkFromSubject("Maria De La Cruz");
  assert.equal(link?.first_name, "Maria");
  assert.equal(link?.last_name, "De La Cruz");
});

test("buildCadPersonLinkFromSubject: 'DOB' marker pulls a slash date and removes it from the name", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 01/15/1990");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: 'born' marker is treated like DOB", () => {
  // The radio voice often phrases it "born one fifteen ninety" → the
  // transcriber emits "born 01/15/1990". Both spellings must extract the date.
  const link = buildCadPersonLinkFromSubject("Smith born 01/15/1990");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: dash-form date works (1-15-90, 1-15-1990)", () => {
  // Transcribers are inconsistent about separators. Locking both formats in.
  const a = buildCadPersonLinkFromSubject("John Smith DOB 1-15-1990");
  assert.equal(a?.dob, "1-15-1990");
  const b = buildCadPersonLinkFromSubject("John Smith DOB 1-15-90");
  assert.equal(b?.dob, "1-15-90");
});

test("buildCadPersonLinkFromSubject: ISO-style yyyy-mm-dd date works", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 1990-01-15");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, "1990-01-15");
});

test("buildCadPersonLinkFromSubject: DOB removal collapses surrounding whitespace cleanly", () => {
  // Make sure last_name doesn't end up with trailing/leading spaces or
  // extra runs of whitespace where the DOB used to be.
  const link = buildCadPersonLinkFromSubject("John  DOB 01/15/1990  Smith");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: notes preserve the ORIGINAL trimmed query verbatim", () => {
  // The notes field is the audit trail of what the dispatcher actually said.
  // It must NOT be the post-DOB-stripped version, or the recording loses
  // context. Lock that contract in.
  const link = buildCadPersonLinkFromSubject("John Smith DOB 01/15/1990");
  assert.equal(link?.notes, "Subject lookup John Smith DOB 01/15/1990");
});

test("buildCadPersonLinkFromSubject: notes are capped at 400 chars (10-8 field cap)", () => {
  const huge = "A".repeat(500);
  const link = buildCadPersonLinkFromSubject(huge);
  assert.ok(link);
  // "Subject lookup " (15) + name, capped to 400 total.
  assert.ok((link.notes ?? "").length <= 400);
});

test("buildCadPersonLinkFromSubject: relation always null (engine fills it from CAD context)", () => {
  // Relation is a downstream concern (suspect / victim / RP) — the parser
  // never guesses it. Locking the contract here so a future "auto-detect"
  // refactor doesn't silently start filling this field.
  for (const subject of ["John Smith", "Smith", "John Smith DOB 01/15/1990"]) {
    assert.equal(buildCadPersonLinkFromSubject(subject)?.relation, null, subject);
  }
});

test("buildCadPersonLinkFromSubject: subject of only a DOB → null (no name to file under)", () => {
  // After stripping the DOB, the name parts are empty; we return null rather
  // than create a person row with nothing in first_name / last_name.
  assert.equal(buildCadPersonLinkFromSubject("DOB 01/15/1990"), null);
});

// ---------- personSearchHadNoMatch --------------------------------------

test("personSearchHadNoMatch: matches the canonical CAD miss line", () => {
  // The 10-8 lookup speech for a missed person query is "no matching
  // persons" — locking that exact phrasing because the engine branches off
  // it (creates the person on the open call). A regression that changes
  // the trigger text breaks the auto-create flow without any test signal.
  assert.equal(personSearchHadNoMatch("no matching persons in CAD"), true);
  assert.equal(personSearchHadNoMatch("352, no matching persons."), true);
});

test("personSearchHadNoMatch: case-insensitive", () => {
  assert.equal(personSearchHadNoMatch("No Matching Persons found."), true);
  assert.equal(personSearchHadNoMatch("NO MATCHING PERSONS"), true);
});

test("personSearchHadNoMatch: must NOT fire on a hit-style line", () => {
  // These are typical hit-style outputs the engine speaks back. None of
  // them must trigger the auto-create branch.
  for (const line of [
    "John Smith DOB 01/15/1990 found in CAD",
    "352, copy. one person in CAD",
    "matched on John Smith",
    "",
    "  ",
  ]) {
    assert.equal(personSearchHadNoMatch(line), false, `must not match: ${line}`);
  }
});
