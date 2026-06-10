/**
 * Tests for `server/src/billing/subscription.ts` pure helpers.
 *
 * `isBillingActive` is the gate the rest of the platform reads to decide
 * whether an agency is allowed to receive AI dispatch service, ingest new
 * transmissions, etc. A regression that:
 *
 *  - Returns `true` for `past_due` would silently keep failed-payment
 *    customers on the system after Stripe stopped collecting money.
 *  - Returns `false` for `trialing` would cut off paying customers' first
 *    seven days even though the trial is the documented onboarding path.
 *  - Returns `true` for an unrecognised string (e.g. a future Stripe
 *    state mapping bug) would re-enable canceled accounts.
 *
 * `trialDaysLeft` powers the badge in the admin Billing panel and the
 * trial-expiry sweep's UI hint. A regression that:
 *
 *  - Returns negative values when the trial has already lapsed would
 *    render "expires in -3 days" in the admin panel.
 *  - Rounds down (Math.floor) instead of up (Math.ceil) would tell a
 *    customer they have "0 days left" with several hours still on the
 *    clock — confusing during the actual conversion window.
 *  - Returns `0` instead of `null` for a never-started trial would
 *    force the suspend banner on every comped / paid account.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBillingActive,
  trialDaysLeft,
} from "../../src/billing/subscription.js";
import { SUBSCRIPTION_STATUSES } from "../../src/billing/types.js";

test("isBillingActive: returns true only for active / comped / trialing", () => {
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("comped"), true);
  assert.equal(isBillingActive("trialing"), true);
});

test("isBillingActive: returns false for past_due and canceled (paywall states)", () => {
  // These two states are exactly when the platform must lock new
  // transmissions out — a regression that flipped either to true would
  // give an unpaid customer free service.
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive: every documented status returns a defined boolean", () => {
  // Tripwire — adding a new SubscriptionStatus to types.ts without
  // updating isBillingActive() would slip through here as `undefined`.
  for (const status of SUBSCRIPTION_STATUSES) {
    const out = isBillingActive(status);
    assert.equal(typeof out, "boolean", `status ${status} must map to a boolean`);
  }
});

test("trialDaysLeft: returns null when the agency has no trial set", () => {
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft: returns 0 once the trial deadline has passed", (t) => {
  // Past trial — the sweep / suspend logic treats 0 as "expired now".
  // A negative number would mis-render in the admin Billing panel.
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal(trialDaysLeft(fiveMinAgo), 0);
});

test("trialDaysLeft: rounds up partial days so 'X days left' never under-reports", (t) => {
  // 2 days + 1 hour remaining must read as "3 days left", not "2".
  // The conversion CTA disappears at zero, so under-reporting would
  // tell a customer their trial is up before it actually is.
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(future), 3);
});

test("trialDaysLeft: returns 1 for the last day even if only minutes remain", (t) => {
  // Exactly the boundary: < 24 hours left → ceil(0-1) = 1.
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const futureMinutes = new Date(Date.now() + 5 * 60_000).toISOString();
  assert.equal(trialDaysLeft(futureMinutes), 1);
});

test("trialDaysLeft: 7-day trial reads as 7 immediately after sign-up", (t) => {
  // Mirrors `signup.ts` writing `Date.now() + TRIAL_DAYS * 24h`. The
  // admin Billing panel labels this "7 days left"; if we returned 8 it
  // would mis-promise an extra day on every signup.
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const trialEnds = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(trialEnds), 7);
});

test("trialDaysLeft: ignores agency local time — the input is an ISO timestamp", (t) => {
  // `subscription.ts` parses with `new Date(string)`, which is UTC-aware.
  // Pin that contract so a refactor that switches to a locale-dependent
  // parser (Date.parse with a non-ISO format) is caught.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1, 0, 0, 0) });
  const tomorrowUtcZ = "2026-01-02T00:00:00.000Z";
  assert.equal(trialDaysLeft(tomorrowUtcZ), 1);
});
