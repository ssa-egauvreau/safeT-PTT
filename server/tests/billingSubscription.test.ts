/**
 * Tests for the pure helpers in `server/src/billing/subscription.ts`.
 *
 * `isBillingActive` and `trialDaysLeft` are tiny but they are the load-bearing
 * predicates the dispatch console, the 403 webhook gate in `apiRoutes.ts`, and
 * the trial-banner UI all read. A regression in either is silent in
 * `tsc --noEmit` and only surfaces as a customer-visible "agency suspended"
 * banner that flickers at the wrong time, or a Stripe-paid agency getting
 * gated as if its trial had lapsed.
 *
 * These functions have no DB or HTTP dependency, so they can be exercised as
 * straight unit tests with deterministic clock values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBillingActive,
  trialDaysLeft,
} from "../src/billing/subscription.js";
import type { SubscriptionStatus } from "../src/billing/types.js";
import { SUBSCRIPTION_STATUSES } from "../src/billing/types.js";

test("isBillingActive: trialing/active/comped open the platform", () => {
  // The 403 middleware in `apiRoutes.ts` keys off this exact set: a trial
  // user, a paying user, and a comped (back-channel platform owner override)
  // user must all reach the platform. If a future refactor narrows the
  // definition (e.g. drops `comped`), the platform owner can no longer keep a
  // partner agency online without a Stripe subscription on file.
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("trialing"), true);
  assert.equal(isBillingActive("comped"), true);
});

test("isBillingActive: past_due/canceled lock out", () => {
  // A failed-charge subscription (`past_due`) and a fully canceled
  // subscription must both be treated as inactive — the trial sweep and the
  // webhook handler both rely on this to disable agencies. If `past_due`
  // suddenly mapped to "active", a tenant with a permanently failing card
  // could keep using the radio platform indefinitely.
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive: covers every value in SUBSCRIPTION_STATUSES (no silent expansion)", () => {
  // If a new status is added to `SubscriptionStatus`, this loop forces the
  // author to choose a side and update `isBillingActive` accordingly. Without
  // this, a new "paused" or "trial_expired" value would silently fall to
  // `false` (locking out the tenant) or `true` (letting them keep using a
  // dead subscription) depending on how the new branch is added.
  const handled = new Set<SubscriptionStatus>([
    "active",
    "trialing",
    "comped",
    "past_due",
    "canceled",
  ]);
  for (const status of SUBSCRIPTION_STATUSES) {
    assert.ok(
      handled.has(status),
      `SUBSCRIPTION_STATUSES added "${status}" — update isBillingActive coverage`,
    );
  }
});

test("trialDaysLeft: null trial_ends_at returns null (paid tenants never see a trial banner)", () => {
  // The console renders the trial banner only when `trial_days_left != null`.
  // A paying / comped tenant has `trial_ends_at = NULL`, and the helper must
  // return `null` (not 0) so the banner never appears for them. Returning 0
  // here would render "0 trial days left" to a customer paying full price.
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft: trial in the past returns 0, not a negative number", () => {
  // The 0 floor is what the trial-sweep cron and the dispatch-console banner
  // both use to detect a fully expired trial. A negative count would round
  // wrong in the UI ("-3 days left") and the sweep would still attempt to
  // disable the agency, but downstream display code is allowed to treat 0 as
  // "expired today / already expired". Pin the contract.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(oneHourAgo), 0);
});

test("trialDaysLeft: future trial uses ceil, so the last calendar day still shows ≥1", () => {
  // The implementation uses `Math.ceil(ms / day)`. With a trial expiring in
  // 30 minutes, the user must still see "1 day left" in the UI — never 0,
  // which would falsely tell them the trial is over even though they still
  // have access. Catches a regression that swapped ceil for floor or round.
  const halfHourAhead = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(halfHourAhead), 1);
});

test("trialDaysLeft: a trial 6½ days out rounds up to 7 days for the dashboard", () => {
  // Sanity check on the headline value. A trial that's a bit over six days
  // out must display as 7 (the ceil of 6.5) — not 6 (off-by-one floor) and
  // not 8 (the helper accidentally adding a day). The marketing site
  // quotes "7-day free trial"; the dashboard label must agree on day 0.
  const sixAndHalfDaysOut = new Date(
    Date.now() + 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
  ).toISOString();
  assert.equal(trialDaysLeft(sixAndHalfDaysOut), 7);
});

test("trialDaysLeft: trial expiring exactly now returns 0 (not 1)", () => {
  // Boundary case — a trial whose `trial_ends_at` is "now" has `ms <= 0` and
  // must short-circuit to 0. Without the explicit `if (ms <= 0) return 0;`
  // branch, the ceil of a tiny negative would land on 0 or -0 unpredictably
  // depending on JS engine. Locks the boundary.
  const now = new Date(Date.now() - 1).toISOString(); // 1 ms in the past — handled by the <= branch.
  assert.equal(trialDaysLeft(now), 0);
});
