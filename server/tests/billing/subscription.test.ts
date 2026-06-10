/**
 * Tests for `server/src/billing/subscription.ts` pure helpers.
 *
 * `isBillingActive` and `trialDaysLeft` are the two predicates the rest of the
 * app uses to decide whether a tenant should be able to log in, voice, and use
 * paid features. They are pure (no DB / no Stripe) so the contract is locked
 * down here. The agency-aware functions (`startCheckout`, `changePlan`, etc.)
 * require a live Postgres and a Stripe client and are exercised in higher-level
 * suites — this file is the regression net for the math.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { isBillingActive, trialDaysLeft } from "../../src/billing/subscription.js";
import { SUBSCRIPTION_STATUSES } from "../../src/billing/types.js";

const REAL_DATE_NOW = Date.now;

beforeEach(() => {
  // Each test re-pins Date.now via stub() below.
});

afterEach(() => {
  Date.now = REAL_DATE_NOW;
});

function stubNow(iso: string): void {
  const fixed = new Date(iso).getTime();
  Date.now = () => fixed;
}

test("isBillingActive: only active / comped / trialing unlock the platform", () => {
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("comped"), true, "manually-comped tenants stay live");
  assert.equal(isBillingActive("trialing"), true);
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive covers every status in SUBSCRIPTION_STATUSES (no silent fallthrough)", () => {
  // A new status added to the union without updating isBillingActive would be a
  // payment-affecting silent change. Catch it here.
  const seen = new Set<string>();
  for (const s of SUBSCRIPTION_STATUSES) {
    assert.equal(typeof isBillingActive(s), "boolean");
    seen.add(s);
  }
  assert.deepEqual(
    [...seen].sort(),
    ["active", "canceled", "comped", "past_due", "trialing"],
    "if this changes, audit isBillingActive's allow-list",
  );
});

test("trialDaysLeft returns null when no trial is set", () => {
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft returns 0 the instant the trial ends", () => {
  stubNow("2026-01-10T12:00:00.000Z");
  assert.equal(trialDaysLeft("2026-01-10T12:00:00.000Z"), 0);
});

test("trialDaysLeft returns 0 for a trial that ended in the past", () => {
  stubNow("2026-01-10T12:00:00.000Z");
  assert.equal(trialDaysLeft("2026-01-01T00:00:00.000Z"), 0);
});

test("trialDaysLeft rounds up partial days so the UI never displays '0 days left' before the trial actually ends", () => {
  stubNow("2026-01-10T12:00:00.000Z");
  // 1 millisecond left → still shows as 1 day so admins are not surprised.
  assert.equal(trialDaysLeft("2026-01-10T12:00:00.001Z"), 1);
  // ~1 hour left → still 1 day.
  assert.equal(trialDaysLeft("2026-01-10T13:00:00.000Z"), 1);
  // Exactly 24 hours left → 1 day.
  assert.equal(trialDaysLeft("2026-01-11T12:00:00.000Z"), 1);
  // 24 hours and 1 ms left → ceil to 2 days.
  assert.equal(trialDaysLeft("2026-01-11T12:00:00.001Z"), 2);
});

test("trialDaysLeft computes whole-day spans correctly", () => {
  stubNow("2026-01-10T00:00:00.000Z");
  assert.equal(trialDaysLeft("2026-01-17T00:00:00.000Z"), 7);
});
