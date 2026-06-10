/**
 * Tests for the pure-logic helpers in `server/src/billing/subscription.ts`.
 *
 * The async helpers in this module wrap DB + Stripe calls, but two pieces
 * are pure and gate critical product behaviour:
 *
 *  - `isBillingActive(status)` is the "is this agency allowed to use the
 *    radio?" predicate. The router-level middleware in `apiRoutes.ts`
 *    suspends agencies once Stripe flips the subscription to past_due /
 *    canceled. A regression that classified `past_due` as active would let
 *    a non-paying tenant keep operating; a regression that excluded
 *    `comped` would lock every grandfathered tenant out of their own
 *    console on the next deploy.
 *
 *  - `trialDaysLeft(trialEndsAt)` powers both the admin BillingPanel
 *    countdown and the hourly `runTrialBillingSweep` that auto-suspends
 *    expired trials. Off-by-one or rounding errors here translate
 *    directly into "trial expired a day early" customer complaints.
 *
 * These are pure functions, so the tests pin behaviour with no DB or
 * Stripe stubs required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isBillingActive, trialDaysLeft } from "../src/billing/subscription.js";
import { SUBSCRIPTION_STATUSES } from "../src/billing/types.js";

test("isBillingActive: active / trialing / comped all unlock the platform", () => {
  // These three are the only statuses that should keep the radio working.
  // A regression that dropped any one would lock customers out without warning:
  //  - active   = paying customer in good standing
  //  - trialing = inside the 7-day Stripe trial
  //  - comped   = grandfathered tenant (default for legacy single-tenant rows
  //               from `ensureSchema`'s billing backfill)
  assert.equal(isBillingActive("active"), true);
  assert.equal(isBillingActive("trialing"), true);
  assert.equal(isBillingActive("comped"), true);
});

test("isBillingActive: past_due and canceled lock the agency out", () => {
  // If Stripe escalates an unpaid invoice to past_due the agency must lose
  // access to keep this from being a free service. Same for canceled.
  // A regression that returned true here would defeat the whole billing
  // gate at the router middleware (see `agency_suspended_billing` 403).
  assert.equal(isBillingActive("past_due"), false);
  assert.equal(isBillingActive("canceled"), false);
});

test("isBillingActive: covers every status declared in SUBSCRIPTION_STATUSES", () => {
  // Belt-and-suspenders: if someone adds a new SubscriptionStatus value
  // they must also decide whether it counts as active. Without this loop,
  // a new "pending_payment" status could silently default to inactive
  // (or worse, sneak through the truthy branch if the type widens).
  const expected = new Set<string>(["active", "trialing", "comped"]);
  for (const status of SUBSCRIPTION_STATUSES) {
    const got = isBillingActive(status);
    const want = expected.has(status);
    assert.equal(
      got,
      want,
      `isBillingActive(${status}) returned ${got}, expected ${want}. ` +
        `If a new status was added, update both this set and the production gate.`,
    );
  }
});

test("trialDaysLeft: null trial end → null (grandfathered / comped tenants)", () => {
  // Most tenants seeded via the schema backfill have a NULL trial_ends_at
  // because they're `comped`. The BillingPanel renders "—" when this is
  // null, so a regression returning 0 would falsely show "trial expired"
  // for every grandfathered agency.
  assert.equal(trialDaysLeft(null), null);
});

test("trialDaysLeft: expired trial returns 0 — never negative", () => {
  // The hourly trial-sweep query in `runTrialBillingSweep` selects rows
  // where `trial_ends_at < now()`, then disables them. A negative return
  // value would still display in the admin panel as `-3 days left` which
  // is nonsensical UX. The clamp to 0 keeps the panel honest.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(yesterday), 0);

  // Exactly at the boundary (ms-precision tie) is treated as expired.
  // The `<= 0` short-circuit guarantees this.
  const now = new Date().toISOString();
  assert.equal(trialDaysLeft(now), 0);
});

test("trialDaysLeft: rounds UP partial days so admins never see '0 days left' until expiry", () => {
  // If a trial ends in 6h, the admin panel should still say "1 day left"
  // — collapsing this to 0 would prematurely scare a customer into
  // upgrading. `Math.ceil` is the chosen behaviour; this pins it.
  const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(sixHoursFromNow), 1);

  // ~6.5 days out should round up to 7 (or report 6 if rounding is wrong).
  // A regression to Math.floor would consistently under-report.
  const almostSevenDays = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000).toISOString();
  assert.equal(trialDaysLeft(almostSevenDays), 7);
});

test("trialDaysLeft: full 7-day trial reports 7", () => {
  // The signup flow sets `trial_ends_at = now + TRIAL_DAYS * 24h`. The
  // remaining time at the read site is slightly less than 7 full days
  // (some ms have elapsed between signup and the status read), which
  // `Math.ceil` rounds back up to 7. A regression to `Math.floor` would
  // immediately render "6 days left" the moment the user finishes signup.
  const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - 1000).toISOString();
  assert.equal(trialDaysLeft(sevenDays), 7);
});
