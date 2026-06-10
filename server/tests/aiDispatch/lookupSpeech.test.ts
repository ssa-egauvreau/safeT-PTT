/**
 * Tests for `server/src/aiDispatch/lookupSpeech.ts`.
 *
 * Every helper in this module produces a literal string the dispatcher TTS
 * engine reads aloud on the air after an external lookup fails. A regression
 * here either:
 *   - Tells the officer "no return on that plate" when the real failure was
 *     an auth/credit problem (officer keeps stopping the vehicle without
 *     knowing the system was actually down); or
 *   - Tells the officer the system is down when there really is no record
 *     (officer treats a legitimately clean plate as inconclusive).
 *
 * The contracts pinned here are:
 *
 *  1. `callsignPrefixForRadio`:
 *     - Drops the `27-` patrol prefix for normal patrol units (`352, `).
 *     - KEEPS the `27-` prefix for command-staff callsigns `27-0X0`
 *       (`27-010`, `27-020`, `27-030`) so command staff get addressed by
 *       their full callsign on the air.
 *     - Returns the empty string for null / undefined / blank input rather
 *       than `"undefined, "` or `"null, "`.
 *
 *  2. `plateLookupFailureLine` / `vinLookupFailureLine`:
 *     - `no_record` → "no return comes back to that license plate / VIN".
 *     - `invalid_vin` → "negative on that vin, please 10-9 the transmission"
 *       (VIN-only; tells the officer to repeat).
 *     - `not_configured` / `auth_error` / `insufficient_credit` /
 *       `network_error` / `api_error` → "license plate system is down".
 *     - Unknown / missing reason → plate falls back to "no return", VIN
 *       falls back to "system is down" (intentional asymmetry: an
 *       unknown plate state is safer to read as "no record", an unknown
 *       VIN state is safer to read as "system down").
 *
 *  3. `webSearchFailureLine`:
 *     - `no_api_key` and `anthropic_required` → "web lookup is not
 *       configured" (admin needs to add an API key).
 *     - `timeout` → "internet is not working right now, try again" (the
 *       only failure mode that promises a retry will help).
 *     - `api_error` / `exception` / `parse_error` → "internet is not
 *       working right now" (no retry promise).
 *     - `not_found` → "I can't find that information" (the search ran
 *       successfully but had no answer — distinct from a failure).
 *     - Unknown reason → "I can't search that information" generic.
 *
 *  4. `genericInfoLookupFailedLine` / `cadSystemDownLine` /
 *     `cadLookupFailedLine` always include the supplied callsign prefix
 *     unchanged — these are used in distinct CAD-failure branches and must
 *     not be collapsed into one another.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cadLookupFailedLine,
  cadSystemDownLine,
  callsignPrefixForRadio,
  genericInfoLookupFailedLine,
  plateLookupFailureLine,
  vinLookupFailureLine,
  webSearchFailureLine,
  webSearchNotConfiguredLine,
} from "../../src/aiDispatch/lookupSpeech.js";

// ---------------------------------------------------------------------------
// callsignPrefixForRadio
// ---------------------------------------------------------------------------

test("callsignPrefixForRadio shortens patrol units", () => {
  assert.equal(callsignPrefixForRadio("27-352"), "352, ");
  assert.equal(callsignPrefixForRadio("27-030"), "27-030, ");
});

test("callsignPrefixForRadio: keeps the 27- prefix for the documented command-staff range (27-0X0)", () => {
  // Command staff (chief / lieutenants / sergeants on the 27-010/020/030
  // band) are addressed by their full callsign on the air; patrol units
  // (27-352, 27-040, 27-100…) drop the 27-.
  assert.equal(callsignPrefixForRadio("27-010"), "27-010, ");
  assert.equal(callsignPrefixForRadio("27-020"), "27-020, ");
  assert.equal(callsignPrefixForRadio("27-030"), "27-030, ");
  // 27-040 is a patrol callsign even though its tens-digit is small — only
  // the literal pattern /^27-0[0-3]0$/ keeps the prefix.
  assert.equal(callsignPrefixForRadio("27-040"), "040, ");
  assert.equal(callsignPrefixForRadio("27-100"), "100, ");
});

test("callsignPrefixForRadio: returns the empty string for null / undefined / blank input", () => {
  // Important: if this ever returned the literal string "undefined, " or
  // similar, the TTS would read "undefined" on the air. Empty-string
  // fallback is the documented safe default.
  assert.equal(callsignPrefixForRadio(null), "");
  assert.equal(callsignPrefixForRadio(undefined), "");
  assert.equal(callsignPrefixForRadio(""), "");
  assert.equal(callsignPrefixForRadio("   "), "");
});

test("callsignPrefixForRadio: trims surrounding whitespace before deciding the format", () => {
  assert.equal(callsignPrefixForRadio("  27-352  "), "352, ");
  assert.equal(callsignPrefixForRadio("\t27-010\n"), "27-010, ");
});

test("callsignPrefixForRadio: non-27- callsigns pass through unchanged", () => {
  // Other agencies use different number-banks; the helper must not
  // mangle them — just append the standard ", " separator.
  assert.equal(callsignPrefixForRadio("D-12"), "D-12, ");
  assert.equal(callsignPrefixForRadio("352"), "352, ");
});

// ---------------------------------------------------------------------------
// plateLookupFailureLine — every documented reason
// ---------------------------------------------------------------------------

test("plateLookupFailureLine: no_record reads as 'no return on that plate'", () => {
  assert.match(
    plateLookupFailureLine("352, ", { reason: "no_record" }),
    /no return comes back to that license plate/i,
  );
});

test("plateLookupFailureLine: not_configured tells the officer the system is not set up", () => {
  // Distinct from "system is down" — "not set up" is an admin action,
  // "down" is a transient operational problem.
  assert.match(
    plateLookupFailureLine("352, ", { reason: "not_configured" }),
    /license plate system is not set up/i,
  );
});

test("plateLookupFailureLine: auth_error and insufficient_credit both read as 'system is down'", () => {
  // From the officer's perspective these are indistinguishable — neither
  // is something they can fix mid-stop. They MUST collapse to the same
  // radio line.
  assert.match(
    plateLookupFailureLine("352, ", { reason: "auth_error" }),
    /license plate system is down/i,
  );
  assert.match(
    plateLookupFailureLine("352, ", { reason: "insufficient_credit" }),
    /license plate system is down/i,
  );
});

test("plateLookupFailureLine: network_error and api_error read as 'system is down'", () => {
  assert.match(
    plateLookupFailureLine("352, ", { reason: "network_error" }),
    /license plate system is down/i,
  );
  assert.match(
    plateLookupFailureLine("352, ", { reason: "api_error" }),
    /license plate system is down/i,
  );
});

test("plateLookupFailureLine: missing / null / unknown reason falls back to 'no return' (safe default for plate)", () => {
  // Plate fallback to "no return" is intentional: the lookup module
  // already classified explicit transport failures separately. If we got
  // here with an undefined reason, the most accurate single-sentence
  // readback is the same one as no_record.
  assert.match(
    plateLookupFailureLine("352, ", null),
    /no return comes back to that license plate/i,
  );
  assert.match(plateLookupFailureLine("352, "), /no return comes back to that license plate/i);
});

test("plateLookupFailureLine: includes the supplied callsign prefix unchanged", () => {
  const out = plateLookupFailureLine("27-010, ", { reason: "no_record" });
  assert.ok(out.startsWith("27-010, "), `expected line to begin with the prefix, got: ${out}`);
});

// ---------------------------------------------------------------------------
// vinLookupFailureLine — every documented reason
// ---------------------------------------------------------------------------

test("vinLookupFailureLine: no_record reads as 'no return on that VIN'", () => {
  assert.match(
    vinLookupFailureLine("352, ", { reason: "no_record" }),
    /no return comes back to that vin/i,
  );
});

test("vinLookupFailureLine: invalid_vin asks the officer to 10-9 (repeat) the transmission", () => {
  // The VIN-specific "10-9 the transmission" line is the only path that
  // signals "your VIN was mis-heard"; collapsing it into a generic
  // failure would make officers re-stop a vehicle instead of just
  // re-reading the VIN.
  assert.match(vinLookupFailureLine("352, ", { reason: "invalid_vin" }), /10-9/i);
  assert.match(
    vinLookupFailureLine("352, ", { reason: "invalid_vin" }),
    /negative on that vin/i,
  );
});

test("vinLookupFailureLine: not_configured reads as 'system is not set up'", () => {
  assert.match(
    vinLookupFailureLine("352, ", { reason: "not_configured" }),
    /license plate system is not set up/i,
  );
});

test("vinLookupFailureLine: auth_error / insufficient_credit / network_error / api_error all read as 'system is down'", () => {
  for (const reason of ["auth_error", "insufficient_credit", "network_error", "api_error"] as const) {
    assert.match(
      vinLookupFailureLine("352, ", { reason }),
      /license plate system is down/i,
      `reason=${reason} must read as "system is down"`,
    );
  }
});

test("vinLookupFailureLine: missing / null / unknown reason falls back to 'system is down' (NOT 'no return')", () => {
  // VIN's fallback is the OPPOSITE of plate's. An unknown VIN failure is
  // safer to surface as "system is down" than to imply a clean lookup,
  // because the typing surface for VIN is much larger and a wrong "no
  // return" gives false confidence that the VIN was checked.
  assert.match(vinLookupFailureLine("352, "), /license plate system is down/i);
  assert.match(vinLookupFailureLine("352, ", null), /license plate system is down/i);
});

// ---------------------------------------------------------------------------
// webSearchFailureLine — every documented reason
// ---------------------------------------------------------------------------

test("webSearchFailureLine: no_api_key and anthropic_required both read as 'not configured'", () => {
  assert.match(
    webSearchFailureLine("352, ", { ok: false, reason: "no_api_key" }),
    /web lookup is not configured/i,
  );
  assert.match(
    webSearchFailureLine("352, ", { ok: false, reason: "anthropic_required" }),
    /web lookup is not configured/i,
  );
});

test("webSearchFailureLine: timeout is the only branch that promises a retry would help", () => {
  // The line "try again" only appears for transient timeouts. Officers
  // hearing it know it's worth re-asking; the api_error / exception /
  // parse_error branches deliberately do NOT promise a retry.
  const timeoutLine = webSearchFailureLine("352, ", { ok: false, reason: "timeout" });
  assert.match(timeoutLine, /internet is not working right now/i);
  assert.match(timeoutLine, /try again/i);

  const apiLine = webSearchFailureLine("352, ", { ok: false, reason: "api_error" });
  assert.match(apiLine, /internet is not working right now/i);
  assert.ok(!/try again/i.test(apiLine), "api_error must NOT suggest a retry");
});

test("webSearchFailureLine: api_error / exception / parse_error all read as 'internet is not working'", () => {
  for (const reason of ["api_error", "exception", "parse_error"] as const) {
    assert.match(
      webSearchFailureLine("352, ", { ok: false, reason }),
      /internet is not working right now/i,
      `reason=${reason} must read as "internet is not working"`,
    );
  }
});

test("webSearchFailureLine: not_found is distinct from a transport failure", () => {
  // not_found means "the search ran fine, but the answer wasn't online" —
  // this MUST read differently from "internet is broken" so the officer
  // knows asking again won't help.
  const line = webSearchFailureLine("352, ", { ok: false, reason: "not_found" });
  assert.match(line, /can't find that information/i);
  assert.ok(!/internet is not working/i.test(line), "not_found must not mention transport failure");
});

test("webSearchFailureLine: unknown reason falls back to generic 'I can't search that information'", () => {
  // Cast forces an out-of-union reason to exercise the default branch.
  const line = webSearchFailureLine("352, ", {
    ok: false,
    reason: "totally_new_failure_mode" as unknown as "api_error",
  });
  assert.match(line, /can't search that information/i);
});

test("webSearchNotConfiguredLine: matches the line emitted by webSearchFailureLine for no_api_key", () => {
  // These two helpers exist as distinct call sites but MUST produce the
  // same dispatcher line, so a future split between "no key configured"
  // and "Anthropic required" only happens in one place.
  const direct = webSearchNotConfiguredLine("352, ");
  const viaFailure = webSearchFailureLine("352, ", { ok: false, reason: "no_api_key" });
  assert.equal(direct, viaFailure);
});

// ---------------------------------------------------------------------------
// CAD / generic info helpers
// ---------------------------------------------------------------------------

test("genericInfoLookupFailedLine: reads 'I can't find that information' with the supplied prefix", () => {
  assert.equal(genericInfoLookupFailedLine("352, "), "352, I can't find that information.");
  assert.equal(genericInfoLookupFailedLine(""), "I can't find that information.");
});

test("cadSystemDownLine: tells the officer 10-8 is down and a retry would help", () => {
  // Distinguishing "CAD is down" from a generic lookup failure matters:
  // an officer who hears "CAD is down" knows to write down their request
  // and not just repeat themselves.
  const line = cadSystemDownLine("352, ");
  assert.match(line, /10-8 CAD is down/i);
  assert.match(line, /try again/i);
});

test("cadLookupFailedLine: tells the officer the info wasn't in CAD (distinct from CAD being down)", () => {
  // The "can't find that information in CAD right now" line specifically
  // means "CAD answered but didn't have it". MUST NOT collapse to
  // cadSystemDownLine, or officers will retry forever expecting CAD to
  // come back up.
  const line = cadLookupFailedLine("352, ");
  assert.match(line, /can't find that information in CAD/i);
  assert.ok(!/CAD is down/i.test(line), "cadLookupFailedLine must not say 'CAD is down'");
  assert.ok(!/try again/i.test(line), "cadLookupFailedLine must not promise a retry");
});

test("all CAD / info helpers preserve the supplied callsign prefix verbatim", () => {
  for (const prefix of ["", "352, ", "27-010, ", "D-12, "]) {
    assert.ok(genericInfoLookupFailedLine(prefix).startsWith(prefix));
    assert.ok(cadSystemDownLine(prefix).startsWith(prefix));
    assert.ok(cadLookupFailedLine(prefix).startsWith(prefix));
  }
});
