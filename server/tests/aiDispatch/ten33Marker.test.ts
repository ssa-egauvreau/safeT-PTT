/**
 * Regression tests for the 10-33 marker loop in
 * `server/src/aiDispatch/ten33Marker.ts`.
 *
 * The bug these pin: a manual 10-33 button push and the AI dispatcher both
 * activating the same channel's 10-33 each fired an *immediate* marker burst,
 * because `startTen33MarkerLoop` stopped and restarted the loop on every call —
 * so the tone double-played. Activation must be idempotent: once a channel's
 * 10-33 loop is armed, re-activating it (from either path) is a no-op until it
 * is explicitly cleared.
 *
 * The tests use `immediateBurst = false` so starting the loop does no network
 * I/O (no marker burst is played), and always stop the loop so the 12 s
 * interval never fires.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  startTen33MarkerLoop,
  stopTen33MarkerLoop,
  isTen33MarkerActive,
} from "../../src/aiDispatch/ten33Marker.js";

const AGENCY = 4242;
const CHANNEL = "GREEN 1";

function freshOpts() {
  return { loopbackPort: 0, agencyId: AGENCY, channelName: CHANNEL, unitId: "10-33" };
}

test("a channel starts with no 10-33 armed", (_t: TestContext) => {
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), false);
});

test("start arms the marker; stop clears it", (t: TestContext) => {
  t.after(() => stopTen33MarkerLoop(AGENCY, CHANNEL));

  startTen33MarkerLoop(freshOpts(), false);
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), true);

  stopTen33MarkerLoop(AGENCY, CHANNEL);
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), false);
});

test("re-activating an already-armed 10-33 is idempotent (no second loop/burst)", (t: TestContext) => {
  t.after(() => stopTen33MarkerLoop(AGENCY, CHANNEL));

  startTen33MarkerLoop(freshOpts(), false);
  const firstActive = isTen33MarkerActive(AGENCY, CHANNEL);

  // Second activation (e.g. the AI after a manual push, or vice-versa) must not
  // restart the loop — that restart is what fired the duplicate marker burst.
  startTen33MarkerLoop(freshOpts(), false);
  startTen33MarkerLoop(freshOpts(), false);

  assert.equal(firstActive, true);
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), true);

  // A single stop clears it (there is only ever one loop, not a stack).
  stopTen33MarkerLoop(AGENCY, CHANNEL);
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), false);
});

test("stop is safe to call when nothing is armed", (_t: TestContext) => {
  assert.doesNotThrow(() => stopTen33MarkerLoop(AGENCY, CHANNEL));
  assert.equal(isTen33MarkerActive(AGENCY, CHANNEL), false);
});
