/**
 * Tests for `server/src/aiDispatch/cadPersonHelpers.ts` pure helpers.
 *
 * The AI dispatcher uses these two helpers when an officer asks for a CAD
 * person lookup (code 968) and 10-8 returns no matching record. A regression
 * here either:
 *   - Creates the WRONG person record on the active call (split first/last
 *     name backwards, lose the DOB, paste the entire transcript into a name
 *     field) — which then gets attached to a CAD incident with the officer's
 *     callsign next to it; or
 *   - Misses the "no matching persons" miss-detection, so the dispatcher
 *     never triggers the create-and-link fallback that puts the subject on
 *     the call.
 *
 * Both helpers are pure (no DB, no network) and exported, so the contract
 * pinned here is exactly what's run in production.
 *
 * Properties pinned by this file:
 *
 *  1. `buildCadPersonLinkFromSubject`:
 *     - Returns null for empty / blank / 1-character "subjects" — never
 *       create a CAD person with an empty or single-letter name.
 *     - A single token becomes the `last_name` (and `first_name` stays null)
 *       — matches how CAD systems index by surname when only one name was
 *       heard on the radio.
 *     - Two+ tokens split into first / "rest joined as last" so middle and
 *       compound surnames stay together on the person record.
 *     - DOB is extracted from `DOB:` or `born` markers in mm/dd/yyyy,
 *       m/d/yy, m-d-yyyy, AND iso yyyy-mm-dd — all four shapes are real
 *       officer phrasings.
 *     - The DOB substring is REMOVED from the name fields, so the surname
 *       isn't "Smith DOB 01/15/1990".
 *     - The `notes` field is capped at 400 chars to stay under 10-8's
 *       person-note column ceiling.
 *
 *  2. `personSearchHadNoMatch`:
 *     - Detects 10-8's "no matching persons" miss line, case-insensitively,
 *       so the create-and-link fallback fires reliably.
 *     - Does NOT false-match on a successful lookup that happens to contain
 *       the word "persons" or "matching".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCadPersonLinkFromSubject,
  personSearchHadNoMatch,
} from "../../src/aiDispatch/cadPersonHelpers.js";

// ---------------------------------------------------------------------------
// buildCadPersonLinkFromSubject
// ---------------------------------------------------------------------------

test("buildCadPersonLinkFromSubject: returns null for empty / blank / nullish input", () => {
  assert.equal(buildCadPersonLinkFromSubject(""), null);
  assert.equal(buildCadPersonLinkFromSubject("   "), null);
  assert.equal(buildCadPersonLinkFromSubject("\t\n"), null);
});

test("buildCadPersonLinkFromSubject: returns null for a single-character subject (too short to be a name)", () => {
  assert.equal(buildCadPersonLinkFromSubject("J"), null);
  assert.equal(buildCadPersonLinkFromSubject("  X  "), null);
});

test("buildCadPersonLinkFromSubject: single token becomes last_name (first stays null)", () => {
  const link = buildCadPersonLinkFromSubject("Garcia");
  assert.ok(link);
  assert.equal(link.first_name, null);
  assert.equal(link.last_name, "Garcia");
  assert.equal(link.dob, null);
  assert.equal(link.relation, null);
  assert.match(link.notes ?? "", /Subject lookup Garcia/);
});

test("buildCadPersonLinkFromSubject: two-token name splits first + last", () => {
  const link = buildCadPersonLinkFromSubject("Maria Garcia");
  assert.ok(link);
  assert.equal(link.first_name, "Maria");
  assert.equal(link.last_name, "Garcia");
  assert.equal(link.dob, null);
});

test("buildCadPersonLinkFromSubject: three-token name keeps middle joined into last_name", () => {
  // Compound and double-barrelled surnames must not be silently dropped —
  // they're frequently the disambiguating part of an officer lookup.
  const link = buildCadPersonLinkFromSubject("Juan Carlos Garcia Lopez");
  assert.ok(link);
  assert.equal(link.first_name, "Juan");
  assert.equal(link.last_name, "Carlos Garcia Lopez");
});

test("buildCadPersonLinkFromSubject: collapses repeated whitespace before splitting names", () => {
  const link = buildCadPersonLinkFromSubject("John    Smith");
  assert.ok(link);
  assert.equal(link.first_name, "John");
  assert.equal(link.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: DOB with 'DOB:' marker and mm/dd/yyyy", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB: 01/15/1990");
  assert.ok(link);
  assert.equal(link.first_name, "John");
  // DOB substring must be removed from the name fields so the surname
  // doesn't end up as "Smith DOB 01/15/1990".
  assert.equal(link.last_name, "Smith");
  assert.equal(link.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: 'DOB' marker without a colon still parses", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 01/15/1990");
  assert.ok(link);
  assert.equal(link.first_name, "John");
  assert.equal(link.last_name, "Smith");
  assert.equal(link.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: 'born' marker (LLM transcript phrasing) is equivalent to DOB", () => {
  const link = buildCadPersonLinkFromSubject("Maria Garcia born 3/4/85");
  assert.ok(link);
  assert.equal(link.first_name, "Maria");
  assert.equal(link.last_name, "Garcia");
  assert.equal(link.dob, "3/4/85");
});

test("buildCadPersonLinkFromSubject: accepts dash-separated DOB", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 1-15-1990");
  assert.ok(link);
  assert.equal(link.dob, "1-15-1990");
  assert.equal(link.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: accepts ISO yyyy-mm-dd DOB", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 1990-01-15");
  assert.ok(link);
  assert.equal(link.dob, "1990-01-15");
  assert.equal(link.first_name, "John");
  assert.equal(link.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: DOB matching is case-insensitive on the marker", () => {
  const upper = buildCadPersonLinkFromSubject("Jane Doe dob 02/29/2000");
  assert.equal(upper?.dob, "02/29/2000");
  const lower = buildCadPersonLinkFromSubject("Jane Doe BORN 02/29/2000");
  assert.equal(lower?.dob, "02/29/2000");
});

test("buildCadPersonLinkFromSubject: DOB at the start of the subject still strips cleanly", () => {
  // The officer says "DOB 01-15-1990 John Smith" — the name fields must
  // be just "John" / "Smith", not "DOB" / "01-15-1990 John Smith".
  const link = buildCadPersonLinkFromSubject("DOB 01-15-1990 John Smith");
  assert.ok(link);
  assert.equal(link.first_name, "John");
  assert.equal(link.last_name, "Smith");
  assert.equal(link.dob, "01-15-1990");
});

test("buildCadPersonLinkFromSubject: a subject that is ONLY a DOB (no name) returns null", () => {
  // After stripping the DOB there's nothing left to put on the person
  // record — better to return null than create a nameless person.
  assert.equal(buildCadPersonLinkFromSubject("DOB 01/15/1990"), null);
});

test("buildCadPersonLinkFromSubject: notes always include the original raw subject", () => {
  const link = buildCadPersonLinkFromSubject("Maria Garcia DOB 1/2/85");
  assert.ok(link);
  assert.match(link.notes ?? "", /Maria Garcia DOB 1\/2\/85/);
});

test("buildCadPersonLinkFromSubject: notes is hard-capped at 400 characters", () => {
  // 10-8's person-note column has a finite length; an unbounded transcript
  // would either get rejected on the POST or get silently truncated by
  // the upstream API in a place we can't see — this guard makes the cap
  // explicit and predictable on our side.
  const long = "A B " + "x".repeat(800);
  const link = buildCadPersonLinkFromSubject(long);
  assert.ok(link);
  assert.ok((link.notes ?? "").length <= 400, `notes.length=${(link.notes ?? "").length}`);
});

test("buildCadPersonLinkFromSubject: relation is always null (helper does not infer relations)", () => {
  // The relation field is only populated by the LLM-side cad_person_link
  // payload. The "subject lookup" fallback must never guess it.
  const link = buildCadPersonLinkFromSubject("John Smith");
  assert.equal(link?.relation, null);
});

// ---------------------------------------------------------------------------
// personSearchHadNoMatch
// ---------------------------------------------------------------------------

test("personSearchHadNoMatch: matches 10-8's canonical miss line, case-insensitively", () => {
  assert.equal(personSearchHadNoMatch("No matching persons found."), true);
  assert.equal(personSearchHadNoMatch("no matching persons"), true);
  assert.equal(personSearchHadNoMatch("NO MATCHING PERSONS in CAD"), true);
});

test("personSearchHadNoMatch: matches when the miss phrase is embedded in a longer dispatcher reply", () => {
  assert.equal(
    personSearchHadNoMatch("352, no matching persons in CAD; do you want me to create a new record?"),
    true,
  );
});

test("personSearchHadNoMatch: does NOT match a successful lookup", () => {
  assert.equal(
    personSearchHadNoMatch("352, matching persons: John Smith DOB 01/15/1990, address on file."),
    false,
  );
  assert.equal(personSearchHadNoMatch("Found 3 persons matching that subject."), false);
});

test("personSearchHadNoMatch: returns false on empty / unrelated lines", () => {
  assert.equal(personSearchHadNoMatch(""), false);
  assert.equal(personSearchHadNoMatch("CAD is down right now."), false);
  assert.equal(personSearchHadNoMatch("No record found"), false);
});
