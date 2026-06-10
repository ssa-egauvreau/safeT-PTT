/**
 * Tests for `server/src/aiDispatch/cadPersonHelpers.ts`.
 *
 * These helpers run on every spoken CAD person-search the AI dispatcher
 * relays (968 / "run X in the system"). They are pure, but every regression
 * has a real radio consequence:
 *
 *  - `buildCadPersonLinkFromSubject` constructs the JSON body sent to 10-8
 *    when an officer asks for a person lookup that returns no record. The
 *    dispatcher engine then POSTs a "person added to call" entry on the
 *    open incident (see `createPersonOnCallAfterMiss`). A regression that
 *    silently fills `first_name` with a DOB token (because the DOB regex
 *    didn't bite), or drops the last name, would mis-attribute a person
 *    record to the wrong incident and create a CAD record under the wrong
 *    name. The 400-char notes cap also matters — 10-8 truncates / 500s on
 *    oversized notes and we lose the add silently.
 *
 *  - `personSearchHadNoMatch` is the trigger that decides whether the AI
 *    follows up a person search with the "add to call" action above. A
 *    regression that flips a real hit to "no match" would POST stray
 *    person records to live incidents.
 *
 * `cadDispatchRules.test.ts` already covers the happy-path DOB extraction
 * for "John Smith DOB 01/15/1990"; this file pins everything else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCadPersonLinkFromSubject,
  personSearchHadNoMatch,
} from "../../src/aiDispatch/cadPersonHelpers.js";

// ---------- buildCadPersonLinkFromSubject -------------------------------

test("buildCadPersonLinkFromSubject: returns null for empty / whitespace-only / single-char subject", () => {
  // The CAD person POST is keyed on at least a last name. A 0-1 char
  // subject is almost certainly garbled ASR — never POST a bare
  // letter as a person record.
  assert.equal(buildCadPersonLinkFromSubject(""), null);
  assert.equal(buildCadPersonLinkFromSubject("   "), null);
  assert.equal(buildCadPersonLinkFromSubject("A"), null);
  // Tab/newline-only also reads as empty after the trim.
  assert.equal(buildCadPersonLinkFromSubject("\t\n  "), null);
});

test("buildCadPersonLinkFromSubject: 2-character subject is the boundary and produces a single-name link", () => {
  // The guard is `< 2`, not `<= 2` — pin the boundary so a refactor
  // that tightens it to `< 3` doesn't silently start dropping
  // legitimate short last names (e.g. "Ng", "Vo", "Le").
  const link = buildCadPersonLinkFromSubject("Vo");
  assert.equal(link?.last_name, "Vo");
  assert.equal(link?.first_name, null);
});

test("buildCadPersonLinkFromSubject: single token (no DOB) maps to last_name only", () => {
  // Officer says only a surname — CAD expects last_name for the
  // search/link. first_name must be null (not the same string twice).
  const link = buildCadPersonLinkFromSubject("Smith");
  assert.equal(link?.first_name, null);
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, null);
  assert.equal(link?.relation, null);
  assert.match(link?.notes ?? "", /Subject lookup Smith/);
});

test("buildCadPersonLinkFromSubject: two tokens map to first_name + last_name (no DOB)", () => {
  const link = buildCadPersonLinkFromSubject("John Smith");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, null);
});

test("buildCadPersonLinkFromSubject: 3+ tokens treat the rest as a multi-word last name", () => {
  // "Maria de la Cruz" — the rest-of-tokens become the last name so
  // the CAD record matches what a clerk would type. This is the
  // current behaviour and is documented as such.
  const link = buildCadPersonLinkFromSubject("Maria de la Cruz");
  assert.equal(link?.first_name, "Maria");
  assert.equal(link?.last_name, "de la Cruz");
});

test("buildCadPersonLinkFromSubject: 'DOB' keyword (case-insensitive) extracts M/D/Y", () => {
  for (const variant of [
    "John Smith DOB 01/15/1990",
    "John Smith dob 01/15/1990",
    "John Smith Dob 01/15/1990",
  ]) {
    const link = buildCadPersonLinkFromSubject(variant);
    assert.equal(link?.first_name, "John", variant);
    assert.equal(link?.last_name, "Smith", variant);
    assert.equal(link?.dob, "01/15/1990", variant);
  }
});

test("buildCadPersonLinkFromSubject: 'born' keyword extracts DOB (alternative to 'DOB')", () => {
  // The regex matches `(dob|born)`. Officers sometimes say "born in
  // 1990" or "born 1/15/90" — both must parse.
  const link = buildCadPersonLinkFromSubject("John Smith born 01/15/1990");
  assert.equal(link?.dob, "01/15/1990");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: DOB optional colon separator ('DOB: 01/15/1990')", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB: 01/15/1990");
  assert.equal(link?.dob, "01/15/1990");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: dash-separated DOB (01-15-1990) extracts cleanly", () => {
  const link = buildCadPersonLinkFromSubject("John Smith DOB 01-15-1990");
  assert.equal(link?.dob, "01-15-1990");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: short year DOB (1-2 digit yr) parses (M/D/YY)", () => {
  // CAD operators sometimes type 2-digit years — the regex accepts
  // {2,4} so "1/15/90" must still capture.
  const link = buildCadPersonLinkFromSubject("John Smith DOB 1/15/90");
  assert.equal(link?.dob, "1/15/90");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: ISO-style YYYY-MM-DD DOB also parses", () => {
  // The second branch of the date alternation. A regression that
  // dropped that branch would mis-route an ASR transcription of
  // "born nineteen ninety dash one dash fifteen" to a stripped DOB.
  const link = buildCadPersonLinkFromSubject("Smith DOB 1990-01-15");
  assert.equal(link?.dob, "1990-01-15");
  assert.equal(link?.last_name, "Smith");
});

test("buildCadPersonLinkFromSubject: DOB token is REMOVED from the name portion", () => {
  // Critical: the DOB chunk must not leak into first_name/last_name.
  // A regression would produce `last_name: "Smith DOB 01/15/1990"`
  // and CAD would create a person whose last name contains a date.
  const link = buildCadPersonLinkFromSubject("John Smith DOB 01/15/1990");
  assert.ok(link);
  assert.doesNotMatch(link!.first_name ?? "", /\d/);
  assert.doesNotMatch(link!.last_name ?? "", /\d/);
  assert.doesNotMatch(link!.last_name ?? "", /DOB/i);
});

test("buildCadPersonLinkFromSubject: DOB-only subject (after strip → no name) returns null", () => {
  // After scrubbing the DOB out of "DOB 01/15/1990" there are zero
  // name tokens left. The helper documents this as null — never
  // POST a person record without a name.
  assert.equal(buildCadPersonLinkFromSubject("DOB 01/15/1990"), null);
  assert.equal(buildCadPersonLinkFromSubject("born 1990-01-15"), null);
});

test("buildCadPersonLinkFromSubject: notes are capped at 400 characters (10-8 oversize guard)", () => {
  // The notes field is sliced to 400 in the source. 10-8 POSTs with
  // oversized notes either truncate or reject; pin the cap so a
  // refactor that bumps it to 4000 doesn't surface as silently
  // dropped CAD inserts.
  const long = "Smith " + "x".repeat(1000);
  const link = buildCadPersonLinkFromSubject(long);
  assert.ok(link);
  assert.ok((link!.notes ?? "").length <= 400, "notes must not exceed 400 chars");
  // Subject prefix is preserved at the front of the notes.
  assert.match(link!.notes ?? "", /^Subject lookup Smith/);
});

test("buildCadPersonLinkFromSubject: relation is always null (CAD person link, not a related party)", () => {
  // The helper is for the lookup-then-link path. A regression that
  // started filling `relation` would mis-tag the new record as a
  // related party (e.g. "WITNESS") on the call.
  assert.equal(buildCadPersonLinkFromSubject("Smith")?.relation, null);
  assert.equal(buildCadPersonLinkFromSubject("John Smith")?.relation, null);
  assert.equal(
    buildCadPersonLinkFromSubject("John Smith DOB 01/15/1990")?.relation,
    null,
  );
});

test("buildCadPersonLinkFromSubject: collapses leftover whitespace after the DOB strip", () => {
  // After stripping "DOB 01/15/1990" out of the middle, the source
  // does `.replace(/\s+/g, " ").trim()` — pin that so a refactor
  // doesn't leave a double-space in the spoken last name.
  const link = buildCadPersonLinkFromSubject("John   DOB 01/15/1990   Smith");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
  assert.equal(link?.dob, "01/15/1990");
});

test("buildCadPersonLinkFromSubject: name with leading/trailing whitespace is trimmed before parse", () => {
  const link = buildCadPersonLinkFromSubject("   John Smith   ");
  assert.equal(link?.first_name, "John");
  assert.equal(link?.last_name, "Smith");
});

// ---------- personSearchHadNoMatch --------------------------------------

test("personSearchHadNoMatch: detects the canonical 'no matching persons' phrasing", () => {
  // This is the trigger that flips an empty person search into the
  // "add to call" branch. The CAD radio lookup phrases the negative
  // result as "no matching persons in CAD" — match that literally.
  assert.equal(personSearchHadNoMatch("no matching persons"), true);
  assert.equal(personSearchHadNoMatch("352, no matching persons in CAD."), true);
});

test("personSearchHadNoMatch: case-insensitive", () => {
  // ASR / TTS pipelines normalise casing differently. The regex uses
  // /i so the trigger must fire regardless of casing.
  assert.equal(personSearchHadNoMatch("NO MATCHING PERSONS"), true);
  assert.equal(personSearchHadNoMatch("No Matching Persons"), true);
  assert.equal(personSearchHadNoMatch("no Matching PERSONS"), true);
});

test("personSearchHadNoMatch: a 'match found' line (negative case) returns false", () => {
  // Critical no-stomp test — a real hit must NOT trigger the
  // person-add path. Otherwise the AI would create a duplicate
  // person record on every successful lookup.
  assert.equal(
    personSearchHadNoMatch("Found 1 matching person: John Smith, DOB 1/15/1990."),
    false,
  );
  assert.equal(personSearchHadNoMatch("352, one match for John Smith."), false);
});

test("personSearchHadNoMatch: empty / unrelated lines return false", () => {
  // The trigger gates an external POST to 10-8; mis-firing here would
  // create a spurious CAD person record. Guard against it for
  // common no-result-but-no-trigger lines.
  assert.equal(personSearchHadNoMatch(""), false);
  assert.equal(personSearchHadNoMatch("CAD is down right now."), false);
  assert.equal(personSearchHadNoMatch("Negative, no name heard."), false);
});

test("personSearchHadNoMatch: requires the exact 'no matching persons' phrase, not just 'no match'", () => {
  // Pin the specific phrasing. A looser regex (e.g. /no match/) would
  // mis-fire on "no matching vehicles" — a different CAD lookup
  // type — and create a person record under the vehicle's subject
  // string.
  assert.equal(personSearchHadNoMatch("no matching vehicles"), false);
  assert.equal(personSearchHadNoMatch("no match for that plate"), false);
});
