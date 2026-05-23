/**
 * Regression tests for `server/src/ten8/incidentPayload.ts`.
 *
 * Most of these lock in the fix from commit dc631d1 ("10-8 addresses: strip
 * periods after directionals so Google geocodes them"). 10-8's geocoder reads
 * `1586 N. Batavia St` as UNAVAILABLE and surfaces it as "you must select a
 * valid call type" on close — so the address normalizer is a high blast-radius
 * piece of code: a single regression here breaks the ability to close calls
 * end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalLocationSearchQuery,
  buildSsaPropertyLocnotes,
  clampTen8Priority,
  finalizeTen8NewIncidentBody,
  formatLocationForTen8,
  normalizeAddressForTen8,
  parseUsAddressLine,
} from "../../src/ten8/incidentPayload.js";

import type { AiDispatchParseResult } from "../../src/aiDispatch/parse.js";

function parseResult(over: Partial<AiDispatchParseResult> = {}): AiDispatchParseResult {
  return {
    actionable: true,
    intent: "dispatch",
    unit: null,
    summary: "",
    confidence: 1,
    dispatcher_response: null,
    trigger_emergency_tone: false,
    recommended_action: null,
    plate_request: null,
    code: null,
    location_code: null,
    location_name: null,
    info_request: null,
    comment_text: null,
    ...over,
  };
}

test("normalizeAddressForTen8 drops the period after a directional", () => {
  assert.equal(
    normalizeAddressForTen8("1586 N. Batavia St"),
    "1586 N Batavia St",
  );
  assert.equal(
    normalizeAddressForTen8("100 S. Main St"),
    "100 S Main St",
  );
  assert.equal(
    normalizeAddressForTen8("400 W. Lincoln Ave"),
    "400 W Lincoln Avenue".replace("Avenue", "Ave"),
  );
});

test("normalizeAddressForTen8 drops the period after two-letter directionals (NE/NW/SE/SW)", () => {
  for (const dir of ["NE", "NW", "SE", "SW"] as const) {
    assert.equal(
      normalizeAddressForTen8(`200 ${dir}. Pine St`),
      `200 ${dir} Pine St`,
      `${dir}. should drop the period`,
    );
  }
});

test("normalizeAddressForTen8 drops periods after common street-type abbreviations", () => {
  const cases: Array<[string, string]> = [
    ["100 N Main St.", "100 N Main St"],
    ["200 Oak Ave., Anaheim", "200 Oak Ave, Anaheim"],
    ["1 Disney Way., Anaheim", "1 Disney Way, Anaheim"],
    ["55 Beach Blvd.", "55 Beach Blvd"],
    ["12 Riverside Dr.", "12 Riverside Dr"],
    ["88 Sunset Pkwy.", "88 Sunset Pkwy"],
  ];
  for (const [input, want] of cases) {
    assert.equal(normalizeAddressForTen8(input), want, `input: ${input}`);
  }
});

test("normalizeAddressForTen8 leaves an unknown abbreviation alone (only known street types are stripped)", () => {
  // `Mt.` is not in the street-type allowlist and is not a directional, so the period stays.
  assert.equal(
    normalizeAddressForTen8("100 Mt. Vernon Ave"),
    "100 Mt. Vernon Ave",
  );
});

test("normalizeAddressForTen8 collapses runs of whitespace and trims", () => {
  assert.equal(
    normalizeAddressForTen8("  1586  N.   Batavia   St  "),
    "1586 N Batavia St",
  );
});

test("normalizeAddressForTen8 returns '' for null/undefined/empty", () => {
  assert.equal(normalizeAddressForTen8(null), "");
  assert.equal(normalizeAddressForTen8(undefined), "");
  assert.equal(normalizeAddressForTen8(""), "");
  assert.equal(normalizeAddressForTen8("   "), "");
});

test("formatLocationForTen8 returns null when both street and city are blank", () => {
  assert.equal(formatLocationForTen8({ street: "", city: "" }), null);
  assert.equal(formatLocationForTen8({}), null);
});

test("formatLocationForTen8 builds Google-style 'street, city, ST zip' with default county for CA", () => {
  const got = formatLocationForTen8({
    street: "1586 N. Batavia St",
    city: "Orange",
    state: "ca",
    zip: "92867",
  });
  assert.deepEqual(got, {
    location: "1586 N Batavia St, Orange, CA 92867",
    streetAddress: "1586 N Batavia St",
    city: "Orange",
    state: "CA",
    zip: "92867",
    county: "Orange County",
  });
});

test("formatLocationForTen8 clamps state to two upper-case characters", () => {
  const got = formatLocationForTen8({
    street: "1 Main St",
    city: "Reno",
    state: "nevada",
  });
  assert.equal(got?.state, "NE"); // first 2 chars upper-cased
});

test("formatLocationForTen8 strips non-digits from zip and caps at 5", () => {
  const got = formatLocationForTen8({
    street: "1 Main St",
    city: "Anaheim",
    zip: "92805-1234",
  });
  assert.equal(got?.zip, "92805");
});

test("formatLocationForTen8 keeps non-CA state out of the Orange County default", () => {
  const got = formatLocationForTen8({
    street: "1 Main St",
    city: "Reno",
    state: "NV",
    zip: "89501",
  });
  assert.equal(got?.county, undefined);
});

test("formatLocationForTen8 prefers a caller-supplied county over the CA default", () => {
  const got = formatLocationForTen8({
    street: "1 Main St",
    city: "Los Angeles",
    state: "CA",
    county: "Los Angeles County",
  });
  assert.equal(got?.county, "Los Angeles County");
});

test("formatLocationForTen8 carries locnotes through when present", () => {
  const got = formatLocationForTen8({
    street: "1 Main St",
    city: "Anaheim",
    locnotes: "32-08 Anaheim Plaza",
  });
  assert.equal(got?.locnotes, "32-08 Anaheim Plaza");
});

test("buildSsaPropertyLocnotes joins account code (digits only) and property name", () => {
  assert.equal(
    buildSsaPropertyLocnotes("32-08", { name: "Anaheim Plaza" }),
    "3208 Anaheim Plaza",
  );
});

test("buildSsaPropertyLocnotes falls back to whichever piece exists when the other is empty", () => {
  assert.equal(buildSsaPropertyLocnotes("32-08", { name: "" }), "3208");
  assert.equal(buildSsaPropertyLocnotes("", { name: "Anaheim Plaza" }), "Anaheim Plaza");
  assert.equal(buildSsaPropertyLocnotes("", { name: "" }), "");
});

test("buildExternalLocationSearchQuery prefers a real location_name", () => {
  const q = buildExternalLocationSearchQuery(
    parseResult({ location_name: "Honda Center" }),
  );
  assert.equal(q, "Honda Center");
});

test("buildExternalLocationSearchQuery rejects bare account-code style location_name and falls through to the summary", () => {
  // A bare account code (`32-08`, `3208`) is not enough for Google to geocode —
  // it must be ignored so we fall through to the summary / transcript.
  const fromSummary = buildExternalLocationSearchQuery(
    parseResult({ location_name: "32-08", summary: "alarm — verifying open door" }),
  );
  assert.equal(fromSummary, "alarm — verifying open door");

  const fromAtClause = buildExternalLocationSearchQuery(
    parseResult({ location_name: "3208", summary: "961 at 100 Disney Way" }),
  );
  assert.equal(fromAtClause, "100 Disney Way");
});

test("buildExternalLocationSearchQuery extracts after 'at' in summary", () => {
  const q = buildExternalLocationSearchQuery(
    parseResult({ summary: "961 at 1806 California, white sedan" }),
  );
  assert.equal(q, "1806 California");
});

test("buildExternalLocationSearchQuery falls back to transcript when summary/name miss", () => {
  const q = buildExternalLocationSearchQuery(
    parseResult({ summary: "" }),
    "27-040 961 at 1806 California 8VWV621",
  );
  assert.equal(q, "1806 California 8VWV621");
});

test("buildExternalLocationSearchQuery returns null when nothing usable is present", () => {
  const q = buildExternalLocationSearchQuery(parseResult({ summary: "32-08" }));
  assert.equal(q, null);
});

test("parseUsAddressLine returns null on empty input", () => {
  assert.equal(parseUsAddressLine(""), null);
  assert.equal(parseUsAddressLine("   "), null);
});

test("parseUsAddressLine routes 'street, city, ST zip' into structured fields", () => {
  const got = parseUsAddressLine("1586 N Batavia St, Orange, CA 92867");
  assert.equal(got?.streetAddress, "1586 N Batavia St");
  assert.equal(got?.city, "Orange");
  assert.equal(got?.state, "CA");
  assert.equal(got?.zip, "92867");
  assert.equal(got?.location, "1586 N Batavia St, Orange, CA 92867");
});

test("parseUsAddressLine normalizes the period after a directional", () => {
  // dc631d1 regression — the period after N. must NOT survive parsing.
  const got = parseUsAddressLine("1586 N. Batavia St, Orange, CA 92867");
  assert.equal(got?.streetAddress, "1586 N Batavia St");
  assert.equal(got?.location, "1586 N Batavia St, Orange, CA 92867");
});

test("parseUsAddressLine: two-segment input goes to default city + CA", () => {
  // Only one comma — the second segment looks like a state+zip ("CA 92867"), so
  // city stays empty and we tag CA / 92867. (Matches current legacy behavior.)
  const got = parseUsAddressLine("100 Main St, CA 92867");
  assert.equal(got?.streetAddress, "100 Main St");
  assert.equal(got?.state, "CA");
  assert.equal(got?.zip, "92867");
});

test("parseUsAddressLine: single-segment input defaults to Orange, CA", () => {
  const got = parseUsAddressLine("1586 N Batavia St");
  assert.equal(got?.streetAddress, "1586 N Batavia St");
  assert.equal(got?.city, "Orange");
  assert.equal(got?.state, "CA");
});

test("clampTen8Priority clamps to 1–4 and uses fallback for invalid", () => {
  assert.equal(clampTen8Priority(1), 1);
  assert.equal(clampTen8Priority(4), 4);
  assert.equal(clampTen8Priority(0), 4); // fallback (not a valid priority)
  assert.equal(clampTen8Priority(-1), 4);
  assert.equal(clampTen8Priority(5), 4); // cap at 4
  assert.equal(clampTen8Priority(99), 4);
  assert.equal(clampTen8Priority("2"), 2);
  assert.equal(clampTen8Priority("not a number"), 4);
  assert.equal(clampTen8Priority(null), 4);
  assert.equal(clampTen8Priority(undefined), 4);
  assert.equal(clampTen8Priority(2.6), 3); // rounds
});

test("clampTen8Priority honors a custom fallback", () => {
  assert.equal(clampTen8Priority(null, 2), 2);
  assert.equal(clampTen8Priority(0, 3), 3);
});

test("finalizeTen8NewIncidentBody normalizes period-laden addresses across every shape", () => {
  // The recent fix runs a second-pass normalizer even when the body was built
  // by some other code path (Google web search, parseUsAddressLine, hand-rolled).
  // If this regresses, period-laden addresses go straight to 10-8 / Google and
  // close-fails with "Coordinates: UNAVAILABLE".
  const finalized = finalizeTen8NewIncidentBody({
    type: " 459 - Burglary in Progress ",
    location: "1586 N. Batavia St, Orange, CA 92867",
    streetAddress: "1586 N. Batavia St",
    city: "Orange",
    state: "CA",
    zip: "92867",
    priority: 5,
  });
  assert.equal(finalized.location, "1586 N Batavia St, Orange, CA 92867");
  assert.equal(finalized.streetAddress, "1586 N Batavia St");
  assert.equal(finalized.city, "Orange");
  assert.equal(finalized.type, "459 - Burglary in Progress"); // trimmed
  assert.equal(finalized.priority, 4); // 5 clamped to 4
});

test("finalizeTen8NewIncidentBody fills location when only streetAddress is set", () => {
  const finalized = finalizeTen8NewIncidentBody({
    streetAddress: "100 Disney Way",
    city: "Anaheim",
    state: "CA",
    zip: "92802",
  });
  assert.equal(finalized.location, "100 Disney Way, Anaheim, CA 92802");
});

test("finalizeTen8NewIncidentBody leaves missing location alone when streetAddress is also empty", () => {
  const finalized = finalizeTen8NewIncidentBody({ priority: 2 });
  assert.equal(finalized.location, undefined);
  assert.equal(finalized.priority, 2);
});

test("finalizeTen8NewIncidentBody defaults missing priority to 4 (not 0)", () => {
  // 10-8 New Incident API: priority is integer 1 (highest) through 4 (lowest).
  // There is no 0. Regression here would let priority=0 reach the API and 10-8
  // rejects the create.
  const finalized = finalizeTen8NewIncidentBody({ type: "Patrol Check" });
  assert.equal(finalized.priority, 4);
});
