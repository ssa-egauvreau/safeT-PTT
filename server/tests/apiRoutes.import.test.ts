/**
 * Smoke import test for `server/src/apiRoutes.ts`.
 *
 * Why this exists
 * ---------------
 * `apiRoutes.ts` is the single Express router that mounts every `/v1/*`
 * endpoint — admin, owner, analytics, audio config, radio, 10-8, AI dispatch
 * webhooks, the Android OTA self-updater, and so on. It also pulls in
 * essentially every other server module transitively, so a syntax error,
 * duplicate import, or bad merge anywhere in those files surfaces here at
 * parse time.
 *
 * Until this test existed, nothing in `npm test` actually imported the
 * router — every other suite imports the leaf helpers (`audioConfig.ts`,
 * `analytics.ts`, `voiceRelay.ts`, etc.) directly — so the test suite would
 * report a green run while the production server failed to compile.
 *
 * That is exactly what happened when PRs #141 and #142 both extracted the
 * `deriveDeviceAudioConfig` helper (#141 into `audioConfig.ts`, #142 into
 * `audioConfigDerive.ts`) and the merge of the two on `main` left
 * `apiRoutes.ts` with:
 *
 *   - a duplicate `import { deriveDeviceAudioConfig } from ...` declaration
 *   - a partially-rewritten `GET /v1/audio/config` handler with a stray
 *     `const summary = ...` interleaved with a half-closed `res.json({ ... })`
 *
 * `tsc --noEmit` rejected the file with six TS1005 errors, but
 * `npm test` still passed all 548 suites because none of them touched the
 * router. The Android handsets — which call `GET /v1/audio/config` on every
 * reconnect to learn the agency mic-processing chain — would have stopped
 * receiving any config update the moment the next build attempted to ship.
 *
 * What this pins
 * --------------
 *
 *   1. `apiRoutes.ts` parses cleanly as ES modules under the same tsx loader
 *      the test runner uses.
 *   2. `createApiRouter` is exported and is a function.
 *   3. `createApiRouter()` returns an Express Router instance with the stack
 *      populated (i.e. at least the public routes registered at the top of
 *      the function body actually mounted) so a future regression that
 *      silently throws inside the factory still fails the test instead of
 *      shipping an empty router.
 *
 * Determinism: the router is built without touching the database (the
 * server is explicitly designed to boot without DATABASE_URL — see
 * `AGENTS.md` "Key caveats"). The factory only constructs an `express.Router`
 * and registers handlers; no I/O runs until a request actually arrives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("apiRoutes.ts: module imports cleanly under the test loader", async () => {
  // Using a dynamic import so a syntactic failure surfaces as a test
  // failure (rejected promise) rather than crashing the runner before any
  // assertion executes. The path matches the `.js` ESM extension the source
  // uses for cross-module imports.
  const mod = await import("../src/apiRoutes.js");
  assert.equal(
    typeof mod.createApiRouter,
    "function",
    "expected apiRoutes.ts to export a createApiRouter factory function",
  );
});

test("apiRoutes.ts: createApiRouter() returns a populated Express Router", async () => {
  const { createApiRouter } = await import("../src/apiRoutes.js");
  const router = createApiRouter();
  // express.Router instances are exposed as functions with attached
  // metadata. The `.stack` property is the array of registered layers — if
  // construction silently aborted partway through, the stack would be
  // empty (or much shorter than the dozens of routes the file declares).
  assert.equal(typeof router, "function", "router must be a function (express middleware)");
  const stack = (router as unknown as { stack?: unknown[] }).stack;
  assert.ok(Array.isArray(stack), "router.stack should be an array of layers");
  assert.ok(
    (stack as unknown[]).length > 50,
    `expected createApiRouter() to register many routes, got ${(stack as unknown[]).length}`,
  );
});
