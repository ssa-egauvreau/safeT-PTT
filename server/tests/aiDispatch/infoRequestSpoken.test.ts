/**
 * Tests for the on-air helper functions in `server/src/aiDispatch/infoRequest.ts`.
 *
 * These four helpers shape what the AI dispatcher actually says on the air for
 * `pending_calls`, `active_calls_for_unit`, `call_details`, and `unit_status`
 * info-request types. They are pure (no DB / network) but were previously
 * file-local — every regression that touched them changed dispatch audio
 * without any test surface catching it.
 *
 *   - {@link callCodeForRadio}        decides whether the dispatcher speaks
 *                                     "415" (a tight radio code) or the full
 *                                     "415 - Disturbing the Peace" (verbose,
 *                                     wrong tone for the air).
 *   - {@link shortenLocationForRadio} strips state / ZIP / "USA" so the
 *                                     dispatcher doesn't read out a 7-second
 *                                     postal-style address every readback.
 *   - {@link extractCommentsFromPayload} reads CAD narrative out of every
 *                                     vendor's webhook shape — a regression
 *                                     here makes the dispatcher say "no
 *                                     comments on the call yet" when CAD
 *                                     actually has notes.
 *   - {@link findIncidentBySubject}   picks WHICH incident the dispatcher
 *                                     reads details for when the officer
 *                                     asks "what's on the 415 at the park" —
 *                                     a regression silently answers about
 *                                     the wrong call.
 *
 * The `Ten8ActiveIncidentRow`-shaped fixtures below intentionally only set
 * the fields each helper reads (call_id / incident_type / location /
 * payload / status / priority / updated_at), with sensible defaults for the
 * rest, so the tests pin the helpers' contracts without coupling to any
 * field a future ActiveIncident extension might add.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callCodeForRadio,
  extractCommentsFromPayload,
  findIncidentBySubject,
  shortenLocationForRadio,
} from "../../src/aiDispatch/infoRequest.js";
import type { Ten8ActiveIncidentRow } from "../../src/ten8/store.js";

function inc(over: Partial<Ten8ActiveIncidentRow> = {}): Ten8ActiveIncidentRow {
  return {
    call_id: "C-0001",
    incident_type: null,
    priority: null,
    status: null,
    location: null,
    payload: null,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

// ---------- callCodeForRadio --------------------------------------------

test("callCodeForRadio: 'CODE - DESCRIPTION' returns just the code", () => {
  // The two most common 10-8 incident_type formats end up here. Locking
  // the split on a hyphen-with-spaces guard so " - " inside a description
  // (e.g. "Theft - Vehicle - Recovery") doesn't strip too much.
  assert.equal(callCodeForRadio("415 - Disturbing the Peace"), "415");
  assert.equal(callCodeForRadio("961 - Car Stop"), "961");
  assert.equal(callCodeForRadio("11-550 - DUI"), "11-550");
});

test("callCodeForRadio: handles en-dash and em-dash separators (Unicode export from CAD)", () => {
  // CAD exports occasionally hand back en-dash (U+2013) or em-dash
  // (U+2014) instead of an ASCII hyphen. The regex must accept all three
  // or "415 – Disturbing" silently spits the whole call type back to TTS.
  assert.equal(callCodeForRadio("415 \u2013 Disturbing the Peace"), "415");
  assert.equal(callCodeForRadio("961 \u2014 Car Stop"), "961");
});

test("callCodeForRadio: no separator but a leading numeric code returns the code", () => {
  // Some 10-8 deployments only ship the bare code, no description.
  // Verify the second-pass fallback `^(\d{2,4}[A-Za-z]?)` extracts it.
  assert.equal(callCodeForRadio("415"), "415");
  assert.equal(callCodeForRadio("415e"), "415e");
  assert.equal(callCodeForRadio("11550"), "11550");
});

test("callCodeForRadio: bare code of length 5+ digits with trailing description still extracts via the dash branch", () => {
  // 5+ digit codes don't match the second-pass `\d{2,4}` regex but DO
  // match the dash branch. Verify the dispatcher still says just the
  // code instead of the whole label.
  assert.equal(callCodeForRadio("11550A - DUI Arrest"), "11550A");
});

test("callCodeForRadio: a leading non-numeric label (e.g. 'Issue Notice') is read verbatim", () => {
  // The radio code is the spoken short form, so for non-coded types the
  // dispatcher must read the whole type as-is (not invent a code).
  assert.equal(callCodeForRadio("Issue Notice"), "Issue Notice");
  assert.equal(callCodeForRadio("Welfare Check"), "Welfare Check");
});

test("callCodeForRadio: empty / null / whitespace incident_type falls back to 'call'", () => {
  // If CAD ships a row without an incident_type, the dispatcher must
  // still produce SOMETHING speakable rather than an empty fragment in
  // the on-air TTS — "call at 1805 Main" beats ", at 1805 Main".
  assert.equal(callCodeForRadio(null), "call");
  assert.equal(callCodeForRadio(""), "call");
  assert.equal(callCodeForRadio("   "), "call");
});

test("callCodeForRadio: trims whitespace inside the dash split", () => {
  // The dash split captures `(.+?)\s+-\s+`. Confirm the captured group
  // is trimmed so trailing whitespace from a sloppy CAD export doesn't
  // ride through to the airwaves.
  assert.equal(callCodeForRadio("  415 - Disturbing  "), "415");
});

// ---------- shortenLocationForRadio -------------------------------------

test("shortenLocationForRadio: strips trailing 'STATE 12345' postal block", () => {
  // The most common civilian-format address that 10-8 forwards to the
  // dispatcher. The state + ZIP must drop so the on-air readback stays
  // tight.
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, CA 92805, USA"),
    "1805 Main Street, Anaheim",
  );
});

test("shortenLocationForRadio: strips ZIP+4 and 'USA' independently", () => {
  // ZIP+4 (`92805-1234`) and "USA" are stripped by separate guards. Pin
  // both — a regex that only catches one drops audibly broken text.
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, CA 92805-1234"),
    "1805 Main Street, Anaheim",
  );
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, USA"),
    "1805 Main Street, Anaheim",
  );
});

test("shortenLocationForRadio: drops a bare 2-letter state token if it slipped past as its own comma part", () => {
  // 10-8 vendors occasionally split state into its own comma part. The
  // helper recognises a 2-letter ALL-CAPS token and drops it so the
  // dispatcher doesn't read "Anaheim, CA" out loud.
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, CA"),
    "1805 Main Street, Anaheim",
  );
});

test("shortenLocationForRadio: drops a bare ZIP-only comma part", () => {
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, 92805"),
    "1805 Main Street, Anaheim",
  );
  assert.equal(
    shortenLocationForRadio("1805 Main Street, Anaheim, 92805-1234"),
    "1805 Main Street, Anaheim",
  );
});

test("shortenLocationForRadio: keeps only the first two surviving comma parts", () => {
  // Even after stripping postal blocks, the helper caps the spoken
  // address at 2 parts (street + city). A 3+ part address (e.g. POI
  // name + street + city + county) must drop trailing detail.
  assert.equal(
    shortenLocationForRadio("Honda Center, 2695 Katella Ave, Anaheim, Orange County"),
    "Honda Center, 2695 Katella Ave",
  );
});

test("shortenLocationForRadio: empty / null / whitespace returns '' (caller branches on truthiness)", () => {
  // Callers do `loc ? `at ${loc}` : ""` so this must be empty string
  // (not null, not "unknown location") to avoid an `at undefined` line
  // landing on the air.
  assert.equal(shortenLocationForRadio(null), "");
  assert.equal(shortenLocationForRadio(""), "");
  assert.equal(shortenLocationForRadio("   "), "");
});

test("shortenLocationForRadio: a single-part address (no commas) is preserved", () => {
  // Commercial CAD exports sometimes ship a single line ("1805 Main St")
  // with no comma at all. That must pass through unchanged.
  assert.equal(shortenLocationForRadio("1805 Main St"), "1805 Main St");
});

// ---------- extractCommentsFromPayload ----------------------------------

test("extractCommentsFromPayload: reads a string 'comments' field from incident.* (canonical 10-8 shape)", () => {
  const out = extractCommentsFromPayload({
    action: "create",
    incident: { comments: "RP states male suspect fled north" },
  });
  assert.equal(out, "RP states male suspect fled north");
});

test("extractCommentsFromPayload: also reads from the payload root (older webhook shape)", () => {
  // Same field-name precedence applies whether the payload nests the
  // incident under `incident:` or ships the fields at the root.
  const out = extractCommentsFromPayload({
    comments: "RP states male suspect fled north",
  });
  assert.equal(out, "RP states male suspect fled north");
});

test("extractCommentsFromPayload: trims whitespace and drops empty values", () => {
  assert.equal(
    extractCommentsFromPayload({ incident: { comments: "  on scene  " } }),
    "on scene",
  );
  assert.equal(extractCommentsFromPayload({ incident: { comments: "   " } }), null);
});

test("extractCommentsFromPayload: honours the documented field-name fallback order", () => {
  // First non-empty key wins. Locking the order so a future refactor
  // doesn't accidentally start preferring "description" over the more
  // dispatcher-relevant "comments".
  const order = [
    "comments",
    "comment",
    "narrative",
    "notes",
    "remarks",
    "details",
    "description",
    "callNotes",
    "call_notes",
  ];
  for (const key of order) {
    const out = extractCommentsFromPayload({
      incident: { [key]: `from ${key}` },
    });
    assert.equal(out, `from ${key}`, `must read from incident.${key}`);
  }
});

test("extractCommentsFromPayload: 'comments' wins over 'description' on the same incident (priority lock)", () => {
  const out = extractCommentsFromPayload({
    incident: { comments: "RP details", description: "Disturbing the Peace" },
  });
  assert.equal(out, "RP details", "comments must beat description on the same row");
});

test("extractCommentsFromPayload: array of strings joins last 3 with '; '", () => {
  // CAD shops that ship comments as an append-only array — the spoken
  // line takes the last 3 (most recent) entries so the dispatcher
  // doesn't read a 20-line narrative out loud.
  const out = extractCommentsFromPayload({
    incident: {
      comments: [
        "first entry",
        "second entry",
        "third entry",
        "fourth entry",
        "fifth entry",
      ],
    },
  });
  assert.equal(out, "third entry; fourth entry; fifth entry");
});

test("extractCommentsFromPayload: array of objects pulls .comment / .text / .note / .body / .message / .value", () => {
  // Exercise every documented per-item field so a regression that
  // dropped one silently strips comments from that vendor's exports.
  for (const field of ["comment", "text", "note", "body", "message", "value"]) {
    const out = extractCommentsFromPayload({
      incident: { comments: [{ [field]: `via ${field}` }] },
    });
    assert.equal(out, `via ${field}`, `array of objects must read .${field}`);
  }
});

test("extractCommentsFromPayload: array with non-strings / unknown shapes filters them out", () => {
  // Mixing legitimate comment strings with junk (numbers, booleans,
  // empty objects) must not poison the joined output.
  const out = extractCommentsFromPayload({
    incident: { comments: ["good one", 42, null, {}, "another good"] },
  });
  assert.equal(out, "good one; another good");
});

test("extractCommentsFromPayload: object with a .comment field reads through it (single-comment shape)", () => {
  const out = extractCommentsFromPayload({
    incident: { comments: { comment: "single object form" } },
  });
  assert.equal(out, "single object form");
});

test("extractCommentsFromPayload: caps spoken text at 600 chars (airtime guard)", () => {
  // The dispatcher's TTS path itself caps at ~2000 chars but this guard
  // is the airtime-friendly tighter limit so a runaway narrative doesn't
  // land 90 seconds of speech on the channel.
  const long = "A".repeat(2000);
  const out = extractCommentsFromPayload({ incident: { comments: long } });
  assert.ok(out);
  assert.equal(out!.length, 600);
});

test("extractCommentsFromPayload: returns null for missing / wrong-shape input (never throws)", () => {
  // The helper is called every `call_details` lookup. It must tolerate
  // every shape we've seen in production without throwing — a throw
  // here surfaces as a 500 on the test page or kills the dispatcher
  // reply mid-render.
  assert.equal(extractCommentsFromPayload(null), null);
  assert.equal(extractCommentsFromPayload(undefined), null);
  assert.equal(extractCommentsFromPayload("string payload"), null);
  assert.equal(extractCommentsFromPayload(123), null);
  assert.equal(extractCommentsFromPayload({}), null);
  assert.equal(extractCommentsFromPayload({ incident: {} }), null);
  assert.equal(
    extractCommentsFromPayload({ incident: { comments: 42 } }),
    null,
    "non-string scalar comments must not coerce",
  );
});

// ---------- findIncidentBySubject ---------------------------------------

test("findIncidentBySubject: blank subject returns the only active incident, else null", () => {
  // Documented behaviour: when the officer doesn't say which call (just
  // "what's on the call"), the dispatcher reads back the lone open
  // call. With 0 or 2+ open calls this is ambiguous, so return null.
  const single = [inc({ call_id: "C-501", incident_type: "415" })];
  assert.equal(findIncidentBySubject(single, null)?.call_id, "C-501");
  assert.equal(findIncidentBySubject(single, "")?.call_id, "C-501");
  assert.equal(findIncidentBySubject(single, "   ")?.call_id, "C-501");

  const many = [
    inc({ call_id: "C-501" }),
    inc({ call_id: "C-502" }),
  ];
  assert.equal(
    findIncidentBySubject(many, null),
    null,
    "ambiguous null-subject must NOT pick the first call silently",
  );
  assert.equal(findIncidentBySubject([], null), null, "no calls → null");
});

test("findIncidentBySubject: exact (case-insensitive) call_id match wins over substring", () => {
  // Pin the priority order: an exact call_id match returns that row
  // even when a different row's incident_type or location would also
  // substring-match the subject.
  const list = [
    inc({ call_id: "C-501", incident_type: "415" }),
    inc({ call_id: "415", incident_type: "Other" }),
  ];
  assert.equal(findIncidentBySubject(list, "c-501")?.call_id, "C-501");
  assert.equal(findIncidentBySubject(list, "C-501")?.call_id, "C-501");
});

test("findIncidentBySubject: digits-only call_id match (≥3 digits) catches 'call 501' phrasing", () => {
  // Officer says "details on call 501" — the spoken digits don't match
  // "C-501" verbatim but the digit-strip equivalence does. This is the
  // documented second-priority rule.
  const list = [
    inc({ call_id: "C-501", incident_type: "415" }),
    inc({ call_id: "C-999", incident_type: "Other" }),
  ];
  assert.equal(findIncidentBySubject(list, "501")?.call_id, "C-501");
  // 2-digit-only subject must NOT trigger the digit-strip equivalence
  // path (the >=3 length guard is what stops "10" from accidentally
  // resolving "C-1010" via stripped-digit equality). A 2-digit subject
  // that ALSO doesn't substring-match a call_id falls through to null.
  const noSubstring = [
    inc({ call_id: "C-AAA", incident_type: "415" }),
  ];
  assert.equal(findIncidentBySubject(noSubstring, "01"), null);
});

test("findIncidentBySubject: full-substring match on the combined call_id + incident_type + location haystack", () => {
  // Officer says "the disturbance at honda center" — must match by
  // location words even though no call_id is mentioned.
  const list = [
    inc({ call_id: "C-501", incident_type: "415 - Disturbing the Peace", location: "Honda Center" }),
    inc({ call_id: "C-502", incident_type: "961 - Car Stop", location: "1805 Main" }),
  ];
  assert.equal(
    findIncidentBySubject(list, "honda center")?.call_id,
    "C-501",
    "location substring on the haystack must resolve",
  );
});

test("findIncidentBySubject: all-words substring match (every >2-char token must appear)", () => {
  // The `words` branch only matches when EVERY non-trivial token is
  // somewhere in the haystack. This protects against a 1-of-many
  // accidental match (e.g. "the park" matching every incident with
  // "the" in it).
  const list = [
    inc({ call_id: "C-501", incident_type: "415", location: "Pearson Park" }),
    inc({ call_id: "C-502", incident_type: "415", location: "Honda Center" }),
  ];
  assert.equal(
    findIncidentBySubject(list, "415 at pearson park")?.call_id,
    "C-501",
    "all words must appear (415 + pearson + park) → unique match",
  );
});

test("findIncidentBySubject: 1- and 2-letter tokens are dropped before the all-words check", () => {
  // The .filter(w => w.length > 2) guard means short connector words
  // ("at", "on", "in", "the") don't constrain the match. Verify a
  // subject made entirely of short tokens still falls through to null.
  const list = [
    inc({ call_id: "C-501", incident_type: "415", location: "Pearson Park" }),
    inc({ call_id: "C-502", incident_type: "415", location: "Honda Center" }),
  ];
  // After dropping short tokens, "in at on" has zero length-3+ words →
  // the .every() check on an empty list trivially returns true, but
  // the `words.length > 0` guard kills the branch. Confirm the lookup
  // returns null in that pathological case.
  assert.equal(findIncidentBySubject(list, "in at on"), null);
});

test("findIncidentBySubject: returns null when nothing matches", () => {
  const list = [
    inc({ call_id: "C-501", incident_type: "415", location: "Pearson Park" }),
  ];
  assert.equal(findIncidentBySubject(list, "C-999"), null);
  assert.equal(findIncidentBySubject(list, "not-an-incident-type"), null);
});

test("findIncidentBySubject: tolerates null incident_type / location on a row (no haystack contribution)", () => {
  // Common in early-life CAD rows — incident_type and location can
  // both be null while the row is still active. The helper must not
  // throw and must still match on call_id.
  const list = [
    inc({ call_id: "C-501", incident_type: null, location: null }),
    inc({ call_id: "C-502", incident_type: "415", location: "Pearson Park" }),
  ];
  assert.equal(findIncidentBySubject(list, "501")?.call_id, "C-501");
  // A subject mentioning only the null row's data resolves to the
  // populated row by haystack substring — no exception.
  assert.equal(findIncidentBySubject(list, "pearson")?.call_id, "C-502");
});
