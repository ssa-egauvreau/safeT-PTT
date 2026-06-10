/**
 * Tests for `server/src/billing/trialSweep.ts`.
 *
 * This sweep runs hourly (see `index.ts`) and disables agencies whose
 * 7-day local trial expired without converting to a paid Stripe
 * subscription. It is critical that the no-DB code path (in-memory dev
 * mode + Cloud Agent VM without DATABASE_URL) be a clean no-op:
 *
 *  - If the sweep threw on a missing pool, every dev / Cloud Agent
 *    boot would log a noisy crash on the first hourly tick (the
 *    server-wide `setInterval` in `index.ts` doesn't catch
 *    rejections cleanly).
 *  - If the sweep tried to `requirePool()` instead of `getPool()`, it
 *    would crash the entire process because `requirePool` throws
 *    `database_unavailable`.
 *
 * That contract — "no DB → return cleanly, no work, no throw" — is the
 * one piece of trial-sweep logic we can pin without standing up a real
 * Postgres in the test runner.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { runTrialBillingSweep } from "../../src/billing/trialSweep.js";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (ORIGINAL_DB_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DB_URL;
  }
});

test("runTrialBillingSweep: returns cleanly when no database is configured", async () => {
  // Cloud Agent VM and local dev frequently boot without
  // DATABASE_URL. A regression that called `requirePool()` here would
  // throw `database_unavailable` and crash the hourly sweep timer.
  await assert.doesNotReject(runTrialBillingSweep());
});

test("runTrialBillingSweep: resolves with undefined (no return value)", async () => {
  // The caller in `index.ts` doesn't read the return value, but pin
  // the contract so a refactor that started returning a counter
  // doesn't accidentally introduce a Promise<unknown> that the caller
  // mishandles.
  const result = await runTrialBillingSweep();
  assert.equal(result, undefined);
});
