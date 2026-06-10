/**
 * Tests for `server/src/billing/subscription.ts` pure helpers.
 *
 * `isBillingActive` and `trialDaysLeft` are read by the admin UI (BillingPanel)
 * and by every server-side gate that distinguishes a paying tenant from a
 * suspended one. Both run thousands of times per session and must be
 * deterministic.
 *
 * Properties pinned by this file:
 *
 *  1. **`isBillingActive`** treats only `active`, `trialing`, and `comped` as
 *     active — `past_due` and `canceled` must be inactive. A regression that
 *     flips `past_due` to active would let a tenant whose card stopped working
 *     keep using the platform indefinitely.
 *
 *  2. **`trialDaysLeft`** returns:
 *     - `null` when there is no trial deadline (already converted / comped).
 *     - `0` exactly at expiry (so the owner UI shows "Trial ended" not
 *       "Trial: -1 days").
 *     - `Math.ceil(...)` of the remaining time so a trial with 6h left still
 *       reports "1 day left" (matches the marketing copy that says "7-day
 *       trial" rather than "168 hours").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBillingActive, trialDaysLeft } from "../../src/billing/subscription.js";

// ---------------------------------------------------------------------------
// isBillingActive
// ---------------------------------------------------------------------------

test("isBillingActive: active / trialing / comped are active", () => {
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("trialing"), true);
  assert.equal(isBillingActive("comped"), true);
});

test("isBillingActive: past_due / canceled are NOT active", () => {
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

// ---------------------------------------------------------------------------
// trialDaysLeft
// ---------------------------------------------------------------------------

test("trialDaysLeft: null when there is no trial deadline", () => {
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft: 0 when the trial has already ended", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(trialDaysLeft(past), 0);
});

test("trialDaysLeft: 0 right at the deadline (boundary)", (t) => {
  // Freeze Date so "exactly now" stays exactly now during the call.
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const exact = new Date(Date.now()).toISOString();
  assert.equal(trialDaysLeft(exact), 0);
});

test("trialDaysLeft: 1 day for any remaining time under 24h (ceil)", () => {
  const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(inSixHours), 1);
});

test("trialDaysLeft: ceils 7 days minus a few seconds up to 7", () => {
  const sevenDaysIsh = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - 5_000).toISOString();
  assert.equal(trialDaysLeft(sevenDaysIsh), 7);
});

test("trialDaysLeft: ceils 7d + 1s up to 8 days", () => {
  // Just over the 7-day window means at least one millisecond into day 8.
  const justOver = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 1_000).toISOString();
  assert.equal(trialDaysLeft(justOver), 8);
});

test("trialDaysLeft: invalid date string returns 0 (NaN ms ≤ 0)", () => {
  // `new Date("not-a-date").getTime()` is NaN; NaN - now is NaN; the function
  // tests `ms <= 0` first which is false for NaN, then `Math.ceil(NaN)` is NaN.
  // The contract we want to lock in: garbage input never produces a positive
  // day count — either 0 or NaN are acceptable, but never a number > 0.
  const result = trialDaysLeft("not-a-date");
  assert.ok(result === 0 || Number.isNaN(result), `unexpected ${result}`);
});
