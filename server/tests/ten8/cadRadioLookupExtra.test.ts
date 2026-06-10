/**
 * Extra coverage for `server/src/ten8/cadRadioLookup.ts` — the pure helpers
 * that turn a 10-8 CAD incident JSON blob into the words an officer hears
 * spoken back over the radio via TTS.
 *
 * The existing `cadRadioLookup.test.ts` pins the headline happy-path readback.
 * This file fills in the branches that were not directly exercised:
 *
 *   - `normalizeCadTagName`         — phrase-to-tag aliasing (parking / billable).
 *   - `findTagIdOnIncident`         — id discovery across the {tagID, tagId, id}
 *                                     spellings 10-8 has emitted across versions.
 *   - `shortenLocationForRadio`     — strips state / ZIP / USA suffixes so the
 *                                     radio sentence stays terse.
 *   - `formatIncidentWhenForRadio`  — ordinal-day edge cases (11/12/13 vs 21/22/23
 *                                     vs 1/2/3) and 12 AM / 12 PM hour rendering.
 *   - `humanIncidentTypeForRadio`   — empty / "test" / unknown-with-dash /
 *                                     parenthetical-stripping branches.
 *   - `buildCadPersonSearchParams`  — query-only and DOB-only shapes.
 *   - `buildCadVehicleSearchParams` — stopword filtering and `q` fallback.
 *   - `pickIncidentSummaryForRadio` — every fall-through (summary > disposition
 *                                     notes > useful comment > disposition label
 *                                     > null).
 *   - `mapTen8ApiIncident`          — id fallback chain and address composition.
 *   - `formatCadIncidentLookupRadioLine` — no-call-id and unknown-status edges.
 *   - `buildCadPersonLinkBody`      — drops nullish fields without leaving empties.
 *
 * A miss in any of these would surface as a wrong word being spoken aloud to
 * an officer in the field — a credibility / safety regression that no other
 * test in the suite catches today.
 *
 * To keep the time-of-day assertions independent of the runner's TZ, no test
 * here relies on the `inc.timestamp` (unix seconds) fallback; every `date` /
 * `time` test passes the explicit string fields that the parser uses verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCadPersonLinkBody,
  buildCadPersonSearchParams,
  buildCadVehicleSearchParams,
  findTagIdOnIncident,
  formatCadIncidentLookupRadioLine,
  formatIncidentWhenForRadio,
  humanIncidentTypeForRadio,
  mapTen8ApiIncident,
  normalizeCadTagName,
  pickIncidentSummaryForRadio,
  shortenLocationForRadio,
} from "../../src/ten8/cadRadioLookup.js";

// ─── normalizeCadTagName ──────────────────────────────────────────────────

test("normalizeCadTagName: maps spoken 'billable' (any case / whitespace) to canonical 'Billable'", () => {
  // The dispatcher might say "billable", "Billable", or "  BILLABLE  ".
  // 10-8 stores the canonical 'Billable' — a regression that drops the
  // lowercase mapping would silently fail to tag the call.
  assert.equal(normalizeCadTagName("billable"), "Billable");
  assert.equal(normalizeCadTagName("BILLABLE"), "Billable");
  assert.equal(normalizeCadTagName("  Billable  "), "Billable");
});

test("normalizeCadTagName: both 'parking' and 'parking response' alias to 'Parking Response'", () => {
  // Officers shorten the phrase to "parking"; the longer spoken form must
  // also normalize to the same canonical tag string.
  assert.equal(normalizeCadTagName("parking"), "Parking Response");
  assert.equal(normalizeCadTagName("Parking Response"), "Parking Response");
  assert.equal(normalizeCadTagName("PARKING RESPONSE"), "Parking Response");
  // Multiple internal spaces collapse before matching — pins the
  // `replace(/\s+/g, " ")` normaliser, without which the alias would miss.
  assert.equal(normalizeCadTagName("parking   response"), "Parking Response");
});

test("normalizeCadTagName: unknown phrase is trimmed and returned verbatim", () => {
  // We do NOT lowercase / re-case an unknown tag — 10-8 tag names are
  // user-defined and case-sensitive on the server. Just trim.
  assert.equal(normalizeCadTagName("  Custom Tag  "), "Custom Tag");
});

test("normalizeCadTagName: empty / whitespace-only input is null (no API call to make)", () => {
  // The caller uses `null` to skip the tag-name filter; an empty string
  // would otherwise hit 10-8 with "tag=" and return everything.
  assert.equal(normalizeCadTagName(""), null);
  assert.equal(normalizeCadTagName("   "), null);
});

// ─── findTagIdOnIncident ──────────────────────────────────────────────────

test("findTagIdOnIncident: returns the matching tag id (case-insensitive label match)", () => {
  const id = findTagIdOnIncident(
    { tags: [{ tag: "Billable", tagID: 7 }, { tag: "Other", tagID: 9 }] },
    "billable",
  );
  assert.equal(id, 7);
});

test("findTagIdOnIncident: accepts tagID, tagId, and bare id spellings (10-8 version drift)", () => {
  // 10-8 has shipped at least three spellings of this field across versions.
  // A regression that only checks `tagID` would silently fail on newer rows.
  assert.equal(
    findTagIdOnIncident({ tags: [{ tag: "X", tagId: 3 }] }, "x"),
    3,
  );
  assert.equal(
    findTagIdOnIncident({ tags: [{ tag: "X", id: 4 }] }, "x"),
    4,
  );
});

test("findTagIdOnIncident: returns null when no tag matches or tags field is missing/malformed", () => {
  assert.equal(findTagIdOnIncident({}, "anything"), null);
  assert.equal(findTagIdOnIncident({ tags: null }, "x"), null);
  assert.equal(findTagIdOnIncident({ tags: [] }, "x"), null);
  assert.equal(
    findTagIdOnIncident({ tags: [{ tag: "X", tagID: 0 }] }, "x"),
    null,
    "id must be positive — 0 / negative are not valid tag ids",
  );
  assert.equal(
    findTagIdOnIncident({ tags: [{ tag: "X", tagID: "abc" }] }, "x"),
    null,
    "non-numeric id must not coerce to NaN row",
  );
  assert.equal(
    findTagIdOnIncident({ tags: [null, "garbage", { tag: 42, tagID: 1 }] as unknown[] }, "anything"),
    null,
    "malformed rows are skipped, not crashed on",
  );
});

// ─── shortenLocationForRadio ──────────────────────────────────────────────

test("shortenLocationForRadio: strips trailing state, ZIP, and 'USA'", () => {
  // Officer radios want "401 W 1st St, Santa Ana", not the postal form.
  assert.equal(
    shortenLocationForRadio("401 W 1st St, Santa Ana, CA 92701, USA"),
    "401 W 1st St, Santa Ana",
  );
});

test("shortenLocationForRadio: ZIP+4 and standalone two-letter state are also stripped", () => {
  assert.equal(
    shortenLocationForRadio("123 Main St, Anaheim, CA 92805-1234, USA"),
    "123 Main St, Anaheim",
  );
  assert.equal(
    shortenLocationForRadio("500 N Spring St, Los Angeles, CA"),
    "500 N Spring St, Los Angeles",
  );
});

test("shortenLocationForRadio: caps at two parts so the spoken line stays terse", () => {
  // The street + city is what an officer cares about; everything past the
  // second segment is dropped even if it isn't a state/ZIP/USA marker.
  assert.equal(
    shortenLocationForRadio("Mile Square Park, 16801 Euclid St, Fountain Valley, CA"),
    "Mile Square Park, 16801 Euclid St",
  );
});

test("shortenLocationForRadio: null / blank inputs collapse to empty string (no spoken segment)", () => {
  assert.equal(shortenLocationForRadio(null), "");
  assert.equal(shortenLocationForRadio(""), "");
  assert.equal(shortenLocationForRadio("   "), "");
});

// ─── formatIncidentWhenForRadio (ordinal day + 12h edges) ────────────────

test("formatIncidentWhenForRadio: teen days (11/12/13) use 'th', not 'st/nd/rd'", () => {
  // The classic ordinal-suffix trap: 11/12/13 are NOT 11st/12nd/13rd. This
  // pins the special-case in `ordinalDay` so a refactor cannot regress.
  for (const day of [11, 12, 13]) {
    const out = formatIncidentWhenForRadio({
      date: `05/${String(day).padStart(2, "0")}/2026`,
      time: "12:00",
    });
    assert.ok(out.includes(`May ${day}th, 2026`), `expected '…May ${day}th…' but got: ${out}`);
  }
});

test("formatIncidentWhenForRadio: 21st/22nd/23rd recover the suffix after the teens", () => {
  assert.match(formatIncidentWhenForRadio({ date: "01/21/2026", time: "12:00" }), /January 21st, 2026/);
  assert.match(formatIncidentWhenForRadio({ date: "01/22/2026", time: "12:00" }), /January 22nd, 2026/);
  assert.match(formatIncidentWhenForRadio({ date: "01/23/2026", time: "12:00" }), /January 23rd, 2026/);
});

test("formatIncidentWhenForRadio: noon renders as '12 PM' and midnight as '12 AM' (not '0 AM')", () => {
  // h12 = hour % 12 || 12. Without the `|| 12`, midnight would speak as "0".
  const noon = formatIncidentWhenForRadio({ date: "06/01/2026", time: "12:00" });
  assert.match(noon, /at 12 PM/);
  const midnight = formatIncidentWhenForRadio({ date: "06/01/2026", time: "00:00" });
  assert.match(midnight, /at 12 AM/);
});

test("formatIncidentWhenForRadio: drops minutes when zero, keeps padded minutes otherwise", () => {
  // Reads "at 3 PM", not "at 3:00 PM" — short phrasing for radio.
  assert.match(
    formatIncidentWhenForRadio({ date: "06/01/2026", time: "15:00" }),
    /at 3 PM/,
  );
  // Single-digit minutes are zero-padded so it never says "at 3:5 PM".
  assert.match(
    formatIncidentWhenForRadio({ date: "06/01/2026", time: "15:05" }),
    /at 3:05 PM/,
  );
});

test("formatIncidentWhenForRadio: malformed date with valid time returns just the time part", () => {
  // Defensive: a missing/garbled date field must NOT produce 'on undefined …'.
  const out = formatIncidentWhenForRadio({ date: "not-a-date", time: "09:30" });
  assert.equal(out, "at 9:30 AM");
});

// ─── humanIncidentTypeForRadio ────────────────────────────────────────────

test("humanIncidentTypeForRadio: null / empty falls back to the generic word 'call'", () => {
  // Used in 'for a {type}' — must never produce 'for a' with nothing after.
  assert.equal(humanIncidentTypeForRadio(null), "call");
  assert.equal(humanIncidentTypeForRadio(""), "call");
  assert.equal(humanIncidentTypeForRadio("   "), "call");
});

test("humanIncidentTypeForRadio: code+dash type uses the spoken table when the leading code is known", () => {
  // "459 - Burglary in Progress" should speak the 459 phrase, not the
  // description after the dash.
  assert.match(humanIncidentTypeForRadio("459 - Burglary in Progress"), /four fifty-nine/i);
});

test("humanIncidentTypeForRadio: code+dash type with UNKNOWN code falls through to the description", () => {
  // "9999 - Custom Local Code" — there's no spoken table entry, so the
  // description text (lowercased) is what gets read aloud.
  const out = humanIncidentTypeForRadio("9999 - Custom Local Code");
  assert.equal(out, "custom local code");
});

test("humanIncidentTypeForRadio: parenthetical asides are stripped before fallback rendering", () => {
  // Strips "(Do not Dispatch)" so the officer doesn't hear filler text.
  // The bare type left over hits the "/test/i" branch → "test call".
  assert.equal(humanIncidentTypeForRadio("Test Call (Do not Dispatch)"), "test call");
});

test("humanIncidentTypeForRadio: bare free-text type without code is lowercased verbatim", () => {
  assert.equal(humanIncidentTypeForRadio("Suspicious Circumstance"), "suspicious circumstance");
});

// ─── buildCadPersonSearchParams ───────────────────────────────────────────

test("buildCadPersonSearchParams: query-only (no DOB) sets only q and limit", () => {
  const p = buildCadPersonSearchParams("Jane Doe");
  assert.equal(p.q, "Jane Doe");
  assert.equal(p.dob, undefined);
  assert.equal(p.limit, 5);
});

test("buildCadPersonSearchParams: DOB-only request fills dob but leaves q unset (not '')", () => {
  // A regression that set q = "" would 10-8 filter to "name matches empty",
  // which on some 10-8 versions returns every person in the agency.
  const p = buildCadPersonSearchParams("DOB 03/15/1985");
  assert.equal(p.dob, "03/15/1985");
  assert.equal(p.q, undefined, "q must not be set when only DOB was supplied");
});

test("buildCadPersonSearchParams: accepts 'born' as a synonym for DOB", () => {
  const p = buildCadPersonSearchParams("John Smith born 1990-01-15");
  assert.equal(p.dob, "1990-01-15");
  assert.equal(p.q, "John Smith");
});

// ─── buildCadVehicleSearchParams ──────────────────────────────────────────

test("buildCadVehicleSearchParams: falls back to free-text q when no plate or VIN is parsed", () => {
  // "black Honda Civic" has no digits, no VIN-like token → free-text search.
  // Preserves original casing so 10-8 can do its own normalisation.
  const p = buildCadVehicleSearchParams("black Honda Civic");
  assert.equal(p.q, "black Honda Civic");
  assert.equal(p.license, undefined);
  assert.equal(p.vin, undefined);
});

test("buildCadVehicleSearchParams: skips stopwords when picking a plate-looking token", () => {
  // 'HONDA' looks plate-shaped but is a stopword; '8ABC123' is the real
  // plate. A regression that removed the stopword filter would search by
  // license=HONDA and return nothing.
  const p = buildCadVehicleSearchParams("black HONDA 8ABC123");
  assert.equal(p.license, "8ABC123");
});

test("buildCadVehicleSearchParams: token must contain a digit to be treated as a plate", () => {
  // Pure-letter 6-char tokens (a colour, a model) must not become license=.
  // Without the `/\d/` guard the search would search license=BLACK and
  // silently return nothing.
  const p = buildCadVehicleSearchParams("a CAMERA was stolen");
  assert.equal(p.license, undefined);
  // Falls through to q since no VIN or plate could be parsed.
  assert.equal(p.q, "a CAMERA was stolen");
});

test("buildCadVehicleSearchParams: pulls the state code even when the rest is free text", () => {
  const p = buildCadVehicleSearchParams("OR plate XYZ12");
  assert.equal(p.state, "OR");
  assert.equal(p.license, "XYZ12");
});

// ─── pickIncidentSummaryForRadio ──────────────────────────────────────────

test("pickIncidentSummaryForRadio: summary field wins over dispositions and comments", () => {
  // The `summary` field is a dispatcher-authored one-liner; if it's present,
  // we must read THAT, not stitched-together comment text.
  const s = pickIncidentSummaryForRadio({
    summary: "Resolved on scene, no report",
    comments: [{ type: "disposition", comment: "GOA" }],
    dispositions: [{ disposition: "Other" }],
  });
  assert.equal(s, "Resolved on scene, no report");
});

test("pickIncidentSummaryForRadio: disposition notes are used when no summary is set", () => {
  const s = pickIncidentSummaryForRadio({
    dispositions: [{ disposition: "Call Cleared", notes: "Suspect detained" }],
  });
  assert.equal(s, "Suspect detained");
});

test("pickIncidentSummaryForRadio: disposition label falls through when comments have no useful row", () => {
  // The disposition label is the LAST-RESORT readback — it surfaces only
  // when there are comments but none qualify (e.g. only system noise).
  // 'Other Action' is a real label and gets lowercased for the radio.
  const s = pickIncidentSummaryForRadio({
    dispositions: [{ disposition: "Other Action" }],
    comments: [{ type: "system", comment: "Request acknowledged" }],
  });
  assert.equal(s, "other action");
});

test("pickIncidentSummaryForRadio: disposition label 'Call Cleared' is suppressed (avoids redundant 'cleared')", () => {
  // The line builder already appends "Cleared." when status == cleared, so
  // letting the summary also say "call cleared" would double the word.
  const s = pickIncidentSummaryForRadio({
    dispositions: [{ disposition: "Call Cleared" }],
    comments: [{ type: "system", comment: "Request acknowledged" }],
  });
  assert.equal(s, null);
});

test("pickIncidentSummaryForRadio: system-type comments are mostly ignored, but disposition codes survive", () => {
  // Plain system noise ("Request acknowledged") is filtered out. A system
  // comment that mentions a real disposition code (GOA / UTL / CODE 4 /
  // closed / negative) is kept and humanized.
  const s = pickIncidentSummaryForRadio({
    comments: [
      { type: "system", comment: "Request acknowledged" },
      { type: "system", comment: "Incident closed: GOA" },
    ],
  });
  assert.ok(s);
  assert.match(s!, /gone on arrival/i);
});

test("pickIncidentSummaryForRadio: long comment is truncated with an ellipsis", () => {
  // Spoken-line discipline — never let a thousand-character note drone on.
  // The implementation caps around 160 chars and appends '…'.
  const long = "a".repeat(300);
  const s = pickIncidentSummaryForRadio({
    comments: [{ type: "comment", comment: long }],
  });
  assert.ok(s);
  assert.ok(s!.length <= 161, `expected truncated summary, got length=${s!.length}`);
  assert.ok(s!.endsWith("…"), "expected ellipsis terminator on truncated summary");
});

test("pickIncidentSummaryForRadio: nothing useful → null (caller speaks just the status)", () => {
  assert.equal(pickIncidentSummaryForRadio({}), null);
  assert.equal(pickIncidentSummaryForRadio({ comments: [] }), null);
  // Only system noise → null.
  assert.equal(
    pickIncidentSummaryForRadio({
      comments: [{ type: "system", comment: "Request acknowledged" }],
    }),
    null,
  );
});

// ─── mapTen8ApiIncident ───────────────────────────────────────────────────

test("mapTen8ApiIncident: id falls through incident_id → incident_id1 → id → uuid", () => {
  // Pins the priority order. Different 10-8 versions emit different fields;
  // any regression that reorders would mis-label calls on the radio.
  assert.equal(mapTen8ApiIncident({ incident_id: "A", incident_id1: "B", id: 1, uuid: "u" }).call_id, "A");
  assert.equal(mapTen8ApiIncident({ incident_id1: "B", id: 1, uuid: "u" }).call_id, "B");
  assert.equal(mapTen8ApiIncident({ id: 1, uuid: "u" }).call_id, "1");
  assert.equal(mapTen8ApiIncident({ uuid: "u" }).call_id, "u");
  assert.equal(mapTen8ApiIncident({}).call_id, "");
});

test("mapTen8ApiIncident: composes address + city + state when no `location` is present", () => {
  // 10-8 sometimes emits the parts separately; the radio readback needs a
  // single comma-joined string. Missing parts must not produce empty commas.
  assert.equal(
    mapTen8ApiIncident({ address: "100 Main St", city: "Anaheim", state: "CA" }).location,
    "100 Main St, Anaheim, CA",
  );
  assert.equal(
    mapTen8ApiIncident({ address: "100 Main St", state: "CA" }).location,
    "100 Main St, CA",
  );
});

test("mapTen8ApiIncident: null when no location data is available", () => {
  assert.equal(mapTen8ApiIncident({}).location, null);
});

// ─── formatCadIncidentLookupRadioLine (edge branches) ────────────────────

test("formatCadIncidentLookupRadioLine: missing call_id renders 'that call' instead of 'call '", () => {
  // A regression that dropped the fallback would produce the awkward 'call '
  // (literal trailing space) and read aloud as a dropped word.
  const line = formatCadIncidentLookupRadioLine({
    type: "459 - Burglary in Progress",
    date: "06/01/2026",
    time: "10:00",
    location: "1 Pine St",
  });
  assert.match(line, /^that call /);
  assert.doesNotMatch(line, /^call /, "must NOT begin with 'call ' when no incident_id is present");
});

test("formatCadIncidentLookupRadioLine: unknown status (not cleared) appends 'Status …'", () => {
  // status = "In Progress" → "Status In Progress." trailer so the dispatcher
  // hears the live state, not silence.
  const line = formatCadIncidentLookupRadioLine({
    incident_id: "26-1000",
    type: "459 - Burglary in Progress",
    status: "In Progress",
    date: "06/01/2026",
    time: "10:00",
    location: "1 Pine St",
  });
  assert.match(line, /Status In Progress\.$/);
});

test("formatCadIncidentLookupRadioLine: status containing 'clear' renders as 'Cleared.' regardless of isClosed", () => {
  // The closed-state regex is /clear/i applied to status. A status of
  // "Cleared by Officer" must collapse to a single "Cleared." trailer so
  // the spoken line stays terse.
  const line = formatCadIncidentLookupRadioLine({
    incident_id: "26-1001",
    type: "459 - Burglary in Progress",
    status: "Cleared by Officer",
    date: "06/01/2026",
    time: "10:00",
  });
  assert.match(line, /Cleared\.$/);
});

// ─── buildCadPersonLinkBody ───────────────────────────────────────────────

test("buildCadPersonLinkBody: omits nullish fields and drops relation/notes when null", () => {
  const body = buildCadPersonLinkBody({
    relation: null,
    first_name: "Jane",
    last_name: null,
    dob: null,
    notes: null,
  });
  // Only firstName makes it onto the nested person object.
  assert.deepEqual(body.person, { firstName: "Jane" });
  assert.equal("relation" in body, false, "null relation must not be POSTed");
  assert.equal("notes" in body, false, "null notes must not be POSTed");
});

test("buildCadPersonLinkBody: an entirely-null link still produces an empty person object (not a crash)", () => {
  // Defensive: the AI dispatcher may parse a "link person to call" intent
  // with no fields populated. The body must still be a sendable JSON object.
  const body = buildCadPersonLinkBody({
    relation: null,
    first_name: null,
    last_name: null,
    dob: null,
    notes: null,
  });
  assert.deepEqual(body, { person: {} });
});
