/**
 * Tests for `server/src/aiDispatch/dispatchWatchdog.ts`.
 *
 * `buildStaleUnassignedCallout` is the wording the AI dispatcher SPEAKS on
 * every channel when a CAD call has been sitting unassigned past its
 * priority threshold (2 / 10 / 30 / 60 minutes for P1–P4). It runs on a
 * 30-second loop across every agency / channel that has AI dispatch
 * enabled, so a regression is high blast-radius in three different
 * directions:
 *
 *   1. Pulling the wrong call code into the on-air callout (e.g. reading
 *      the whole "415 - Disturbing the Peace, Single Subject" instead of
 *      "415") makes the bot ramble on a live radio channel.
 *   2. Pulling the wrong location text (e.g. echoing "Anaheim, CA 92805,
 *      USA") makes the announcement long and useless to the field.
 *   3. Singular/plural ("1 minute" vs "1 minutes") is a silly tell that
 *      the audio came from a bot — keep the grammar correct so it sounds
 *      like a dispatcher.
 *
 * These tests pin the wording contract so it can't drift silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStaleUnassignedCallout } from "../../src/aiDispatch/dispatchWatchdog.js";

test("buildStaleUnassignedCallout: standard priority callout with code + shortened location", () => {
  const out = buildStaleUnassignedCallout(
    "C-1234",
    "415 - Disturbing the Peace",
    "100 Disney Way, Anaheim, CA 92802",
    2,
    7,
  );
  // "415 - Disturbing the Peace" → just "415" via callCodeForRadio.
  // The trailing "CA 92802" is stripped via shortenLocationForRadio so the
  // bot says the human-friendly part of the address only.
  assert.ok(out.startsWith("Dispatch, unassigned priority 2 415 at "), out);
  assert.ok(out.includes("100 Disney Way"), out);
  assert.ok(out.includes("Anaheim"), out);
  assert.ok(!out.includes("CA 92802"), `must strip state/zip, got: ${out}`);
  assert.ok(!out.includes("USA"), `must strip USA, got: ${out}`);
  assert.ok(out.includes("call C-1234"), out);
  assert.ok(out.endsWith("pending 7 minutes with no units assigned."), out);
});

test("buildStaleUnassignedCallout: singular minute uses 'minute' not 'minutes'", () => {
  const out = buildStaleUnassignedCallout(
    "C-1",
    "961 - Vehicle Stop",
    "1 Main St, Anaheim, CA",
    3,
    1,
  );
  assert.ok(
    out.endsWith("pending 1 minute with no units assigned."),
    `singular minute should drop the 's', got: ${out}`,
  );
});

test("buildStaleUnassignedCallout: plural minutes (>1) keeps the 's'", () => {
  for (const minutes of [2, 5, 30, 60, 120]) {
    const out = buildStaleUnassignedCallout("C-2", "415", "1 Main St", 4, minutes);
    assert.ok(
      out.endsWith(`pending ${minutes} minutes with no units assigned.`),
      `plural minutes for ${minutes}, got: ${out}`,
    );
  }
});

test("buildStaleUnassignedCallout: priority appears verbatim in the callout", () => {
  for (const priority of [1, 2, 3, 4]) {
    const out = buildStaleUnassignedCallout("C-3", "415", "1 Main St", priority, 5);
    assert.ok(
      out.includes(`unassigned priority ${priority} `),
      `priority ${priority} must appear in callout, got: ${out}`,
    );
  }
});

test("buildStaleUnassignedCallout: blank or null location omits the 'at X' phrase entirely", () => {
  // The watchdog must never speak "415 at " (trailing "at") just because
  // CAD didn't have a location string — keep the radio language clean.
  for (const blank of [null, "", "   "]) {
    const out = buildStaleUnassignedCallout("C-4", "415 - Disturb", blank, 2, 5);
    assert.ok(
      out.startsWith("Dispatch, unassigned priority 2 415, call C-4, "),
      `blank location (${JSON.stringify(blank)}) must drop "at"; got: ${out}`,
    );
    assert.ok(!/\bat\b\s*,/.test(out), `must not emit "at ," got: ${out}`);
    assert.ok(!/\bat\s+,/.test(out), `must not emit dangling at, got: ${out}`);
  }
});

test("buildStaleUnassignedCallout: incident type with code prefix is shortened to just the code", () => {
  // The full type "459 - Burglary in Progress" is too long to read on the
  // radio; the watchdog must collapse to just the radio code.
  const out = buildStaleUnassignedCallout(
    "C-5",
    "459 - Burglary in Progress",
    "200 Oak Ave",
    1,
    2,
  );
  assert.ok(out.includes(" 459 at "), `must read just the code, got: ${out}`);
  assert.ok(!out.includes("Burglary"), `must not read the description, got: ${out}`);
});

test("buildStaleUnassignedCallout: bare leading code (e.g. '415e') is preserved verbatim", () => {
  // "415e" is a real 10-8 code variant — the radio code extractor must keep
  // the suffix letter, not silently drop it (the field treats 415 and 415e
  // as distinct call types).
  const out = buildStaleUnassignedCallout("C-6", "415e", "1 Main St", 2, 3);
  assert.ok(out.includes(" 415e at "), `must preserve code variant, got: ${out}`);
});

test("buildStaleUnassignedCallout: incident type with no leading code reads as-is", () => {
  // "Issue Notice" has no numeric code — read the whole phrase rather than
  // dropping to a generic "call" label.
  const out = buildStaleUnassignedCallout("C-7", "Issue Notice", "1 Main St", 4, 10);
  assert.ok(out.includes(" Issue Notice at "), `must read the phrase, got: ${out}`);
});

test("buildStaleUnassignedCallout: null incident type falls back to 'call'", () => {
  // CAD sometimes returns an incident without a `type` field. Keep the
  // callout grammatically valid by saying "unassigned priority 2 call at ..."
  // instead of leaking "undefined" or an empty string.
  const out = buildStaleUnassignedCallout("C-8", null, "1 Main St", 2, 5);
  assert.ok(out.includes(" call at "), `null type must read as 'call', got: ${out}`);
});

test("buildStaleUnassignedCallout: call_id is read out verbatim (case-sensitive, hyphens kept)", () => {
  const out = buildStaleUnassignedCallout("INC-2025-0001", "415", "1 Main St", 3, 5);
  assert.ok(out.includes("call INC-2025-0001"), `must echo full call id, got: ${out}`);
});

test("buildStaleUnassignedCallout: location with embedded country/state/zip is shortened", () => {
  const out = buildStaleUnassignedCallout(
    "C-9",
    "415",
    "100 Disney Way, Anaheim, CA 92802, USA",
    2,
    5,
  );
  // Only the first two human-readable parts are kept; state, zip, USA dropped.
  assert.ok(out.includes("100 Disney Way"), out);
  assert.ok(out.includes("Anaheim"), out);
  assert.ok(!out.includes("92802"), `zip must be stripped, got: ${out}`);
  assert.ok(!out.includes("USA"), `USA must be stripped, got: ${out}`);
});

test("buildStaleUnassignedCallout: pendingMinutes=0 still grammatical (uses plural)", () => {
  // The watchdog's tick code passes Math.max(1, ...) so this should not
  // happen in production, but the helper must not crash or emit "0 minute"
  // ungrammatically if a caller does pass 0.
  const out = buildStaleUnassignedCallout("C-10", "415", "1 Main St", 4, 0);
  assert.ok(
    out.endsWith("pending 0 minutes with no units assigned."),
    `zero minutes must use plural form, got: ${out}`,
  );
});
