/**
 * Tests for `server/src/aiDispatch/lookupSpeech.ts`.
 *
 * These helpers build EVERY radio-failure line the AI dispatcher speaks when
 * a downstream lookup fails (DMV plate / VIN, Anthropic web search, 10-8 CAD).
 * They were introduced by the "Speak clear radio lines when lookups and web
 * search fail" feature — without them the dispatcher used to fall silent on
 * the air, leaving the requesting unit hanging.
 *
 * Properties pinned below:
 *   - Every {failure-reason → spoken line} branch is exercised. A regression
 *     that drops a branch silently falls through to a generic line, or
 *     worse, returns `${csPart}undefined.` if the default is broken.
 *   - The callsign prefix follows the same 27-0[0-3]0 command-staff rule the
 *     rest of the dispatcher uses. A regression that flips the rule names
 *     command staff like patrol units (or vice versa) on the air.
 *   - Empty / blank inputs are handled without crashing or producing
 *     "${undefined}, " on the air.
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
import type { WebSearchResult } from "../../src/aiDispatch/webSearch.js";

// ---------- callsignPrefixForRadio --------------------------------------

test("callsignPrefixForRadio: empty / null / undefined / whitespace returns empty string", () => {
  // The spoken line will then start with the message itself, never with a
  // bare ', ' or 'undefined, '. This is the safety net for transcripts
  // that arrive with no requesting unit.
  assert.equal(callsignPrefixForRadio(null), "");
  assert.equal(callsignPrefixForRadio(undefined), "");
  assert.equal(callsignPrefixForRadio(""), "");
  assert.equal(callsignPrefixForRadio("   "), "");
});

test("callsignPrefixForRadio: command-staff 27-0[0-3]0 keep the full form on the air", () => {
  // Same convention used by dispatchAck and infoRequestAck.
  for (const cs of ["27-000", "27-010", "27-020", "27-030"]) {
    assert.equal(callsignPrefixForRadio(cs), `${cs}, `);
  }
});

test("callsignPrefixForRadio: patrol units drop the 27- prefix", () => {
  assert.equal(callsignPrefixForRadio("27-352"), "352, ");
  assert.equal(callsignPrefixForRadio("27-040"), "040, ");
});

test("callsignPrefixForRadio: trims surrounding whitespace before formatting", () => {
  assert.equal(callsignPrefixForRadio("  27-352  "), "352, ");
});

test("callsignPrefixForRadio: non-27-prefixed unit ids pass through unchanged", () => {
  // Some agencies use bare 3-digit ids, or alphanumeric tags.
  assert.equal(callsignPrefixForRadio("ADAM-5"), "ADAM-5, ");
  assert.equal(callsignPrefixForRadio("352"), "352, ");
});

// ---------- plateLookupFailureLine --------------------------------------

test("plateLookupFailureLine: 'no_record' speaks 'no return comes back to that license plate'", () => {
  assert.equal(
    plateLookupFailureLine("205, ", { reason: "no_record" }),
    "205, no return comes back to that license plate.",
  );
});

test("plateLookupFailureLine: 'not_configured' speaks 'license plate system is not set up'", () => {
  // Distinct from "down right now" — admins need to know the system was
  // never wired in, not that the upstream is sick.
  assert.equal(
    plateLookupFailureLine("205, ", { reason: "not_configured" }),
    "205, license plate system is not set up.",
  );
});

test("plateLookupFailureLine: auth / credit / network / api errors all speak 'system is down right now'", () => {
  for (const reason of ["auth_error", "insufficient_credit", "network_error", "api_error"] as const) {
    assert.equal(
      plateLookupFailureLine("205, ", { reason }),
      "205, license plate system is down right now.",
      `reason=${reason}`,
    );
  }
});

test("plateLookupFailureLine: unknown / null reason falls back to the no-record line", () => {
  // The default branch must keep airtime moving — a silent transcript would
  // leave the requesting unit hanging.
  assert.equal(
    plateLookupFailureLine("205, ", null),
    "205, no return comes back to that license plate.",
  );
  assert.equal(
    plateLookupFailureLine("205, ", undefined),
    "205, no return comes back to that license plate.",
  );
  assert.equal(
    plateLookupFailureLine("205, ", { reason: "something_new" }),
    "205, no return comes back to that license plate.",
  );
});

test("plateLookupFailureLine: empty csPart still produces a complete sentence", () => {
  assert.equal(
    plateLookupFailureLine("", { reason: "no_record" }),
    "no return comes back to that license plate.",
  );
});

// ---------- vinLookupFailureLine ----------------------------------------

test("vinLookupFailureLine: 'no_record' references the VIN (not the plate)", () => {
  // This is the only branch where "VIN" must appear instead of "license
  // plate" — locking the contract so a future refactor that consolidates
  // these helpers doesn't accidentally read "license plate" for a VIN miss.
  assert.equal(
    vinLookupFailureLine("205, ", { reason: "no_record" }),
    "205, no return comes back to that VIN.",
  );
});

test("vinLookupFailureLine: 'invalid_vin' asks the unit to 10-9 (re-key)", () => {
  // 10-9 is the radio code for "repeat" — the VIN they sent didn't pass
  // the 17-char checksum so we want them to repeat it, not retry the
  // upstream lookup.
  assert.equal(
    vinLookupFailureLine("205, ", { reason: "invalid_vin" }),
    "205, negative on that vin, please 10-9 the transmission.",
  );
});

test("vinLookupFailureLine: 'not_configured' is its own line (system not set up)", () => {
  assert.equal(
    vinLookupFailureLine("205, ", { reason: "not_configured" }),
    "205, license plate system is not set up.",
  );
});

test("vinLookupFailureLine: auth / credit / network / api errors all speak 'system is down'", () => {
  for (const reason of ["auth_error", "insufficient_credit", "network_error", "api_error"] as const) {
    assert.equal(
      vinLookupFailureLine("205, ", { reason }),
      "205, license plate system is down right now.",
      `reason=${reason}`,
    );
  }
});

test("vinLookupFailureLine: unknown / null reason falls back to 'system is down' (NOT the no-record line)", () => {
  // Different fallback than plateLookupFailureLine — for VIN, the
  // no-default-no-record assumption is risky (we'd implicitly tell the
  // officer the VIN is bogus when the upstream is just unreachable).
  assert.equal(
    vinLookupFailureLine("205, ", null),
    "205, license plate system is down right now.",
  );
  assert.equal(
    vinLookupFailureLine("205, ", { reason: "totally_new_reason" }),
    "205, license plate system is down right now.",
  );
});

// ---------- webSearchFailureLine + webSearchNotConfiguredLine -----------

function webFail(reason: string): WebSearchResult {
  return { ok: false, reason };
}

test("webSearchFailureLine: 'no_api_key' → web lookup not configured", () => {
  assert.equal(
    webSearchFailureLine("352, ", webFail("no_api_key")),
    "352, I can't search that information, web lookup is not configured.",
  );
});

test("webSearchFailureLine: 'anthropic_required' → web lookup not configured", () => {
  // Anthropic is the upstream provider; an agency with no key gets the
  // same line as a totally unconfigured deployment. Don't leak provider
  // details to the officer's radio.
  assert.equal(
    webSearchFailureLine("352, ", webFail("anthropic_required")),
    "352, I can't search that information, web lookup is not configured.",
  );
});

test("webSearchFailureLine: 'timeout' → 'internet is not working, try again'", () => {
  // Timeout is recoverable on retry — the line includes "try again".
  assert.equal(
    webSearchFailureLine("352, ", webFail("timeout")),
    "352, internet is not working right now, try again.",
  );
});

test("webSearchFailureLine: api_error / exception / parse_error → 'internet is not working' (no retry hint)", () => {
  for (const reason of ["api_error", "exception", "parse_error"]) {
    assert.equal(
      webSearchFailureLine("352, ", webFail(reason)),
      "352, internet is not working right now.",
      `reason=${reason}`,
    );
  }
});

test("webSearchFailureLine: 'not_found' → 'I can't find that information' (information vs network)", () => {
  // Important contract: not_found means the search ran but had no hits.
  // The officer must hear "can't find" (so they know the lookup worked),
  // not "internet down" (which suggests retrying).
  assert.equal(
    webSearchFailureLine("352, ", webFail("not_found")),
    "352, I can't find that information.",
  );
});

test("webSearchFailureLine: unknown / undefined reason falls back to a generic 'can't search' line", () => {
  assert.equal(
    webSearchFailureLine("352, ", { ok: false }),
    "352, I can't search that information.",
  );
  assert.equal(
    webSearchFailureLine("352, ", webFail("brand_new_reason")),
    "352, I can't search that information.",
  );
});

test("webSearchNotConfiguredLine matches the failure-line 'no_api_key' branch verbatim (no drift)", () => {
  // The not-configured line is callable directly when the engine knows in
  // advance there's no key. It MUST emit the same string the failure-line
  // branch does, so a single fix to the wording stays in lock-step.
  assert.equal(
    webSearchNotConfiguredLine("352, "),
    webSearchFailureLine("352, ", webFail("no_api_key")),
  );
});

// ---------- generic lookup / CAD lines ---------------------------------

test("genericInfoLookupFailedLine: speaks 'I can't find that information.'", () => {
  // Used by request_info paths that don't fit the web / plate / CAD
  // taxonomy (local DB miss, address book miss). Lock the wording.
  assert.equal(
    genericInfoLookupFailedLine("352, "),
    "352, I can't find that information.",
  );
  assert.equal(genericInfoLookupFailedLine(""), "I can't find that information.");
});

test("cadSystemDownLine and cadLookupFailedLine produce DISTINCT lines", () => {
  // System-down means the upstream 10-8 host is unreachable (officer
  // should know to retry). Lookup-failed means we got a response but
  // couldn't extract what they wanted. The lines must read differently or
  // the officer can't tell whether to retry.
  assert.equal(
    cadSystemDownLine("352, "),
    "352, 10-8 CAD is down right now, try again.",
  );
  assert.equal(
    cadLookupFailedLine("352, "),
    "352, I can't find that information in CAD right now.",
  );
  assert.notEqual(cadSystemDownLine("352, "), cadLookupFailedLine("352, "));
});
