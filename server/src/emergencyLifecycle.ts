/**
 * Emergency lifecycle state machine: `active → acknowledged → resolved`.
 *
 * An emergency (an `alerts` row with `kind = 'emergency'`) starts `active` when
 * a handset hits the emergency button or a dispatcher raises one. A dispatcher
 * then **acknowledges** it (taking ownership — first acknowledger wins), and
 * finally **resolves** it once handled. The two safety-critical invariants are:
 *
 *  1. Exactly one acknowledger. A second ACK must be rejected, not silently
 *     overwrite who owns the incident.
 *  2. No backwards / skipped transitions. You cannot resolve something nobody
 *     acknowledged, and a resolved emergency is terminal.
 *
 * This module is the *pure* decision layer — no I/O — so the rules are trivially
 * unit-testable. The actual first-acknowledger-wins guarantee is enforced
 * atomically in the store via conditional `UPDATE ... WHERE lifecycle_state = …`
 * (a SELECT-then-UPDATE would race); this function is used to classify *why* a
 * conditional update matched no rows, so the API can return a precise 409.
 */

export type EmergencyLifecycleState = "active" | "acknowledged" | "resolved";

export const EMERGENCY_LIFECYCLE_STATES: readonly EmergencyLifecycleState[] = [
  "active",
  "acknowledged",
  "resolved",
];

export type EmergencyTransition = "acknowledge" | "resolve";

/**
 * Reasons a transition is refused, mapped 1:1 to the API's 409 error codes:
 *  - `already_acknowledged` — ACK attempted on an emergency past `active`.
 *  - `invalid_state_transition` — any other illegal move (resolve before ack,
 *    re-resolve, acknowledge a resolved emergency, …).
 */
export type EmergencyTransitionError = "already_acknowledged" | "invalid_state_transition";

export type EmergencyTransitionResult =
  | { ok: true; next: EmergencyLifecycleState }
  | { ok: false; reason: EmergencyTransitionError };

export function isEmergencyLifecycleState(value: unknown): value is EmergencyLifecycleState {
  return (
    value === "active" || value === "acknowledged" || value === "resolved"
  );
}

/**
 * Resolve what a transition does from a given state. Total over the 3×2 input
 * space so callers never have to handle an "impossible" fallthrough.
 */
export function nextEmergencyState(
  current: EmergencyLifecycleState,
  transition: EmergencyTransition,
): EmergencyTransitionResult {
  if (transition === "acknowledge") {
    // Only an active emergency can be acknowledged; anything further along means
    // someone already owns it (or it is already closed).
    if (current === "active") {
      return { ok: true, next: "acknowledged" };
    }
    return { ok: false, reason: "already_acknowledged" };
  }
  // transition === "resolve": only a previously-acknowledged emergency may close.
  if (current === "acknowledged") {
    return { ok: true, next: "resolved" };
  }
  return { ok: false, reason: "invalid_state_transition" };
}
