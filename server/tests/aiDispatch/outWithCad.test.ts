/**
 * Tests for `server/src/aiDispatch/outWithCad.ts`.
 *
 * The "out with" / "I'll be out with" path decides whether an officer's
 * radio transmission becomes:
 *   - a comment on their existing assigned call (no new CAD incident), or
 *   - a brand-new self-dispatched incident with an inferred call code
 *     (961 vehicle stop, 586 parking, ped stop).
 *
 * A regression that misclassifies these creates duplicate CAD incidents
 * for the same scene, or worse, loses the officer-initiated stop entirely.
 * We exercise the pure-logic surface:
 *   - phrasing detection (isOutWithTransmission / extractOutWithTail),
 *   - cop-shorthand comment formatter (buildOutWithCommentText),
 *   - call-code inference (inferOutWithCallCode), and
 *   - the full applyOutWithCadRules state machine: comment-on-active vs
 *     new-dispatch, intent overrides, dispatcher voice fallback, and the
 *     hard skip list (clear / emergency / plate / info_request).
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

function parsed(overrides: Partial<AiDispatchParseResult> = {}): AiDispatchParseResult {
  return {
    actionable: true,
    intent: "dispatch",
    unit: "27-040",
    summary: "test",
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
    ...overrides,
  };
}

function incidentForUnit(unit: string, call_id = "C-123"): { payload: unknown; call_id: string } {
  return {
    call_id,
    payload: {
      action: "open",
      incident: {
        units: [{ unit }],
      },
    },
  };
}

// -- isOutWithTransmission ------------------------------------------------

test("isOutWithTransmission matches the standard SSA phrasings", () => {
  const positives = [
    "out with a white sedan",
    "Out with the RP",
    "I'll be out with two males",
    "I will be out with the manager",
    "I'll be out w/ a male",
    "I am out with security",
    "ow at the lobby", // shorthand form
  ];
  for (const t of positives) {
    assert.equal(isOutWithTransmission(t), true, `match: ${t}`);
  }
});

test("isOutWithTransmission rejects unrelated transmissions", () => {
  const negatives = [
    "10-8 in service",
    "27-040 dispatch",
    "out of service",
    "out for lunch", // no "with" / "w/" trailer
    "",
  ];
  for (const t of negatives) {
    assert.equal(isOutWithTransmission(t), false, `no match: ${t}`);
  }
});

// -- extractOutWithTail ---------------------------------------------------

test("extractOutWithTail returns the substring after the phrase", () => {
  assert.equal(extractOutWithTail("Out with a white sedan."), "a white sedan");
  assert.equal(
    extractOutWithTail("I'll be out with two males at the lobby"),
    "two males at the lobby",
  );
  assert.equal(extractOutWithTail("ow at the lobby"), "at the lobby");
});

test("extractOutWithTail returns null when no phrase is present", () => {
  assert.equal(extractOutWithTail("no match here"), null);
});

test("extractOutWithTail strips trailing punctuation", () => {
  assert.equal(extractOutWithTail("out with the RP."), "the RP");
  assert.equal(extractOutWithTail("out with the manager,"), "the manager");
});

// -- buildOutWithCommentText ----------------------------------------------

test("buildOutWithCommentText returns 'OUT W/' when the tail is empty", () => {
  // No subject at all (just "out with"): comment is the bare prefix; the
  // human/AI can fill in the detail later.
  assert.equal(buildOutWithCommentText("out with "), "OUT W/");
  assert.equal(buildOutWithCommentText(""), "OUT W/");
});

test("buildOutWithCommentText uppercases the tail and rewrites 'with' → 'W/'", () => {
  // Tail is the part after "out with " — already extracted by the regex.
  // Note: trailing punctuation is stripped but internal commas survive.
  assert.equal(
    buildOutWithCommentText("Out with a white sedan, two occupants"),
    "OUT W/ A WHITE SEDAN, TWO OCCUPANTS",
  );
  // Embedded 'with' inside the tail also gets rewritten to W/.
  assert.equal(
    buildOutWithCommentText("out with a man with a red bag"),
    "OUT W/ A MAN W/ A RED BAG",
  );
});

test("buildOutWithCommentText leaves an already-OUT W/ comment alone (no double-prefix)", () => {
  // If caller passes raw 'OUT W/ ...' text we must NOT prepend another OUT W/.
  assert.equal(
    buildOutWithCommentText("OUT W/ THE MANAGER"),
    "OUT W/ THE MANAGER",
  );
});

test("buildOutWithCommentText collapses runs of whitespace", () => {
  assert.equal(
    buildOutWithCommentText("out with    a    white    truck"),
    "OUT W/ A WHITE TRUCK",
  );
});

test("buildOutWithCommentText caps the comment at 240 chars", () => {
  const huge = `out with ${"X".repeat(500)}`;
  const out = buildOutWithCommentText(huge);
  assert.equal(out.length, 240);
});

// -- inferOutWithCallCode -------------------------------------------------

test("inferOutWithCallCode returns null on empty tail", () => {
  assert.equal(inferOutWithCallCode("", false), null);
  assert.equal(inferOutWithCallCode("   ", false), null);
});

test("inferOutWithCallCode picks 586 for parking/586 phrases", () => {
  assert.equal(inferOutWithCallCode("586 at the lobby", false), "586");
  assert.equal(inferOutWithCallCode("illegally parked white truck", false), "586");
  assert.equal(inferOutWithCallCode("parked illegally in the red zone", false), "586");
});

test("inferOutWithCallCode picks 961 for vehicle words", () => {
  // Vehicle/make words → vehicle stop (961). Color alone is not enough.
  assert.equal(inferOutWithCallCode("a white sedan", false), "961");
  assert.equal(inferOutWithCallCode("honda civic plate 8VWV621", false), "961");
  assert.equal(inferOutWithCallCode("silver truck", false), "961");
});

test("inferOutWithCallCode picks ped for leading number / counting words", () => {
  // "out with 2 males" → pedestrian stop with two subjects.
  assert.equal(inferOutWithCallCode("2 males", false), "ped");
  assert.equal(inferOutWithCallCode("two subjects at the bench", false), "ped");
});

test("inferOutWithCallCode picks ped for explicit person words", () => {
  assert.equal(inferOutWithCallCode("male wearing red", false), "ped");
  assert.equal(inferOutWithCallCode("juvenile by the gate", false), "ped");
  assert.equal(inferOutWithCallCode("transient near the dumpster", false), "ped");
});

test("inferOutWithCallCode returns null for on-call-party words when there IS an active call", () => {
  // RP/manager/etc on an active call → ambiguous; let the AI keep its
  // chosen code rather than auto-creating a ped stop.
  assert.equal(inferOutWithCallCode("the manager", true), null);
  assert.equal(inferOutWithCallCode("reporting party", true), null);
});

test("inferOutWithCallCode falls back to ped for on-call-party words on a new self-dispatch", () => {
  // No active call → "out with the rp" is the officer self-dispatching
  // a ped stop on someone they want logged.
  assert.equal(inferOutWithCallCode("the manager", false), "ped");
  assert.equal(inferOutWithCallCode("homeowner at the door", false), "ped");
});

test("inferOutWithCallCode returns null when nothing matches", () => {
  assert.equal(inferOutWithCallCode("unspecified situation", false), null);
});

// -- unitHasActiveAssignedCall -------------------------------------------

test("unitHasActiveAssignedCall matches the unit on the incident payload", () => {
  const active = [incidentForUnit("040", "C-1"), incidentForUnit("041", "C-2")];
  assert.equal(unitHasActiveAssignedCall(active, "27-040"), true);
  assert.equal(unitHasActiveAssignedCall(active, "040"), true);
  assert.equal(unitHasActiveAssignedCall(active, "27-099"), false);
});

test("unitHasActiveAssignedCall: empty unit string is never on an active call", () => {
  const active = [incidentForUnit("040", "C-1")];
  assert.equal(unitHasActiveAssignedCall(active, ""), false);
  assert.equal(unitHasActiveAssignedCall(active, "   "), false);
});

// -- applyOutWithCadRules -------------------------------------------------

test("applyOutWithCadRules: pass-through when transcript is not an out-with line", () => {
  const p = parsed({ intent: "dispatch", code: "415" });
  const out = applyOutWithCadRules(p, "415 at the plaza", [], "27-040");
  assert.equal(out, p, "must return the same object reference (no rewrite)");
});

test("applyOutWithCadRules: SKIP_INTENTS are never rewritten", () => {
  // Even if the transcript reads as an out-with, these intents must not
  // be re-routed: a 'clear' is a 10-8 status change, not an on-scene event.
  for (const intent of [
    "clear",
    "emergency",
    "emergency_clear",
    "plate_request",
    "plate_transmit",
    "request_info",
    "info_request_912",
    "info_clear_913",
  ]) {
    const p = parsed({ intent });
    const out = applyOutWithCadRules(p, "out with a white sedan", [], "27-040");
    assert.equal(out, p, `intent=${intent} must not be rewritten`);
  }
});

test("applyOutWithCadRules: on an active call → comment-only on_scene rewrite", () => {
  const active = [incidentForUnit("040", "C-555")];
  const out = applyOutWithCadRules(
    parsed({ intent: "dispatch", code: "415", comment_text: null }),
    "out with the manager",
    active,
    "27-040",
  );
  assert.equal(out.intent, "on_scene");
  assert.equal(out.actionable, true);
  assert.equal(out.comment_text, "OUT W/ THE MANAGER");
  assert.match(out.recommended_action ?? "", /Post out-with comment on assigned call C-555/);
  assert.match(out.summary, /27-040 out-with update on current assignment/);
  // Dispatcher voice falls back to the "logged on your call" line.
  assert.equal(out.dispatcher_response, "Copy 040, logged on your call.");
});

test("applyOutWithCadRules: pre-existing comment_text is preserved", () => {
  const active = [incidentForUnit("040", "C-555")];
  const out = applyOutWithCadRules(
    parsed({
      intent: "dispatch",
      code: "415",
      comment_text: "CUSTOM CAD NOTE",
    }),
    "out with the manager",
    active,
    "27-040",
  );
  assert.equal(out.comment_text, "CUSTOM CAD NOTE");
});

test("applyOutWithCadRules: pre-existing dispatcher_response is preserved", () => {
  const active = [incidentForUnit("040", "C-555")];
  const out = applyOutWithCadRules(
    parsed({
      intent: "dispatch",
      dispatcher_response: "Copy 040, see the RP at the lobby.",
    }),
    "out with the manager",
    active,
    "27-040",
  );
  assert.equal(out.dispatcher_response, "Copy 040, see the RP at the lobby.");
});

test("applyOutWithCadRules: no active call → self-dispatch with inferred call code", () => {
  const out = applyOutWithCadRules(
    parsed({ intent: "unknown", code: null }),
    "out with a white sedan",
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.code, "961");
  assert.equal(out.actionable, true);
  assert.match(out.comment_text ?? "", /OUT W\/ A WHITE SEDAN/);
  assert.match(out.recommended_action ?? "", /Create new 961 call/);
  // Summary is rewritten for non-dispatch upstream intents.
  assert.match(out.summary, /27-040 self-dispatch via out-with \(new call\)/);
});

test("applyOutWithCadRules: no active call → ped fallback for person words", () => {
  const out = applyOutWithCadRules(
    parsed({ intent: "unknown" }),
    "I'll be out with two males",
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.code, "ped");
});

test("applyOutWithCadRules: keeps the AI-chosen code when inference returns null", () => {
  // Tail is too generic to infer; if the LLM already chose a code we keep it.
  const out = applyOutWithCadRules(
    parsed({ intent: "unknown", code: "415" }),
    "out with the situation", // no people/vehicle/parking words
    [],
    "27-040",
  );
  assert.equal(out.intent, "dispatch");
  assert.equal(out.code, "415");
});

test("applyOutWithCadRules: uses fallbackUnit when parsed.unit is null", () => {
  // Caller is the live radio unit; we still need to attribute the rewrite.
  const active = [incidentForUnit("040", "C-7")];
  const out = applyOutWithCadRules(
    parsed({ intent: "dispatch", unit: null }),
    "out with the rp",
    active,
    "27-040",
  );
  assert.equal(out.intent, "on_scene");
  assert.equal(out.dispatcher_response, "Copy 040, logged on your call.");
});
