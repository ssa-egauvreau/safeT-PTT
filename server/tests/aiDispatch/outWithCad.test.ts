/**
 * Tests for `server/src/aiDispatch/outWithCad.ts`.
 *
 * "Out with" / "OW" is SSA radio shorthand a unit uses while in the field. The
 * routing logic here is the difference between:
 *
 *   - "27-040 out with the RP" on an active 415 call → CAD COMMENT on that 415,
 *     dispatcher_response "logged on your call", NO new incident.
 *   - "27-040 out with a white Civic at 1805" with NO active call → NEW 961
 *     self-dispatch.
 *
 * A regression that flips these creates phantom CAD incidents (false dispatch
 * stats, units double-booked) OR loses a self-dispatch entirely (officer in
 * the field, CAD shows them as available).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyOutWithCadRules,
  buildOutWithCommentText,
  extractOutWithTail,
  inferOutWithCallCode,
  isOutWithTransmission,
  unitHasActiveAssignedCall,
} from "../../src/aiDispatch/outWithCad.js";
import type { AiDispatchParseResult } from "../../src/aiDispatch/parse.js";

function makeParsed(over: Partial<AiDispatchParseResult> = {}): AiDispatchParseResult {
  return {
    actionable: true,
    intent: "unknown",
    unit: "27-040",
    summary: "test transmission",
    confidence: 0.9,
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

function makeActiveIncident(unit: string, callId = "C-001") {
  return {
    call_id: callId,
    payload: {
      action: "create",
      incident: {
        units: [{ unit }],
      },
    },
  };
}

// ---------- isOutWithTransmission ----------------------------------------

test("isOutWithTransmission matches every supported phrasing", () => {
  const positives = [
    "27-040 out with a male subject",
    "27-040 OW a white Civic",
    "27-040 i'll be out with the RP",
    "27-040 I’ll be out with the manager",
    "I will be out with two subjects",
    "I am out with a pedestrian",
    "27-040 out w/ vehicle",
    "27-040 Out With the homeowner",
  ];
  for (const t of positives) {
    assert.equal(isOutWithTransmission(t), true, `should match: ${t}`);
  }
});

test("isOutWithTransmission does NOT match unrelated transmissions", () => {
  const negatives = [
    "27-040 on scene",
    "27-040 going to lunch",
    "27-040 10-4",
    "27-040 out of service",
    "",
  ];
  for (const t of negatives) {
    assert.equal(isOutWithTransmission(t), false, `should NOT match: ${t}`);
  }
});

// ---------- extractOutWithTail -------------------------------------------

test("extractOutWithTail returns the slice after the out-with phrase", () => {
  assert.equal(
    extractOutWithTail("27-040 out with a white Honda"),
    "a white Honda",
  );
  assert.equal(
    extractOutWithTail("27-040 OW the RP"),
    "the RP",
  );
});

test("extractOutWithTail strips trailing punctuation but keeps inner text", () => {
  assert.equal(
    extractOutWithTail("out with male subject."),
    "male subject",
  );
  assert.equal(
    extractOutWithTail("out with two civilians;"),
    "two civilians",
  );
});

test("extractOutWithTail returns null when no out-with marker is present", () => {
  assert.equal(extractOutWithTail("27-040 in service"), null);
  assert.equal(extractOutWithTail(""), null);
});

// ---------- buildOutWithCommentText --------------------------------------

test("buildOutWithCommentText always uppercases, normalizes 'with' to 'W/', and prefixes OUT W/", () => {
  assert.equal(
    buildOutWithCommentText("a white Honda Civic plate 8VWV621"),
    "OUT W/ A WHITE HONDA CIVIC PLATE 8VWV621",
  );
});

test("buildOutWithCommentText keeps existing 'OUT' prefix and does not double-prefix", () => {
  // When the tail already starts with OUT (e.g. caller passed full transcript)
  // we should not get "OUT W/ OUT W/ ...". Note: callers most often pass the
  // tail; this guard protects callers that pass the whole transcript.
  assert.equal(
    buildOutWithCommentText("out with rp"),
    "OUT W/ RP",
    "extractOutWithTail unwraps the prefix so 'rp' gets OUT W/ added back",
  );
});

test("buildOutWithCommentText falls back to 'OUT W/' when tail is empty", () => {
  assert.equal(buildOutWithCommentText(""), "OUT W/");
  assert.equal(buildOutWithCommentText("   "), "OUT W/");
});

test("buildOutWithCommentText caps comment at 240 chars (10-8 CAD radio comment limit)", () => {
  const long = "x".repeat(300);
  const out = buildOutWithCommentText(long);
  assert.equal(out.length, 240);
  assert.ok(out.startsWith("OUT W/ XXXX"));
});

// ---------- inferOutWithCallCode -----------------------------------------

test("inferOutWithCallCode returns '586' for parking complaints", () => {
  assert.equal(inferOutWithCallCode("586 vehicle blocking the gate", false), "586");
  assert.equal(inferOutWithCallCode("illegally parked truck", false), "586");
  assert.equal(inferOutWithCallCode("vehicle parked illegally in fire lane", false), "586");
});

test("inferOutWithCallCode returns '961' (car stop) on vehicle words", () => {
  assert.equal(inferOutWithCallCode("white Civic plate 8VWV621", false), "961");
  assert.equal(inferOutWithCallCode("red truck", false), "961");
  assert.equal(inferOutWithCallCode("black BMW", false), "961");
});

test("inferOutWithCallCode returns 'ped' when leading number is a head-count", () => {
  assert.equal(inferOutWithCallCode("2 subjects on the bench", false), "ped");
  assert.equal(inferOutWithCallCode("three transients", false), "ped");
  assert.equal(inferOutWithCallCode("one male", false), "ped");
});

test("inferOutWithCallCode returns 'ped' for plain people words (and ignores on-call-party words by default)", () => {
  assert.equal(inferOutWithCallCode("male subject loitering", false), "ped");
  assert.equal(inferOutWithCallCode("juvenile near the gate", false), "ped");
});

test("inferOutWithCallCode returns null when caller has an active call AND the tail is just an on-call party (RP/manager)", () => {
  // No new incident — the AI engine should keep this as a comment on the
  // existing call. Returning a code here would mean we self-dispatch a NEW
  // call type for someone the officer is already at.
  assert.equal(inferOutWithCallCode("the RP", true), null);
  assert.equal(inferOutWithCallCode("the property manager", true), null);
  assert.equal(inferOutWithCallCode("the homeowner", true), null);
});

test("inferOutWithCallCode falls back to 'ped' when on-call party words appear but no active call (officer self-initiated)", () => {
  assert.equal(inferOutWithCallCode("the RP", false), "ped");
});

test("inferOutWithCallCode returns null on empty / non-classifiable input", () => {
  assert.equal(inferOutWithCallCode("", false), null);
  assert.equal(inferOutWithCallCode("   ", false), null);
  // No clue what this is — let downstream AI decide.
  assert.equal(inferOutWithCallCode("checking the perimeter", false), null);
});

// ---------- unitHasActiveAssignedCall ------------------------------------

test("unitHasActiveAssignedCall matches when unit is in the incident units list", () => {
  const active = [makeActiveIncident("352"), makeActiveIncident("040", "C-002")];
  assert.equal(unitHasActiveAssignedCall(active, "352"), true);
  assert.equal(unitHasActiveAssignedCall(active, "27-040"), true);
});

test("unitHasActiveAssignedCall returns false when unit is not assigned", () => {
  const active = [makeActiveIncident("352")];
  assert.equal(unitHasActiveAssignedCall(active, "999"), false);
  assert.equal(unitHasActiveAssignedCall(active, ""), false);
  assert.equal(unitHasActiveAssignedCall(active, "   "), false);
});

// ---------- applyOutWithCadRules ----------------------------------------

test("applyOutWithCadRules: no-op when transcript is not an out-with transmission", () => {
  const parsed = makeParsed({ intent: "status_change", summary: "27-040 in service" });
  const out = applyOutWithCadRules(parsed, "27-040 in service", [], "27-040");
  assert.equal(out, parsed, "should return the SAME object reference when not applicable");
});

test("applyOutWithCadRules: no-op for SKIP_INTENTS even with an out-with transcript", () => {
  // If the LLM already labeled this as plate_request / emergency / clear, we
  // trust that and do NOT rewrite to dispatch/on_scene — otherwise an
  // emergency_clear could be silently converted to a new dispatch.
  for (const intent of [
    "clear",
    "emergency",
    "emergency_clear",
    "plate_request",
    "plate_transmit",
    "request_info",
    "info_request_912",
    "info_clear_913",
  ] as const) {
    const parsed = makeParsed({ intent });
    const out = applyOutWithCadRules(
      parsed,
      "27-040 out with a male subject",
      [makeActiveIncident("040")],
      "27-040",
    );
    assert.equal(out.intent, intent, `intent ${intent} must not be rewritten`);
  }
});

test("applyOutWithCadRules: active-call path becomes 'on_scene' COMMENT (no new incident)", () => {
  const active = [makeActiveIncident("040", "C-1234")];
  const parsed = makeParsed({ intent: "dispatch", code: "415" });
  const out = applyOutWithCadRules(parsed, "27-040 out with the RP", active, "27-040");

  assert.equal(out.intent, "on_scene");
  assert.equal(out.actionable, true);
  assert.equal(out.comment_text, "OUT W/ THE RP");
  assert.match(out.recommended_action ?? "", /C-1234/);
  assert.match(out.recommended_action ?? "", /do not create a new incident/);
  // Patrol units (not 27-0X0 command staff) drop the 27- prefix on the air.
  assert.equal(out.dispatcher_response, "Copy 040, logged on your call.");
});

test("applyOutWithCadRules: command-staff callsigns 27-0X0 keep the 27- prefix on the air", () => {
  const active = [makeActiveIncident("020", "C-9000")];
  const parsed = makeParsed({ intent: "unknown", unit: "27-020" });
  const out = applyOutWithCadRules(parsed, "27-020 out with the RP", active, "27-020");
  assert.equal(out.dispatcher_response, "Copy 27-020, logged on your call.");
});

test("applyOutWithCadRules: preserves an LLM-provided dispatcher_response on the active-call path", () => {
  const active = [makeActiveIncident("040", "C-1234")];
  const parsed = makeParsed({
    intent: "unknown",
    dispatcher_response: "040, copy, comment posted.",
  });
  const out = applyOutWithCadRules(parsed, "27-040 out with the RP", active, "27-040");
  assert.equal(out.dispatcher_response, "040, copy, comment posted.");
});

test("applyOutWithCadRules: preserves an LLM-provided comment_text on the active-call path", () => {
  const active = [makeActiveIncident("040", "C-1234")];
  const parsed = makeParsed({
    intent: "unknown",
    comment_text: "OUT W/ RP — STATEMENT TAKEN",
  });
  const out = applyOutWithCadRules(parsed, "27-040 out with the RP", active, "27-040");
  assert.equal(out.comment_text, "OUT W/ RP — STATEMENT TAKEN");
});

test("applyOutWithCadRules: no active call → 'dispatch' with inferred code (961 for vehicle)", () => {
  const parsed = makeParsed({ intent: "unknown" });
  const out = applyOutWithCadRules(
    parsed,
    "27-040 out with a white Honda Civic",
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.actionable, true);
  assert.equal(out.code, "961");
  assert.equal(out.comment_text, "OUT W/ A WHITE HONDA CIVIC");
  assert.match(out.recommended_action ?? "", /Create new 961 call/);
});

test("applyOutWithCadRules: no active call → 'dispatch' with inferred 'ped' for a person", () => {
  const parsed = makeParsed({ intent: "unknown" });
  const out = applyOutWithCadRules(
    parsed,
    "27-040 out with a male subject loitering",
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.code, "ped");
});

test("applyOutWithCadRules: no active call and no inferable code → recommended_action says to use AI-inferred type", () => {
  const parsed = makeParsed({ intent: "unknown", code: null });
  const out = applyOutWithCadRules(
    parsed,
    "27-040 out with checking the perimeter",
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.code, null);
  assert.match(
    out.recommended_action ?? "",
    /AI-inferred type/,
  );
});

test("applyOutWithCadRules: no active call → existing AI-supplied code is kept (lowercased) when no inference fires", () => {
  const parsed = makeParsed({ intent: "unknown", code: "415" });
  const out = applyOutWithCadRules(
    parsed,
    "27-040 out with checking the perimeter",
    [],
    "27-040",
  );
  assert.equal(out.code, "415");
});

test("applyOutWithCadRules: uses fallbackUnit when parsed.unit is missing", () => {
  const parsed = makeParsed({ intent: "unknown", unit: null });
  const out = applyOutWithCadRules(
    parsed,
    "out with a white truck",
    [makeActiveIncident("040", "C-555")],
    "27-040",
  );
  assert.match(out.recommended_action ?? "", /C-555/);
});

test("applyOutWithCadRules: 'dispatch' intent on active-call path rewrites summary to mark it as comment-only", () => {
  const active = [makeActiveIncident("040", "C-1234")];
  const parsed = makeParsed({
    intent: "dispatch",
    summary: "27-040 out with the RP",
  });
  const out = applyOutWithCadRules(parsed, "27-040 out with the RP", active, "27-040");
  assert.match(out.summary, /out-with update on current assignment \(comment only\)/);
});
