/**
 * Tests for the pure billing helpers in `server/src/billing/subscription.ts`.
 *
 * These two helpers gate every billing-aware code path on the server:
 *
 *  - `isBillingActive(status)` decides whether an agency is currently entitled
 *    to use paid features. A regression here either silently keeps a canceled
 *    customer on the service or wrongly locks out a paying one mid-shift, so
 *    we pin the full status table — `active`, `trialing`, and `comped` are the
 *    ONLY billing-active states, and `past_due`/`canceled` are not.
 *
 *  - `trialDaysLeft(trialEndsAt)` powers the "trial expires in N days" badge
 *    that admins see in the billing panel. The dangerous regressions are
 *    off-by-one bugs (still showing "1 day left" on an already-expired trial)
 *    and reporting `null` (i.e. "no trial") for an expired trial, which would
 *    make the panel claim the agency is on a permanent plan.
 *
 * The helpers are pure — no DB, no clock injection needed — so we drive them
 * with a fixed `Date.now` and explicit ISO strings.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { isBillingActive, trialDaysLeft } = await import("../../src/billing/subscription.js");
const { SUBSCRIPTION_STATUSES } = await import("../../src/billing/types.js");

test("isBillingActive: only active, trialing, and comped are billing-active", () => {
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("trialing"), true);
  assert.equal(isBillingActive("comped"), true);
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive: returns a boolean for every declared SubscriptionStatus", () => {
  for (const s of SUBSCRIPTION_STATUSES) {
    assert.equal(typeof isBillingActive(s), "boolean", `status ${s} must be classified`);
  }
});

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const ORIGINAL_NOW = Date.now;

beforeEach(() => {
  Date.now = () => NOW;
});

afterEach(() => {
  Date.now = ORIGINAL_NOW;
});

test("trialDaysLeft: null/empty trial timestamp returns null (not zero)", () => {
  assert.equal(trialDaysLeft(null), null);
  // Empty string is a falsy value the helper must treat the same as null —
  // it's a `null` field round-tripped through JSON, not "trial expired".
  assert.equal(trialDaysLeft("" as unknown as string), null);
});

test("trialDaysLeft: an already-expired trial collapses to 0, never a negative", () => {
  const yesterday = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(yesterday), 0);

  const longAgo = new Date(NOW - 14 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(longAgo), 0);
});

test("trialDaysLeft: exactly-now is treated as expired (0), not as a fresh day", () => {
  assert.equal(trialDaysLeft(new Date(NOW).toISOString()), 0);
});

test("trialDaysLeft: future trials are ceil'd up so any remaining time shows ≥1 day", () => {
  // 1 ms in the future → still ceils to a full day so the badge never
  // flickers to "0 days" while the agency is technically still trialing.
  assert.equal(trialDaysLeft(new Date(NOW + 1).toISOString()), 1);

  // 23h59m → still ceils to 1 day (a hard "1 day left").
  assert.equal(trialDaysLeft(new Date(NOW + 24 * 60 * 60 * 1000 - 1).toISOString()), 1);

  // Exactly +1 day → 1 (not 2).
  assert.equal(trialDaysLeft(new Date(NOW + 24 * 60 * 60 * 1000).toISOString()), 1);

  // +1 day +1 ms → 2 (the ceil bumps up).
  assert.equal(trialDaysLeft(new Date(NOW + 24 * 60 * 60 * 1000 + 1).toISOString()), 2);

  // The full 7-day trial.
  assert.equal(trialDaysLeft(new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString()), 7);
});
