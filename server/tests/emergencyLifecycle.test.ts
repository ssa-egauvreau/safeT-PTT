/**
 * Tests for `server/src/emergencyLifecycle.ts` — the pure decision layer of the
 * emergency state machine (`active → acknowledged → resolved`).
 *
 * These rules are safety-critical: they decide whether a dispatcher can take
 * ownership of an emergency and when it may be closed. The store enforces the
 * "first acknowledger wins" guarantee atomically in SQL, but the legal/illegal
 * transition map lives here and is fully exercised below — every (state ×
 * transition) cell, plus the error-code mapping the API depends on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMERGENCY_LIFECYCLE_STATES,
  isEmergencyLifecycleState,
  nextEmergencyState,
  type EmergencyLifecycleState,
  type EmergencyTransition,
} from "../src/emergencyLifecycle.js";

test("the happy path active → acknowledged → resolved is allowed", () => {
  const acked = nextEmergencyState("active", "acknowledge");
  assert.deepEqual(acked, { ok: true, next: "acknowledged" });

  const resolved = nextEmergencyState("acknowledged", "resolve");
  assert.deepEqual(resolved, { ok: true, next: "resolved" });
});

test("acknowledging anything past 'active' reports already_acknowledged", () => {
  // The whole point of first-acknowledger-wins: a second ACK must be refused,
  // and acknowledging an already-closed emergency is the same class of error.
  assert.deepEqual(nextEmergencyState("acknowledged", "acknowledge"), {
    ok: false,
    reason: "already_acknowledged",
  });
  assert.deepEqual(nextEmergencyState("resolved", "acknowledge"), {
    ok: false,
    reason: "already_acknowledged",
  });
});

test("resolving from any state other than 'acknowledged' is an invalid transition", () => {
  // Cannot resolve an emergency nobody acknowledged…
  assert.deepEqual(nextEmergencyState("active", "resolve"), {
    ok: false,
    reason: "invalid_state_transition",
  });
  // …and resolved is terminal — no re-resolve.
  assert.deepEqual(nextEmergencyState("resolved", "resolve"), {
    ok: false,
    reason: "invalid_state_transition",
  });
});

test("every (state × transition) pair has a deterministic, total result", () => {
  // Guards against a future state/transition being added without a rule, which
  // would otherwise fall through to undefined behaviour at runtime.
  const transitions: EmergencyTransition[] = ["acknowledge", "resolve"];
  const expected: Record<string, { ok: boolean }> = {
    "active/acknowledge": { ok: true },
    "active/resolve": { ok: false },
    "acknowledged/acknowledge": { ok: false },
    "acknowledged/resolve": { ok: true },
    "resolved/acknowledge": { ok: false },
    "resolved/resolve": { ok: false },
  };
  for (const state of EMERGENCY_LIFECYCLE_STATES) {
    for (const transition of transitions) {
      const result = nextEmergencyState(state, transition);
      assert.equal(
        result.ok,
        expected[`${state}/${transition}`]!.ok,
        `${state} + ${transition} should be ok=${expected[`${state}/${transition}`]!.ok}`,
      );
    }
  }
});

test("a successful transition never returns the same state it started in", () => {
  for (const state of EMERGENCY_LIFECYCLE_STATES) {
    for (const transition of ["acknowledge", "resolve"] as EmergencyTransition[]) {
      const result = nextEmergencyState(state, transition);
      if (result.ok) {
        assert.notEqual(result.next, state, `${state} + ${transition} must move forward`);
      }
    }
  }
});

test("isEmergencyLifecycleState accepts only the three known states", () => {
  for (const valid of EMERGENCY_LIFECYCLE_STATES) {
    assert.equal(isEmergencyLifecycleState(valid), true);
  }
  for (const bad of ["", "ACTIVE", "cleared", "done", null, undefined, 1, {}] as unknown[]) {
    assert.equal(isEmergencyLifecycleState(bad), false, `${String(bad)} must be rejected`);
  }
});

test("EMERGENCY_LIFECYCLE_STATES is the canonical ordered set", () => {
  assert.deepEqual(
    [...EMERGENCY_LIFECYCLE_STATES],
    ["active", "acknowledged", "resolved"] satisfies EmergencyLifecycleState[],
  );
});
