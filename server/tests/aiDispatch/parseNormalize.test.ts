/**
 * Tests for `normalizeAiDispatchParse` in `server/src/aiDispatch/parse.ts`.
 *
 * This is the schema gate between the LLM and every downstream side effect:
 * 10-8 incident creation, plate lookups, info-request fan-out, deterministic
 * dispatcher-reply text, and the dedupe key. A regression that lets a malformed
 * LLM payload through can cause the engine to:
 *   - create a 10-8 incident with a garbage call type (which 10-8 then rejects
 *     on close, jamming the dispatcher),
 *   - run a plate lookup with an unsanitized VIN containing whitespace, or
 *   - speak the wrong unit number on the air.
 *
 * These tests lock the contract: only well-formed parses survive, and every
 * field is normalized to the shape downstream consumers expect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeAiDispatchParse } from "../../src/aiDispatch/parse.js";

function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionable: true,
    intent: "dispatch",
    unit: "352",
    summary: "352 self-dispatch on a 961.",
    confidence: 0.9,
    dispatcher_response: "Copy 352, 961.",
    trigger_emergency_tone: false,
    recommended_action: null,
    plate_request: null,
    code: "961",
    location_code: null,
    location_name: null,
    info_request: null,
    comment_text: null,
    ...over,
  };
}

test("normalizeAiDispatchParse rejects non-object input", () => {
  assert.equal(normalizeAiDispatchParse(null), null);
  assert.equal(normalizeAiDispatchParse(undefined), null);
  assert.equal(normalizeAiDispatchParse("a string"), null);
  assert.equal(normalizeAiDispatchParse(42), null);
  assert.equal(normalizeAiDispatchParse([basePayload()]), null);
});

test("normalizeAiDispatchParse rejects payloads missing required fields", () => {
  // actionable must be a boolean.
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), actionable: "yes" }), null);
  // intent must be one of the known values.
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), intent: "novel_intent" }), null);
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), intent: 42 }), null);
  // summary must be a non-empty string.
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), summary: "" }), null);
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), summary: "   " }), null);
  // confidence must be a number, not NaN.
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), confidence: "high" }), null);
  assert.equal(normalizeAiDispatchParse({ ...basePayload(), confidence: NaN }), null);
});

test("normalizeAiDispatchParse accepts every known intent in the schema", () => {
  const validIntents = [
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
  ];
  for (const intent of validIntents) {
    const out = normalizeAiDispatchParse(basePayload({ intent }));
    assert.ok(out, `intent=${intent} should pass schema`);
    assert.equal(out!.intent, intent);
  }
});

test("normalizeAiDispatchParse trims summary and unit and clears blanks", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      summary: "   352 in service.   ",
      unit: "  352  ",
      dispatcher_response: "  Copy 352.  ",
      recommended_action: "  Create the call.  ",
      code: "  961  ",
      location_name: "  Disney Way  ",
      comment_text: "  OUT W/ WHITE SEDAN  ",
    }),
  );
  assert.ok(out);
  assert.equal(out!.summary, "352 in service.");
  assert.equal(out!.unit, "352");
  assert.equal(out!.dispatcher_response, "Copy 352.");
  assert.equal(out!.recommended_action, "Create the call.");
  assert.equal(out!.code, "961");
  assert.equal(out!.location_name, "Disney Way");
  assert.equal(out!.comment_text, "OUT W/ WHITE SEDAN");
});

test("normalizeAiDispatchParse converts blank/whitespace unit and code to null", () => {
  const out = normalizeAiDispatchParse(
    basePayload({ unit: "   ", code: "", dispatcher_response: "   " }),
  );
  assert.ok(out);
  assert.equal(out!.unit, null);
  assert.equal(out!.code, null);
  assert.equal(out!.dispatcher_response, null);
});

test("normalizeAiDispatchParse only accepts location_code matching /^\\d{3,5}$/", () => {
  for (const ok of ["100", "1234", "12345"]) {
    const out = normalizeAiDispatchParse(basePayload({ location_code: ok }));
    assert.equal(out!.location_code, ok);
  }
  for (const bad of ["12", "123456", "12a", "abc", " 123 "]) {
    const out = normalizeAiDispatchParse(basePayload({ location_code: bad }));
    // Whitespace gets trimmed before matching, so " 123 " is allowed.
    if (bad === " 123 ") {
      assert.equal(out!.location_code, "123");
    } else {
      assert.equal(out!.location_code, null, `bad=${bad}`);
    }
  }
});

test("normalizeAiDispatchParse caps comment_text at 240 chars (CAD limit)", () => {
  const long = "OUT W/ ".concat("FOO ".repeat(200)); // ~800 chars
  const out = normalizeAiDispatchParse(basePayload({ comment_text: long }));
  assert.ok(out);
  assert.ok(
    (out!.comment_text ?? "").length <= 240,
    `expected ≤240 chars, got ${(out!.comment_text ?? "").length}`,
  );
});

test("normalizeAiDispatchParse upper-cases plate/state and strips whitespace + dashes from VIN", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "plate_request",
      plate_request: {
        plate: "  abc1234  ",
        state: "  ca  ",
        vin: "  1HGBH41JX-MN10 9186 ",
      },
    }),
  );
  assert.ok(out);
  assert.deepEqual(out!.plate_request, {
    plate: "ABC1234",
    state: "CA",
    vin: "1HGBH41JXMN109186",
  });
});

test("normalizeAiDispatchParse drops plate_request entirely when both plate and vin are missing", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "plate_request",
      plate_request: { plate: "", state: "CA", vin: "" },
    }),
  );
  assert.ok(out);
  assert.equal(out!.plate_request, null);
});

test("normalizeAiDispatchParse passes plate_request through when only the VIN is present", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "plate_request",
      plate_request: { plate: null, state: null, vin: "1HGBH41JXMN109186" },
    }),
  );
  assert.ok(out);
  assert.equal(out!.plate_request?.plate, null);
  assert.equal(out!.plate_request?.vin, "1HGBH41JXMN109186");
});

test("normalizeAiDispatchParse rejects unknown info_request types but keeps the parse", () => {
  // Unknown info_request type should not crash — info_request is just dropped.
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "request_info",
      info_request: { type: "novel_lookup", account_code: "1234", subject: "test" },
    }),
  );
  assert.ok(out);
  assert.equal(out!.info_request, null);
});

test("normalizeAiDispatchParse normalizes info_request type to lower-case and validates account_code", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "request_info",
      info_request: { type: "  ADDRESS  ", account_code: "  1234  ", subject: "  HQ  " },
    }),
  );
  assert.ok(out);
  assert.equal(out!.info_request?.type, "address");
  assert.equal(out!.info_request?.account_code, "1234");
  assert.equal(out!.info_request?.subject, "HQ");
});

test("normalizeAiDispatchParse drops a non-numeric account_code on info_request", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      intent: "request_info",
      info_request: { type: "address", account_code: "HQ-1", subject: null },
    }),
  );
  assert.ok(out);
  assert.equal(out!.info_request?.account_code, null);
  assert.equal(out!.info_request?.type, "address");
});

test("normalizeAiDispatchParse coerces trigger_emergency_tone to a strict boolean", () => {
  // Anything other than literal `true` is rejected — strings/1/etc. are NOT truthy.
  const truthy = normalizeAiDispatchParse(basePayload({ trigger_emergency_tone: true }));
  assert.equal(truthy!.trigger_emergency_tone, true);

  for (const v of ["true", 1, "1", "yes", null, undefined, 0]) {
    const out = normalizeAiDispatchParse(basePayload({ trigger_emergency_tone: v }));
    assert.ok(out);
    assert.equal(
      out!.trigger_emergency_tone,
      false,
      `trigger_emergency_tone=${JSON.stringify(v)} should NOT be treated as truthy`,
    );
  }
});

test("normalizeAiDispatchParse preserves a complete, well-formed dispatch payload", () => {
  const out = normalizeAiDispatchParse(
    basePayload({
      actionable: true,
      intent: "dispatch",
      unit: "352",
      summary: "352 self-dispatch on a 961 at 18-06.",
      confidence: 0.95,
      dispatcher_response: "Copy 352, 961 at 18-06.",
      trigger_emergency_tone: false,
      recommended_action: "Create new 961.",
      plate_request: { plate: "8VWV621", state: "CA", vin: null },
      code: "961",
      location_code: "1806",
      location_name: "Disney Way",
      info_request: null,
      comment_text: null,
    }),
  );
  assert.deepEqual(out, {
    actionable: true,
    intent: "dispatch",
    unit: "352",
    summary: "352 self-dispatch on a 961 at 18-06.",
    confidence: 0.95,
    dispatcher_response: "Copy 352, 961 at 18-06.",
    trigger_emergency_tone: false,
    recommended_action: "Create new 961.",
    plate_request: { plate: "8VWV621", state: "CA", vin: null },
    code: "961",
    location_code: "1806",
    location_name: "Disney Way",
    info_request: null,
    comment_text: null,
  });
});
