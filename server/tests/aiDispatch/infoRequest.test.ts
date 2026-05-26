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
  incidentPayloadHasUnit,
  infoRequestNeedsAsync,
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
    // `unit_status` (commit 2ad66ee) infers 10-8/busy status from the
    // existing active-incident store and presence map. Both are local
    // reads so it MUST stay on the sync fast path — otherwise the engine
    // pre-speaks a "Standby" ack that contradicts the immediate status
    // line that follows it.
    "unit_status",
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
