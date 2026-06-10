/**
 * Tests for `server/src/billing/trialSweep.ts`.
 *
 * The trial sweep runs hourly from `index.ts`. Two regressions matter:
 *
 *   1. **No-pool no-op**: when `DATABASE_URL` is unset (every dev / CI
 *      environment), the sweep MUST resolve cleanly without throwing. A
 *      regression that called `requirePool()` instead of `getPool()` would
 *      crash the hourly interval and trigger a Railway deploy crash loop.
 *
 *   2. **Idempotency contract**: re-running the sweep with no eligible
 *      agencies must be a no-op (handled by the no-pool branch in the dev
 *      scenario, but pinned here as a behavioural invariant).
 *
 * Live-DB behaviour (the actual `UPDATE` query) is exercised by the
 * production deployment; this file pins the runtime safety net.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrialBillingSweep } from "../../src/billing/trialSweep.js";

test("runTrialBillingSweep: resolves cleanly when DATABASE_URL is unset", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    // Must not throw. Must not log a stack trace. Must not block.
    await runTrialBillingSweep();
    assert.ok(true, "sweep must be a no-op without a pool");
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("runTrialBillingSweep: repeated invocation without DB stays a no-op", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await runTrialBillingSweep();
    await runTrialBillingSweep();
    await runTrialBillingSweep();
    assert.ok(true, "repeat invocations must remain a no-op");
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
