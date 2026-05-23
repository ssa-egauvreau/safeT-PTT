/**
 * Tests for `server/src/aiDispatch/dispatchAck.ts`.
 *
 * `buildDeterministicDispatchAck` is the server-side override for the AI's
 * `dispatcher_response` on `dispatch` / `on_scene` intents. Without it, the
 * LLM can produce a voiced acknowledgment that doesn't match the structured
 * fields we just sent to CAD ("Copy 040, 459" while the call type field is
 * actually 415A, for example). The override forces the voice to match the
 * fields that hit 10-8 — a regression here means dispatchers hear one thing
 * on the radio and CAD shows another.
 *
 * Specifically protected:
 *   - skip for non-dispatch/on_scene intents (must not stomp clear / chitchat),
 *   - skip when there is no unit to ack (caller falls back to the LLM string),
 *   - command-staff callsigns 27-000 / 27-010 / 27-020 / 27-030 keep their
 *     full 27-0X0 form, while line units (27-040) get the 27- prefix stripped,
 *   - location_code beats location_name and is rendered in dash form (32-08),
 *   - dispatch templates by code (ped / 961 / generic), and
 *   - on_scene "logged on your call" override when the comment is an OUT W/
 *     line — the dispatcher must not say "on scene at <addr>" while CAD is
 *     only getting a comment on the existing call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeterministicDispatchAck } from "../../src/aiDispatch/dispatchAck.js";
import type { AiDispatchParseResult } from "../../src/aiDispatch/parse.js";

function parsed(overrides: Partial<AiDispatchParseResult>): AiDispatchParseResult {
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

test("returns null when intent is not dispatch/on_scene", () => {
  for (const intent of ["clear", "chitchat", "acknowledgment", "request_info", "unknown"]) {
    assert.equal(
      buildDeterministicDispatchAck(parsed({ intent })),
      null,
      `intent=${intent}`,
    );
  }
});

test("returns null when there is no unit (and no fallback)", () => {
  assert.equal(buildDeterministicDispatchAck(parsed({ unit: null })), null);
  assert.equal(
    buildDeterministicDispatchAck(parsed({ unit: null }), null),
    null,
  );
  assert.equal(buildDeterministicDispatchAck(parsed({ unit: null }), ""), null);
});

test("requestingUnit overrides parsed.unit when provided", () => {
  // Caller passes the live radio unit; we should ack that one.
  const out = buildDeterministicDispatchAck(
    parsed({ unit: "27-041", code: "ped" }),
    "27-040",
  );
  assert.equal(out, "Copy 040, pedestrian stop.");
});

test("command-staff callsigns 27-000/010/020/030 keep their full form", () => {
  for (const cs of ["27-000", "27-010", "27-020", "27-030"]) {
    const out = buildDeterministicDispatchAck(parsed({ unit: cs, code: null }));
    assert.equal(out, `Copy ${cs}.`, `cs=${cs}`);
  }
});

test("non-command-staff 27-XXX units get their 27- prefix stripped", () => {
  // 27-040 is a line unit — radio voice is "Copy 040", not "Copy 27-040".
  assert.equal(buildDeterministicDispatchAck(parsed({ unit: "27-040" })), "Copy 040.");
  // 27-099 is also not in the command-staff set.
  assert.equal(buildDeterministicDispatchAck(parsed({ unit: "27-099" })), "Copy 099.");
});

test("dispatch + code=ped uses the 'pedestrian stop' wording (with and without location)", () => {
  assert.equal(
    buildDeterministicDispatchAck(parsed({ code: "ped" })),
    "Copy 040, pedestrian stop.",
  );
  assert.equal(
    buildDeterministicDispatchAck(parsed({ code: "ped", location_name: "Main Mall" })),
    "Copy 040, pedestrian stop at Main Mall.",
  );
});

test("dispatch + code=961 uses the bare '961' wording", () => {
  assert.equal(
    buildDeterministicDispatchAck(parsed({ code: "961" })),
    "Copy 040, 961.",
  );
  assert.equal(
    buildDeterministicDispatchAck(parsed({ code: "961", location_name: "Disney Way" })),
    "Copy 040, 961 at Disney Way.",
  );
});

test("dispatch + generic code + location renders 'Copy XXX, <code> at <loc>'", () => {
  assert.equal(
    buildDeterministicDispatchAck(
      parsed({ code: "415", location_name: "Anaheim Plaza" }),
    ),
    "Copy 040, 415 at Anaheim Plaza.",
  );
});

test("dispatch + just code (no location) renders 'Copy XXX, <code>.'", () => {
  assert.equal(
    buildDeterministicDispatchAck(parsed({ code: "459" })),
    "Copy 040, 459.",
  );
});

test("dispatch + just location (no code) renders 'Copy XXX, at <loc>.'", () => {
  assert.equal(
    buildDeterministicDispatchAck(parsed({ location_name: "Big Park" })),
    "Copy 040, at Big Park.",
  );
});

test("dispatch + nothing renders 'Copy XXX.'", () => {
  assert.equal(buildDeterministicDispatchAck(parsed({})), "Copy 040.");
});

test("location_code beats location_name and renders in dash form (32-08)", () => {
  // accountCodeDashForm("3208") → "32-08"
  const out = buildDeterministicDispatchAck(
    parsed({ code: "415", location_code: "3208", location_name: "ignored" }),
  );
  assert.equal(out, "Copy 040, 415 at 32-08.");
});

test("on_scene with comment_text containing OUT W/ is 'logged on your call'", () => {
  // Comment-only path: officer is updating an existing assigned call, NOT
  // arriving at a new scene. Voice must reflect that or dispatchers hear
  // "on scene" while CAD only got a comment.
  assert.equal(
    buildDeterministicDispatchAck(
      parsed({
        intent: "on_scene",
        comment_text: "OUT W/ THE MANAGER",
        location_name: "Anaheim Plaza",
      }),
    ),
    "Copy 040, logged on your call.",
  );
});

test("on_scene with comment_text containing lower-case 'out w' still triggers the logged-on path", () => {
  // The check uppercases comment_text before substring scan, so the input
  // can be either case.
  assert.equal(
    buildDeterministicDispatchAck(
      parsed({ intent: "on_scene", comment_text: "out w/ rp" }),
    ),
    "Copy 040, logged on your call.",
  );
});

test("on_scene without comment falls back to the on-scene line (with and without location)", () => {
  assert.equal(
    buildDeterministicDispatchAck(parsed({ intent: "on_scene" })),
    "Copy 040, on scene.",
  );
  assert.equal(
    buildDeterministicDispatchAck(
      parsed({ intent: "on_scene", location_name: "Disney Way" }),
    ),
    "Copy 040, on scene at Disney Way.",
  );
  // location_code wins over location_name here too.
  assert.equal(
    buildDeterministicDispatchAck(
      parsed({
        intent: "on_scene",
        location_code: "1805",
        location_name: "ignored",
      }),
    ),
    "Copy 040, on scene at 18-05.",
  );
});
