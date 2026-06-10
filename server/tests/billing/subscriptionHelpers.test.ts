/**
 * Pure-function tests for the billing helpers in
 * `server/src/billing/subscription.ts`.
 *
 * `isBillingActive` is the predicate the auth middleware uses to decide
 * whether a token-bearing user can keep talking to the API after the trial
 * ends or a subscription lapses (see `apiRoutes.ts` ~line 571 — the
 * `billingSuspend` derivation directly mirrors this set). A regression that
 * accidentally widens or narrows the "active" set would either let unpaid
 * agencies keep transmitting or, worse, lock out paying customers.
 *
 * `trialDaysLeft` powers the trial countdown in the admin Billing panel and
 * the `runTrialBillingSweep` decision indirectly (the sweep uses raw SQL but
 * the human-facing UI relies on this number being correct). We pin the
 * boundaries — past, exactly-now, and future — so a future refactor that
 * swaps `Math.ceil` for `Math.floor` or off-by-one on the millisecond split
 * fails immediately rather than only being noticed when an admin sees a
 * negative day count in production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBillingActive,
  trialDaysLeft,
} from "../../src/billing/subscription.js";
import { SUBSCRIPTION_STATUSES } from "../../src/billing/types.js";

test("isBillingActive: 'active', 'comped', and 'trialing' allow service", () => {
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("comped"), true);
  assert.equal(isBillingActive("trialing"), true);
});

test("isBillingActive: 'past_due' and 'canceled' block service", () => {
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive: covers every documented SubscriptionStatus value", () => {
  // Belt-and-braces: if a new status is added to the union later, this
  // test forces us to make a conscious decision about whether it is
  // billable. Forgetting to update `isBillingActive` for a new status
  // would let unpaid agencies keep service.
  for (const status of SUBSCRIPTION_STATUSES) {
    const result = isBillingActive(status);
    assert.equal(typeof result, "boolean", `${status} must map to a boolean`);
  }
  // Pin the current set so a future addition is forced through code review.
  const expected = new Set(["active", "comped", "trialing"]);
  for (const status of SUBSCRIPTION_STATUSES) {
    assert.equal(
      isBillingActive(status),
      expected.has(status),
      `unexpected isBillingActive(${status})`,
    );
  }
});

test("trialDaysLeft: null trial_ends_at returns null (not 0 / not NaN)", () => {
  // Owner-comped or already-converted agencies have no trial end date.
  // Returning 0 here would render "Trial: 0 days left" in the admin UI;
  // null lets the panel hide the row entirely.
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft: trial that ended in the past returns 0 (not negative)", () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(yesterday), 0);
});

test("trialDaysLeft: a trial that ended exactly at now() returns 0", () => {
  const now = new Date().toISOString();
  assert.equal(trialDaysLeft(now), 0);
});

test("trialDaysLeft: a trial 30 minutes from now still rounds up to 1 day", () => {
  // `Math.ceil` on the day fraction is intentional — the admin should see
  // "1 day left" until the clock actually rolls over, not "0 days left"
  // for the last 23 hours of the trial.
  const in30Min = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(in30Min), 1);
});

test("trialDaysLeft: a trial 6.5 days from now reports 7", () => {
  const ms = 6.5 * 24 * 60 * 60 * 1000;
  const future = new Date(Date.now() + ms).toISOString();
  assert.equal(trialDaysLeft(future), 7);
});

test("trialDaysLeft: a trial exactly TRIAL_DAYS away rounds to 7", () => {
  // The signup flow stamps `trial_ends_at = now + 7 days`. On the same
  // request that completes signup the panel must show "7 days left", not
  // 6 (off-by-one) or 8 (over-counting).
  const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const days = trialDaysLeft(sevenDays);
  assert.ok(days === 7, `expected 7, got ${days}`);
});
