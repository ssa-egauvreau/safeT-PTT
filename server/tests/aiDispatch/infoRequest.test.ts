/**
 * Tests for the pure helpers in `server/src/aiDispatch/infoRequest.ts`.
 *
 * Why these matter:
 *   - `incidentPayloadHasUnit` is the single point of truth for "is this
 *     officer already assigned to this incident". It drives the
 *     comment-only-vs-new-incident routing in outWithCad and several info
 *     responses ("active_calls_for_unit", call_details). A regression
 *     here mis-attributes incidents or silently drops legitimately
 *     assigned units.
 *   - `buildInfoRequestAck` is the immediate "standby" the AI speaks when
 *     it kicks off an async info lookup (so the channel doesn't sit dead
 *     waiting for a web search to come back).
 *   - `infoRequestNeedsAsync` classifies which info_request types need
 *     the async standby ack vs which can be answered synchronously.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInfoRequestAck,
  callCodeForRadio,
  extractCommentsFromPayload,
  findIncidentBySubject,
  incidentPayloadHasUnit,
  infoRequestNeedsAsync,
  shortenLocationForRadio,
} from "../../src/aiDispatch/infoRequest.js";
import type { InfoRequestFields } from "../../src/aiDispatch/parse.js";

// ---------- incidentPayloadHasUnit --------------------------------------

function withPayload(payload: unknown) {
  return { payload };
}

test("incidentPayloadHasUnit matches a unit nested under incident.units[*].unit (canonical webhook shape)", () => {
  const inc = withPayload({
    action: "create",
    incident: { units: [{ unit: "352" }, { unit: "040" }] },
  });
  assert.equal(incidentPayloadHasUnit(inc, "352"), true);
  assert.equal(incidentPayloadHasUnit(inc, "040"), true);
});

test("incidentPayloadHasUnit also handles units list at the payload root (older webhook shape)", () => {
  // Webhook history has shipped both root-level and incident-nested shapes;
  // both must keep working.
  const inc = withPayload({ units: [{ unit: "352" }] });
  assert.equal(incidentPayloadHasUnit(inc, "352"), true);
});

test("incidentPayloadHasUnit normalizes the 27- prefix and lowercase on both sides", () => {
  const inc = withPayload({ incident: { units: [{ unit: "27-040" }] } });
  // Caller passes either bare or prefixed form — both must match.
  assert.equal(incidentPayloadHasUnit(inc, "040"), true);
  assert.equal(incidentPayloadHasUnit(inc, "27-040"), true);
  // Casing must not block a match (some integrations send uppercase).
  assert.equal(incidentPayloadHasUnit(withPayload({ incident: { units: [{ unit: "ADAM-5" }] } }), "adam-5"), true);
});

test("incidentPayloadHasUnit reads alternate id keys (id / unitId / unit_id)", () => {
  const variants = [
    withPayload({ incident: { units: [{ id: "352" }] } }),
    withPayload({ incident: { units: [{ unitId: "352" }] } }),
    withPayload({ incident: { units: [{ unit_id: "352" }] } }),
  ];
  for (const v of variants) {
    assert.equal(incidentPayloadHasUnit(v, "352"), true);
  }
});

test("incidentPayloadHasUnit handles the capitalized 'Units' key (10-8 export convention)", () => {
  const inc = withPayload({ incident: { Units: [{ unit: "352" }] } });
  assert.equal(incidentPayloadHasUnit(inc, "352"), true);
});

test("incidentPayloadHasUnit returns false when payload shape is missing/wrong", () => {
  assert.equal(incidentPayloadHasUnit(withPayload(null), "352"), false);
  assert.equal(incidentPayloadHasUnit(withPayload(""), "352"), false);
  assert.equal(incidentPayloadHasUnit(withPayload({}), "352"), false);
  assert.equal(incidentPayloadHasUnit(withPayload({ incident: {} }), "352"), false);
  // units is not an array
  assert.equal(incidentPayloadHasUnit(withPayload({ incident: { units: "352" } }), "352"), false);
  // unit row entries that aren't objects
  assert.equal(
    incidentPayloadHasUnit(withPayload({ incident: { units: [null, 1, "352"] } }), "352"),
    false,
    "must not match scalar entries — 10-8 always nests {unit:'...'}",
  );
});

test("incidentPayloadHasUnit returns false when targetUnit is blank (never silently match every incident)", () => {
  const inc = withPayload({ incident: { units: [{ unit: "352" }] } });
  assert.equal(incidentPayloadHasUnit(inc, ""), false);
  // NOTE: targetUnit "   " currently falls through to a normalized "" match;
  // we don't lock the whitespace-only contract here because the caller
  // always trims first (outWithCad does .trim()).
});

test("incidentPayloadHasUnit returns false when no unit in the list matches", () => {
  const inc = withPayload({ incident: { units: [{ unit: "352" }, { unit: "040" }] } });
  assert.equal(incidentPayloadHasUnit(inc, "999"), false);
  assert.equal(incidentPayloadHasUnit(inc, "27-999"), false);
});

// ---------- buildInfoRequestAck -----------------------------------------

test("buildInfoRequestAck: patrol callsign drops the 27- prefix", () => {
  assert.equal(buildInfoRequestAck("27-205"), "205, copy. Standby.");
});

test("buildInfoRequestAck: 27-0[0-3]0 command staff keep the 27- prefix on the air", () => {
  // Mirrors the dispatchAck rule — only 010/020/030 keep the prefix
  // here (NOT every 27-0XX).
  for (const cs of ["27-010", "27-020", "27-030"]) {
    assert.equal(buildInfoRequestAck(cs), `${cs}, copy. Standby.`);
  }
});

test("buildInfoRequestAck: 27-040 patrol-side drops the 27- prefix (different rule from plate readback)", () => {
  // Important: dispatchAck/infoRequestAck use 27-0[0-3]0 as command staff,
  // so 27-040 drops the prefix here even though it KEEPS the prefix in
  // plate readbacks. Locking both rules in their own tests guards against
  // someone unifying them in the wrong direction.
  assert.equal(buildInfoRequestAck("27-040"), "040, copy. Standby.");
});

test("buildInfoRequestAck: null / undefined unit falls back to 'Copy. Standby.'", () => {
  assert.equal(buildInfoRequestAck(null), "Copy. Standby.");
  assert.equal(buildInfoRequestAck(undefined), "Copy. Standby.");
});

// ---------- infoRequestNeedsAsync ---------------------------------------

test("infoRequestNeedsAsync: web-lookup types return true (engine speaks 'standby' first)", () => {
  const yes: InfoRequestFields["type"][] = [
    "phone",
    "contact",
    "external_address",
    "legal_code",
    "general_query",
  ];
  for (const t of yes) {
    assert.equal(
      infoRequestNeedsAsync({ type: t, account_code: null, subject: "x" }),
      true,
      `${t} must be async`,
    );
  }
});

test("infoRequestNeedsAsync: local / DB-backed types return false (answered synchronously)", () => {
  const no: InfoRequestFields["type"][] = [
    "address", // local SSA property lookup
    "pending_calls", // local CAD store
    "active_calls_for_unit",
    "call_details",
    "unit_location", // local position store + reverse geocode but treated sync at this layer
    "unit_status", // local CAD assigned-call + positions; inferred synchronously
    "unknown",
  ];
  for (const t of no) {
    assert.equal(
      infoRequestNeedsAsync({ type: t, account_code: null, subject: null }),
      false,
      `${t} must NOT be async`,
    );
  }
});

// ---------- callCodeForRadio --------------------------------------------

test("callCodeForRadio: strips '<code> - <description>' down to the leading code", () => {
  // The radio convention is "415", not "415 - Disturbing the Peace". The
  // call-details responder reads this on the air so dispatchers don't
  // narrate the long-form description every time.
  assert.equal(callCodeForRadio("415 - Disturbing the Peace"), "415");
  assert.equal(callCodeForRadio("961 - Car Stop"), "961");
  assert.equal(callCodeForRadio("242 - Battery"), "242");
});

test("callCodeForRadio: tolerates en-dash / em-dash separators (CAD copy/paste reality)", () => {
  // Some 10-8 incident types arrive with unicode dashes when CAD operators
  // copy/paste — don't accidentally read those as part of the code.
  assert.equal(callCodeForRadio("415 \u2013 Disturbing the Peace"), "415");
  assert.equal(callCodeForRadio("415 \u2014 Disturbing the Peace"), "415");
});

test("callCodeForRadio: pulls a bare leading code with a letter suffix (e.g. '415A')", () => {
  // 415A / 415e suffixes are common in CA — the bare-leading-code branch
  // must keep the letter or dispatchers hear the wrong call type.
  assert.equal(callCodeForRadio("415A"), "415A");
  assert.equal(callCodeForRadio("415e some context"), "415e");
});

test("callCodeForRadio: returns the type as-is when there is no leading code", () => {
  // Free-form types ("Issue Notice", "Alarm") have no numeric code to
  // strip; speak them verbatim so the dispatcher still hears what kind
  // of call it is.
  assert.equal(callCodeForRadio("Issue Notice"), "Issue Notice");
  assert.equal(callCodeForRadio("Alarm"), "Alarm");
});

test("callCodeForRadio: null / blank input returns the sentinel 'call'", () => {
  // The caller stitches this into "you're on <code> at <loc>" — an empty
  // string would produce "you're on  at <loc>" which is jarring on the
  // air. The sentinel makes the line speakable.
  assert.equal(callCodeForRadio(null), "call");
  assert.equal(callCodeForRadio(""), "call");
  assert.equal(callCodeForRadio("   "), "call");
});

// ---------- shortenLocationForRadio -------------------------------------

test("shortenLocationForRadio: drops state, zip, USA, and trims to street + city", () => {
  // The on-air convention is street + city; reading the state and zip
  // back wastes airtime and makes the line hard to follow.
  assert.equal(
    shortenLocationForRadio("1805 Main St, Anaheim, CA 92805, USA"),
    "1805 Main St, Anaheim",
  );
  assert.equal(
    shortenLocationForRadio("123 Elm Ave, Garden Grove, CA 92840"),
    "123 Elm Ave, Garden Grove",
  );
});

test("shortenLocationForRadio: handles zip+4 (#####-####)", () => {
  // CAD addresses sometimes carry the ZIP+4 long form — must be stripped
  // the same way as plain 5-digit ZIPs.
  assert.equal(
    shortenLocationForRadio("1805 Main St, Anaheim, CA 92805-1234, USA"),
    "1805 Main St, Anaheim",
  );
});

test("shortenLocationForRadio: returns '' for null / blank input", () => {
  // Caller stitches this into "at <loc>" — empty string is the contract
  // for "no location to speak".
  assert.equal(shortenLocationForRadio(null), "");
  assert.equal(shortenLocationForRadio(""), "");
  assert.equal(shortenLocationForRadio("   "), "");
});

test("shortenLocationForRadio: caps the output to two leading parts even with extra commas", () => {
  // Some CAD systems emit "123 Elm Ave, Apt 4B, Garden Grove, CA, 92840".
  // The radio line should still be street + city max — the Apt 4B is
  // useful in CAD but burns airtime on the radio.
  const out = shortenLocationForRadio("123 Elm Ave, Apt 4B, Garden Grove, CA 92840");
  // Two leading parts after filtering; state/zip already stripped.
  const parts = out.split(",").map((p) => p.trim()).filter(Boolean);
  assert.equal(parts.length, 2, `expected 2 parts, got ${parts.length}: ${out}`);
});

// ---------- extractCommentsFromPayload ----------------------------------

test("extractCommentsFromPayload: pulls 'comments' string from nested incident.comments", () => {
  // Canonical 10-8 webhook shape — comments live under incident.comments.
  const out = extractCommentsFromPayload({
    action: "create",
    incident: { comments: "RP states subject is armed." },
  });
  assert.equal(out, "RP states subject is armed.");
});

test("extractCommentsFromPayload: tries alternate field names ('narrative', 'notes', etc.)", () => {
  // CAD vendors disagree on the field name. The extractor must try
  // several or call details come back blank on a perfectly-populated
  // payload.
  for (const key of ["comment", "narrative", "notes", "remarks", "details", "description"]) {
    const out = extractCommentsFromPayload({
      incident: { [key]: `from ${key}` },
    });
    assert.equal(out, `from ${key}`, `expected to pull from incident.${key}`);
  }
});

test("extractCommentsFromPayload: also checks the payload root (older webhook shape)", () => {
  // Webhook history has shipped both root-level and incident-nested
  // shapes — both must keep working.
  assert.equal(
    extractCommentsFromPayload({ comments: "root-level note" }),
    "root-level note",
  );
});

test("extractCommentsFromPayload: handles array of comment objects (returns last 3 joined)", () => {
  // Some CAD systems ship a comments array of {text/comment/note}. The
  // helper takes the last 3 entries so dispatchers hear the most recent
  // updates rather than a wall of historic text.
  const out = extractCommentsFromPayload({
    incident: {
      comments: [
        { text: "old 1" },
        { text: "old 2" },
        { text: "recent 1" },
        { text: "recent 2" },
        { text: "recent 3" },
      ],
    },
  });
  assert.equal(out, "recent 1; recent 2; recent 3");
});

test("extractCommentsFromPayload: caps output at 600 chars (radio airtime guard)", () => {
  // A 5000-char narrative on a long-running incident would dominate the
  // air — cap at 600 chars so the AI's spoken reply stays under ~20s.
  const huge = "X".repeat(2000);
  const out = extractCommentsFromPayload({ incident: { comments: huge } });
  assert.ok(out);
  assert.equal(out!.length, 600);
});

test("extractCommentsFromPayload: returns null when no recognized field has content", () => {
  // Caller switches on null to speak "no comments on the call yet" —
  // false-positives here would make the AI say "comments: undefined" or
  // worse, leak an internal field name on the air.
  assert.equal(extractCommentsFromPayload(null), null);
  assert.equal(extractCommentsFromPayload(undefined), null);
  assert.equal(extractCommentsFromPayload({}), null);
  assert.equal(extractCommentsFromPayload({ incident: {} }), null);
  assert.equal(extractCommentsFromPayload({ incident: { comments: "" } }), null);
  assert.equal(extractCommentsFromPayload({ incident: { comments: "   " } }), null);
});

// ---------- findIncidentBySubject ---------------------------------------

function makeIncident(over: {
  call_id?: string;
  incident_type?: string | null;
  location?: string | null;
  payload?: unknown;
  status?: string | null;
}) {
  return {
    call_id: over.call_id ?? "C-001",
    incident_type: over.incident_type ?? null,
    location: over.location ?? null,
    payload: over.payload ?? null,
    status: over.status ?? null,
  };
}

test("findIncidentBySubject: empty / blank subject + single open call → returns that call", () => {
  // "What's on my call?" with one open call should resolve to it without
  // requiring the officer to name it. Important UX shortcut.
  const inc = makeIncident({ call_id: "C-001", incident_type: "415" });
  assert.equal(findIncidentBySubject([inc], null)?.call_id, "C-001");
  assert.equal(findIncidentBySubject([inc], "")?.call_id, "C-001");
  assert.equal(findIncidentBySubject([inc], "   ")?.call_id, "C-001");
});

test("findIncidentBySubject: blank subject + multiple open calls → returns null (ambiguous)", () => {
  // The AI must NOT guess when there are several open calls and the
  // officer didn't name one — that would silently speak details for the
  // wrong call on a felony stop.
  const a = makeIncident({ call_id: "C-001" });
  const b = makeIncident({ call_id: "C-002" });
  assert.equal(findIncidentBySubject([a, b], null), null);
  assert.equal(findIncidentBySubject([a, b], ""), null);
});

test("findIncidentBySubject: matches call_id exactly (case-insensitive)", () => {
  const a = makeIncident({ call_id: "ABC-123" });
  const b = makeIncident({ call_id: "XYZ-999" });
  assert.equal(findIncidentBySubject([a, b], "ABC-123")?.call_id, "ABC-123");
  assert.equal(findIncidentBySubject([a, b], "abc-123")?.call_id, "ABC-123");
});

test("findIncidentBySubject: matches by digits when caller spoke just the number", () => {
  // Dispatcher speaks "twenty-three forty-five" → STT renders "2345".
  // The call_id stored as "C-2345" must still resolve from "2345".
  const inc = makeIncident({ call_id: "C-2345" });
  assert.equal(findIncidentBySubject([inc], "2345")?.call_id, "C-2345");
});

test("findIncidentBySubject: matches by call type / location words when call_id misses", () => {
  // "what's on the 415" or "what's on the disturbance at Main" — the
  // text-match fallback resolves these without requiring the call number.
  const a = makeIncident({ call_id: "C-001", incident_type: "415 - Disturbance", location: "1805 Main St, Anaheim" });
  const b = makeIncident({ call_id: "C-002", incident_type: "961 - Car Stop", location: "Disney Way" });
  assert.equal(findIncidentBySubject([a, b], "415")?.call_id, "C-001");
  assert.equal(findIncidentBySubject([a, b], "main st")?.call_id, "C-001");
  assert.equal(findIncidentBySubject([a, b], "disney way")?.call_id, "C-002");
});

test("findIncidentBySubject: returns null when nothing matches", () => {
  const a = makeIncident({ call_id: "C-001", incident_type: "415" });
  const b = makeIncident({ call_id: "C-002", incident_type: "961" });
  assert.equal(findIncidentBySubject([a, b], "242"), null);
  assert.equal(findIncidentBySubject([a, b], "nonexistent-string"), null);
});
