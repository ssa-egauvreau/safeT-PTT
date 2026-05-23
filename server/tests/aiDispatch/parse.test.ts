/**
 * Tests for `server/src/aiDispatch/parse.ts` `normalizeAiDispatchParse`.
 *
 * This function is the trust boundary between an LLM completion and the rest of
 * the dispatch pipeline. A regression that lets garbage through can dispatch
 * units, create CAD incidents, or fire the emergency tone on bad input. A
 * regression that's overly strict makes the AI dispatcher silently fall back
 * to the "stay quiet" path on legitimate transmissions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeAiDispatchParse } from "../../src/aiDispatch/parse.js";

function base(): Record<string, unknown> {
  return {
    actionable: true,
    intent: "dispatch",
    unit: "27-040",
    summary: "Routine traffic stop",
    confidence: 0.92,
  };
}

test("normalizeAiDispatchParse: rejects non-objects", () => {
  assert.equal(normalizeAiDispatchParse(null), null);
  assert.equal(normalizeAiDispatchParse(undefined), null);
  assert.equal(normalizeAiDispatchParse("not an object"), null);
  assert.equal(normalizeAiDispatchParse(42), null);
  assert.equal(normalizeAiDispatchParse([base()]), null); // arrays are not parses
});

test("normalizeAiDispatchParse: requires actionable boolean", () => {
  const raw = { ...base(), actionable: "yes" };
  assert.equal(normalizeAiDispatchParse(raw), null);
});

test("normalizeAiDispatchParse: rejects unknown intent strings", () => {
  const raw = { ...base(), intent: "freestyle" };
  assert.equal(normalizeAiDispatchParse(raw), null);
});

test("normalizeAiDispatchParse: rejects missing summary", () => {
  const raw = { ...base() };
  delete raw.summary;
  assert.equal(normalizeAiDispatchParse(raw), null);
  raw.summary = "";
  assert.equal(normalizeAiDispatchParse(raw), null);
  raw.summary = "   ";
  assert.equal(normalizeAiDispatchParse(raw), null);
});

test("normalizeAiDispatchParse: rejects non-numeric / NaN confidence", () => {
  const noConf = { ...base() };
  delete noConf.confidence;
  assert.equal(normalizeAiDispatchParse(noConf), null);

  const stringConf = { ...base(), confidence: "0.5" };
  assert.equal(normalizeAiDispatchParse(stringConf), null);

  const nanConf = { ...base(), confidence: Number.NaN };
  assert.equal(normalizeAiDispatchParse(nanConf), null);
});

test("normalizeAiDispatchParse: every documented intent passes the gate", () => {
  for (const intent of [
    "status_change",
    "dispatch",
    "on_scene",
    "clear",
    "request_info",
    "acknowledgment",
    "emergency",
    "emergency_clear",
    "inter_unit",
    "info_request_912",
    "info_clear_913",
    "plate_request",
    "plate_transmit",
    "chitchat",
    "unknown",
  ]) {
    const out = normalizeAiDispatchParse({ ...base(), intent });
    assert.ok(out, `expected intent "${intent}" to be accepted`);
    assert.equal(out!.intent, intent);
  }
});

test("normalizeAiDispatchParse: minimal valid input fills defaults", () => {
  const out = normalizeAiDispatchParse(base());
  assert.ok(out);
  assert.equal(out!.actionable, true);
  assert.equal(out!.intent, "dispatch");
  assert.equal(out!.unit, "27-040");
  assert.equal(out!.summary, "Routine traffic stop");
  assert.equal(out!.confidence, 0.92);
  assert.equal(out!.dispatcher_response, null);
  assert.equal(out!.trigger_emergency_tone, false);
  assert.equal(out!.recommended_action, null);
  assert.equal(out!.plate_request, null);
  assert.equal(out!.code, null);
  assert.equal(out!.location_code, null);
  assert.equal(out!.location_name, null);
  assert.equal(out!.info_request, null);
  assert.equal(out!.comment_text, null);
});

test("normalizeAiDispatchParse: trims string fields and drops blanks", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    summary: "  noisy summary  ",
    dispatcher_response: "  Copy 27-040.  ",
    recommended_action: "   ",
    unit: "  27-040  ",
    code: " 415 ",
    location_name: "  Honda Center  ",
    comment_text: "  STARTED FOOT PURSUIT  ",
  });
  assert.ok(out);
  assert.equal(out!.summary, "noisy summary");
  assert.equal(out!.dispatcher_response, "Copy 27-040.");
  assert.equal(out!.recommended_action, null);
  assert.equal(out!.unit, "27-040");
  assert.equal(out!.code, "415");
  assert.equal(out!.location_name, "Honda Center");
  assert.equal(out!.comment_text, "STARTED FOOT PURSUIT");
});

test("normalizeAiDispatchParse: comment_text is truncated to 240 chars (10-8 comment guard)", () => {
  const huge = "A".repeat(500);
  const out = normalizeAiDispatchParse({ ...base(), comment_text: huge });
  assert.ok(out);
  assert.equal(out!.comment_text!.length, 240);
});

test("normalizeAiDispatchParse: trigger_emergency_tone is strict-true only", () => {
  const t = normalizeAiDispatchParse({ ...base(), trigger_emergency_tone: true });
  assert.equal(t?.trigger_emergency_tone, true);
  // Anything else collapses to false so a truthy string can't fire the tone.
  for (const v of ["true", 1, "1", "yes"]) {
    const out = normalizeAiDispatchParse({ ...base(), trigger_emergency_tone: v });
    assert.equal(out?.trigger_emergency_tone, false, `value ${JSON.stringify(v)} must NOT fire the tone`);
  }
});

test("normalizeAiDispatchParse: location_code only accepts 3-5 digit account codes", () => {
  for (const ok of ["100", "1019", "32208"]) {
    const out = normalizeAiDispatchParse({ ...base(), location_code: ok });
    assert.equal(out?.location_code, ok);
  }
  for (const bad of ["12", "123456", "32-08", "abc", " 100 "]) {
    // " 100 " trims to "100" which is valid; verify trimming.
    const expected = bad.trim() === "100" ? "100" : null;
    const out = normalizeAiDispatchParse({ ...base(), location_code: bad });
    assert.equal(out?.location_code ?? null, expected, `location_code "${bad}"`);
  }
});

test("normalizeAiDispatchParse: plate_request uppercases and strips spaces / dashes from VIN", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    plate_request: { plate: "8vwv621", state: "ca", vin: "1hg-bh41 jxmn-109186" },
  });
  assert.ok(out?.plate_request);
  assert.equal(out!.plate_request!.plate, "8VWV621");
  assert.equal(out!.plate_request!.state, "CA");
  assert.equal(out!.plate_request!.vin, "1HGBH41JXMN109186");
});

test("normalizeAiDispatchParse: drops plate_request when both plate and VIN are empty", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    plate_request: { plate: "", state: "CA", vin: "" },
  });
  assert.equal(out?.plate_request, null);
});

test("normalizeAiDispatchParse: keeps plate_request when only VIN is supplied", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    plate_request: { plate: null, state: null, vin: "1HGBH41JXMN109186" },
  });
  assert.ok(out?.plate_request);
  assert.equal(out!.plate_request!.plate, null);
  assert.equal(out!.plate_request!.vin, "1HGBH41JXMN109186");
});

test("normalizeAiDispatchParse: only documented info_request types are accepted", () => {
  for (const type of [
    "address",
    "external_address",
    "pending_calls",
    "active_calls_for_unit",
    "call_details",
    "unit_location",
    "phone",
    "contact",
    "legal_code",
    "general_query",
    "unknown",
  ]) {
    const out = normalizeAiDispatchParse({
      ...base(),
      info_request: { type, account_code: null, subject: null },
    });
    assert.ok(out?.info_request, `info_request type "${type}" must pass`);
    assert.equal(out!.info_request!.type, type);
  }

  const bogus = normalizeAiDispatchParse({
    ...base(),
    info_request: { type: "freeform_chat", account_code: null, subject: null },
  });
  assert.equal(bogus?.info_request, null, "unknown info_request types must be discarded silently");
});

test("normalizeAiDispatchParse: info_request.account_code follows the same 3-5 digit rule", () => {
  const ok = normalizeAiDispatchParse({
    ...base(),
    info_request: { type: "address", account_code: "1019", subject: null },
  });
  assert.equal(ok?.info_request?.account_code, "1019");

  const bad = normalizeAiDispatchParse({
    ...base(),
    info_request: { type: "address", account_code: "ten-nineteen", subject: null },
  });
  assert.equal(bad?.info_request?.account_code, null);
});

test("normalizeAiDispatchParse: info_request is dropped if not a plain object", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    info_request: ["address"],
  });
  assert.equal(out?.info_request, null);
});

test("normalizeAiDispatchParse: blank unit / code / comment fields normalize to null", () => {
  const out = normalizeAiDispatchParse({
    ...base(),
    unit: "   ",
    code: "",
    location_name: "",
    comment_text: "   ",
  });
  assert.ok(out);
  assert.equal(out!.unit, null);
  assert.equal(out!.code, null);
  assert.equal(out!.location_name, null);
  assert.equal(out!.comment_text, null);
});
