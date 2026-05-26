/**
 * Build-shape smoke tests for `server/src/apiRoutes.ts` (and the modules it
 * pulls in transitively, including `voiceRelay.ts`).
 *
 * Why this file exists — three back-to-back PRs landed on `main` whose
 * three-way merges silently left **unparseable TypeScript** in
 * `server/src/apiRoutes.ts` (`GET /v1/audio/config` had two duplicated
 * `res.json` blocks and two `deriveDeviceAudioConfig` imports) and
 * `server/src/voiceRelay.ts` (a partial `unitChannelCountsFromRecords`
 * declaration whose body was replaced by an orphan JSDoc/interface).
 *
 * The existing per-module unit tests didn't catch it because they import
 * specific named helpers — they sit downstream of the parse failure but
 * don't exercise `createApiRouter()` as a whole, so the orphan merge
 * artifacts ride to production despite a green-looking suite.
 *
 * This smoke test plugs that hole. It is intentionally *low-detail*: all it
 * asks is that
 *
 *   1. `apiRoutes.ts` parses and its transitive imports load,
 *   2. `createApiRouter()` returns an Express router object that actually
 *      registered routes (so a "router exists but has zero stacks" silent
 *      collapse — caused by, e.g., a comment swallowing every `router.get`
 *      below a botched merge — still fails),
 *   3. `voiceRelay.ts` exports the live-control move-lock surface the
 *      router depends on for `withRosterMoveLock` / `isUnitMoveLocked`.
 *
 * If any of those is broken, the import at the top of the file throws at
 * test-collection time and the suite fails before any individual case
 * runs — which is exactly the signal we need.
 *
 * If you find yourself here because this test failed: the most likely
 * cause is a merge that concatenated two competing edits to one of the
 * files imported below. Look for duplicate `import` lines and duplicate
 * `res.json` / function signatures, not for a "real" router bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApiRouter } from "../src/apiRoutes.js";
import {
  unitChannelCounts,
  unitChannelCountsFromRecords,
  withRosterMoveLock,
  isUnitMoveLocked,
  __resetVoiceRosterForTest,
  __setVoiceRosterRecordForTest,
} from "../src/voiceRelay.js";

test("createApiRouter: module loads and returns an Express Router with registered routes", () => {
  const router = createApiRouter();
  assert.ok(router, "createApiRouter must return a value");
  // Express Router is a function (the middleware itself). A "broken merge"
  // that accidentally short-circuited `createApiRouter` to e.g. `undefined`
  // or a bare object would fail this check well before any HTTP call.
  assert.equal(typeof router, "function", "router must be invokable middleware");
  // Express stores registered route layers on `router.stack`. We don't pin
  // an exact count (the surface evolves) but we do require it be
  // non-trivial — a merge artifact that nuked every `router.METHOD(...)`
  // call below it would leave `stack.length === 0`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as unknown as { stack?: unknown[] }).stack;
  assert.ok(Array.isArray(stack), "router must expose a .stack array");
  assert.ok(
    (stack as unknown[]).length >= 10,
    `router must register many routes (got ${(stack as unknown[]).length})`,
  );
});

test("voiceRelay: live-control move-lock surface is fully exported", () => {
  // PR #149 + PR #150 both added overlapping move-lock helpers; a future
  // merge that drops or renames any of them will silently regress Live
  // Channel Control. Pin the surface here so the failure mode is "test
  // import threw" instead of "drag-drop is broken in production".
  assert.equal(typeof unitChannelCounts, "function");
  assert.equal(typeof unitChannelCountsFromRecords, "function");
  assert.equal(typeof withRosterMoveLock, "function");
  assert.equal(typeof isUnitMoveLocked, "function");
  assert.equal(typeof __resetVoiceRosterForTest, "function");
  assert.equal(typeof __setVoiceRosterRecordForTest, "function");
});

test("voiceRelay: unitChannelCounts and isUnitMoveLocked agree end-to-end", () => {
  // Integration-style sanity check: seed a dispatch-console session via
  // the test-only helper, then verify BOTH downstream consumers
  // (`unitChannelCounts` for the roster overlay, `isUnitMoveLocked` for
  // the live-control move endpoint) see it. A regression that broke the
  // shared `voiceRoster` map or the per-agency channelKey prefix in
  // either consumer alone would still pass that consumer's own unit
  // tests but would split the two views — drag-drop UI would say
  // "locked" while the API would happily move the unit, or vice versa.
  __resetVoiceRosterForTest();
  try {
    const AGENCY = 4242;
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Smoke Channel",
      unitId: "DISP-SMOKE",
      kind: "account",
      deviceType: "dispatch_console",
    });
    const counts = unitChannelCounts(AGENCY);
    assert.equal(counts.get("DISP-SMOKE"), 1, "console session must be counted");
    assert.equal(
      isUnitMoveLocked(AGENCY, "DISP-SMOKE"),
      true,
      "isUnitMoveLocked must agree with unitChannelCounts on the same roster state",
    );
    // Cross-agency isolation: a different agency must see nothing.
    assert.equal(unitChannelCounts(AGENCY + 1).size, 0);
    assert.equal(isUnitMoveLocked(AGENCY + 1, "DISP-SMOKE"), false);
  } finally {
    __resetVoiceRosterForTest();
  }
});
