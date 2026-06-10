/**
 * Tests for `server/src/aiDispatch/dispatchWatchdog.ts`.
 *
 * `buildStaleUnassignedCallout` is the on-air line the dispatcher speaks
 * when an open 10-8 call has gone past its priority-specific stale
 * threshold without a unit assigned (the watchdog loop runs every 30s).
 * It is pure and built from a handful of CAD fields, but every regression
 * has a live-radio consequence:
 *
 *   - A null/blank incident_type must fall back to a speakable word
 *     ("call") so the dispatcher doesn't say "Dispatch, unassigned
 *     priority 1 , call 25-0001..." with a blank where the code goes.
 *   - A null/blank location must drop the "at <loc>" segment entirely
 *     rather than render "at undefined" or "at ".
 *   - The minute/minutes pluralisation must flip exactly at 1: "pending
 *     1 minute" vs "pending 2 minutes". A regression that always
 *     hard-codes plural reads wrong on the air.
 *   - The priority number is read verbatim, so the helper must not
 *     silently re-clamp a CAD priority that has already been normalised
 *     upstream — that's the watchdog's caller's job.
 *
 * `plateReadbackCad.test.ts` has a single happy-path smoke test; this
 * file pins every documented edge case in one place.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStaleUnassignedCallout } from "../../src/aiDispatch/dispatchWatchdog.js";

test("buildStaleUnassignedCallout: full happy path renders 'priority N <code> at <loc>'", () => {
  // The canonical line the dispatcher speaks. Locks in the exact
  // wording — radio dispatchers learn this verbatim, so changing
  // punctuation or word order would surface as confusion on the air.
  const line = buildStaleUnassignedCallout(
    "25-0129",
    "961 - Car Stop",
    "1806 N Batavia St, Orange, CA 92867",
    1,
    3,
  );
  assert.equal(
    line,
    "Dispatch, unassigned priority 1 961 at 1806 N Batavia St, Orange, call 25-0129, pending 3 minutes with no units assigned.",
  );
});

test("buildStaleUnassignedCallout: incident_type 'CODE - Description' speaks just the code", () => {
  // Pipes through callCodeForRadio so the dispatcher reads "415"
  // not "415 - Disturbing the Peace" — a regression would balloon
  // airtime by ~1.5s per stale-call callout.
  const line = buildStaleUnassignedCallout(
    "C-1",
    "415 - Disturbing the Peace",
    "1805 Main St, Anaheim",
    2,
    11,
  );
  assert.match(line, / 415 at 1805 Main St, Anaheim,/);
  assert.doesNotMatch(line, /Disturbing the Peace/i);
});

test("buildStaleUnassignedCallout: null incident_type falls back to 'call'", () => {
  // callCodeForRadio returns "call" on null. The dispatcher must not
  // speak an empty code or 'null'.
  const line = buildStaleUnassignedCallout("C-1", null, "1805 Main", 1, 5);
  assert.match(
    line,
    /Dispatch, unassigned priority 1 call at 1805 Main, call C-1, pending 5 minutes/,
  );
});

test("buildStaleUnassignedCallout: empty incident_type also falls back to 'call'", () => {
  // Mirrors the null path — CAD rows can ship empty strings, not null.
  assert.match(
    buildStaleUnassignedCallout("C-1", "", "1805 Main", 1, 5),
    / priority 1 call at 1805 Main, /,
  );
  assert.match(
    buildStaleUnassignedCallout("C-1", "   ", "1805 Main", 1, 5),
    / priority 1 call at 1805 Main, /,
  );
});

test("buildStaleUnassignedCallout: null location drops the 'at <loc>' segment", () => {
  // The `where = loc ? '${code} at ${loc}' : code` branch — when
  // shortenLocationForRadio returns "", the helper must NOT splice
  // an "at " with nothing after it.
  const line = buildStaleUnassignedCallout("C-1", "415", null, 3, 30);
  // The bare code stands in for `${code} at ${loc}` — no "at " segment.
  assert.match(line, /Dispatch, unassigned priority 3 415, call C-1,/);
  assert.doesNotMatch(line, /at undefined/);
  assert.doesNotMatch(line, /at ,/);
});

test("buildStaleUnassignedCallout: empty / whitespace location also drops the 'at <loc>' segment", () => {
  // shortenLocationForRadio("") and shortenLocationForRadio("   ")
  // both return "" — confirm the helper doesn't speak " at ," in
  // either case.
  for (const loc of ["", "   "]) {
    const line = buildStaleUnassignedCallout("C-1", "415", loc, 3, 30);
    assert.match(line, /priority 3 415, call C-1,/);
    assert.doesNotMatch(line, / at ,/);
  }
});

test("buildStaleUnassignedCallout: postal state+ZIP+USA are stripped from the spoken location", () => {
  // Inherits shortenLocationForRadio's contract: trim "STATE 12345"
  // and "USA" so the on-air readback stays tight.
  const line = buildStaleUnassignedCallout(
    "C-1",
    "415",
    "1805 Main Street, Anaheim, CA 92805, USA",
    1,
    7,
  );
  assert.match(line, /at 1805 Main Street, Anaheim,/);
  assert.doesNotMatch(line, /CA 92805/);
  assert.doesNotMatch(line, /USA/);
});

test("buildStaleUnassignedCallout: pending 1 minute speaks the singular 'minute'", () => {
  // The pluralisation pivot is exactly 1 — `${n} minute${n === 1 ? "" : "s"}`.
  const line = buildStaleUnassignedCallout("C-1", "415", null, 1, 1);
  assert.match(line, /pending 1 minute with no units assigned\.$/);
  assert.doesNotMatch(line, /1 minutes/);
});

test("buildStaleUnassignedCallout: pending 0 minutes still uses the plural form ('0 minutes')", () => {
  // The check is strict equality on 1, so 0 takes the plural branch.
  // The watchdog upstream clamps to >= 1 with Math.max so this is
  // mostly defensive — pin it so a refactor to "n !== 1" doesn't
  // change radio wording when zero somehow leaks through.
  const line = buildStaleUnassignedCallout("C-1", "415", null, 1, 0);
  assert.match(line, /pending 0 minutes with no units assigned\.$/);
});

test("buildStaleUnassignedCallout: pending 2+ minutes uses the plural form", () => {
  for (const n of [2, 3, 11, 60, 123]) {
    const line = buildStaleUnassignedCallout("C-1", "415", null, 1, n);
    assert.match(
      line,
      new RegExp(`pending ${n} minutes with no units assigned\\.$`),
      `expected '${n} minutes' for n=${n}`,
    );
  }
});

test("buildStaleUnassignedCallout: priority is read verbatim (1, 2, 3, 4)", () => {
  // The helper does not clamp the priority itself — the watchdog
  // already normalised it via clampTen8Priority before calling.
  // Pin that the helper just renders the integer.
  for (const p of [1, 2, 3, 4]) {
    const line = buildStaleUnassignedCallout("C-1", "415", null, p, 5);
    assert.match(
      line,
      new RegExp(`Dispatch, unassigned priority ${p} `),
      `expected 'priority ${p}' for p=${p}`,
    );
  }
});

test("buildStaleUnassignedCallout: call ID is interpolated verbatim (preserves dashes / formatting)", () => {
  // 10-8 call IDs follow `YY-NNNN`; the helper must not strip the
  // dash or zero-pad differently — operators read these back to
  // confirm receipt of the dispatcher's prompt.
  const line = buildStaleUnassignedCallout("25-0001", "415", null, 1, 5);
  assert.match(line, /, call 25-0001, /);
  const alt = buildStaleUnassignedCallout("ABC/123", "415", null, 1, 5);
  assert.match(alt, /, call ABC\/123, /);
});

test("buildStaleUnassignedCallout: ends with the exact sentinel phrase used for log greps + agent dashboards", () => {
  // The string "with no units assigned." is the marker the admin
  // dashboard and `grep` watchers key on to surface stale-call
  // callouts. Pin the exact phrase so a refactor doesn't break
  // observability tooling.
  const line = buildStaleUnassignedCallout("C-1", "415", "1805 Main", 1, 5);
  assert.ok(line.endsWith(" with no units assigned."));
});

test("buildStaleUnassignedCallout: only ONE comma separates 'priority N <where>' from ', call X'", () => {
  // Regression guard: when location was dropped, an earlier draft
  // produced "priority N <code> , call X" with a double space + comma.
  // Lock the canonical single-space-then-comma form.
  const line = buildStaleUnassignedCallout("C-1", "415", null, 1, 5);
  assert.match(line, /priority 1 415, call C-1,/);
  assert.doesNotMatch(line, / +,/);
});
