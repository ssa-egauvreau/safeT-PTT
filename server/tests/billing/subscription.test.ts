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
  isAgencyBillingSuspended,
  isBillingActive,
  trialDaysLeft,
} from "../../src/billing/subscription.js";
import { SUBSCRIPTION_STATUSES } from "../../src/billing/types.js";
import type { AgencyRow } from "../../src/store.js";

/** Minimal agency-row factory for billing-suspend tests. The helper only
 * looks at three columns, so the rest of `AgencyRow` is irrelevant to
 * the predicate — but we still type-cast through `unknown` so a future
 * widening of the input shape forces this fixture to grow.
 */
function agency(
  overrides: Partial<
    Pick<AgencyRow, "signup_completed_at" | "subscription_status" | "trial_ends_at">
  >,
): AgencyRow {
  const base = {
    signup_completed_at: "2026-01-01T00:00:00.000Z" as string | null,
    subscription_status: "past_due" as AgencyRow["subscription_status"],
    trial_ends_at: null as string | null,
  };
  return { ...base, ...overrides } as unknown as AgencyRow;
}

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

// ---------------------------------------------------------------------------
// isAgencyBillingSuspended
//
// The per-request auth middleware in `apiRoutes.ts` calls this helper for
// every disabled agency to decide between the `agency_disabled` and
// `agency_suspended_billing` error codes. The web console reads the
// `billing_suspend` boolean to decide whether to show the "Reactivate
// billing" CTA. Two failure modes the tests below catch:
//
//  - Returning `true` for a legacy / seeded agency would tell every
//    admin-disabled tenant "you can pay to reactivate" even though that
//    agency has never had a Stripe subscription at all.
//  - Returning `false` for an expired-trial tenant would hide the
//    self-service reactivation path and make the admin look stuck behind
//    a generic "agency disabled" error.
// ---------------------------------------------------------------------------

test("isAgencyBillingSuspended: returns false for a null agency (no row to inspect)", () => {
  // Defensive — the middleware passes whatever `getAgencyById` returned.
  // A regression that crashed on null would 500 the whole disabled-agency
  // request instead of returning a clean 403 with the right error code.
  assert.equal(isAgencyBillingSuspended(null), false);
});

test("isAgencyBillingSuspended: returns false when signup never completed (seed / admin-created agency)", () => {
  // The legacy Default Agency and any owner-created tenant have a null
  // `signup_completed_at`. They were never on a Stripe subscription, so
  // an admin-driven disable is NOT a billing suspension — flipping this
  // to true would let the web console show "Reactivate billing" on
  // accounts that don't have a billing path at all.
  assert.equal(
    isAgencyBillingSuspended(
      agency({ signup_completed_at: null, subscription_status: "canceled" }),
    ),
    false,
  );
  assert.equal(
    isAgencyBillingSuspended(
      agency({ signup_completed_at: null, subscription_status: "past_due" }),
    ),
    false,
  );
});

test("isAgencyBillingSuspended: returns false when the subscription is comped (manual platform grant)", () => {
  // `comped` is set manually by the platform owner and never collapses
  // from any Stripe state (see webhooks.test.ts). A comped agency is
  // never billing-suspended — if it's disabled, an admin did it.
  assert.equal(
    isAgencyBillingSuspended(agency({ subscription_status: "comped" })),
    false,
  );
});

test("isAgencyBillingSuspended: returns false for an active subscription (paid customer disabled by admin)", () => {
  // A paying customer who was disabled by an admin / owner action MUST
  // NOT see the "Reactivate billing" CTA — they're already paid.
  assert.equal(
    isAgencyBillingSuspended(agency({ subscription_status: "active" })),
    false,
  );
});

test("isAgencyBillingSuspended: returns false during a still-valid trial (trial_ends_at in the future)", (t) => {
  // A signed-up trial customer who was disabled mid-trial is NOT
  // billing-suspended — their trial is still good. Pin this so the
  // sweep that runs `runTrialBillingSweep()` doesn't accidentally trip
  // billing reactivation UI for tenants who simply got admin-disabled
  // during their valid trial.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1, 0, 0, 0) });
  const trialEndsTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isAgencyBillingSuspended(
      agency({ subscription_status: "trialing", trial_ends_at: trialEndsTomorrow }),
    ),
    false,
  );
});

test("isAgencyBillingSuspended: returns true once the trial has expired (the self-service suspension path)", (t) => {
  // The most common production trigger — the hourly trial sweep sets
  // `subscription_status = 'canceled'` and `disabled = true` once
  // `trial_ends_at` has lapsed. The web console reads `billing_suspend`
  // to surface the reactivation CTA; if this flipped to false, the
  // tenant would have no in-app way to convert.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 8, 0, 0, 0) });
  const trialEndedYesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isAgencyBillingSuspended(
      agency({ subscription_status: "canceled", trial_ends_at: trialEndedYesterday }),
    ),
    true,
  );
});

test("isAgencyBillingSuspended: returns true for trialing with a missing trial_ends_at (defensive)", () => {
  // Should never happen in practice — `signup.ts` always sets the
  // trial deadline — but if a manual SQL edit ever cleared the column,
  // we must NOT treat the trial as eternally valid. Falling onto
  // `true` keeps the agency suspended until billing is resolved.
  assert.equal(
    isAgencyBillingSuspended(
      agency({ subscription_status: "trialing", trial_ends_at: null }),
    ),
    true,
  );
});

test("isAgencyBillingSuspended: returns true for past_due (Stripe payment failure)", () => {
  // Stripe maps `past_due` and `unpaid` onto our `past_due` (see
  // mapStripeStatus in webhooks). The agency is disabled and the path
  // back is "fix the payment method" — exactly the case the reactivate
  // CTA is for.
  assert.equal(
    isAgencyBillingSuspended(agency({ subscription_status: "past_due" })),
    true,
  );
});

test("isAgencyBillingSuspended: returns true for canceled subscriptions (the self-service cancel path)", () => {
  assert.equal(
    isAgencyBillingSuspended(agency({ subscription_status: "canceled" })),
    true,
  );
});

test("isAgencyBillingSuspended: returns true at the exact trial deadline (not past, not in future)", (t) => {
  // Boundary — `trial_ends_at > now()` evaluates to false at the exact
  // boundary, so the predicate must surface as billing-suspended. This
  // matches the SQL sweep query (`trial_ends_at < now()`) closely enough
  // that callers don't see a one-second gap where the agency is
  // disabled but the UI shows no reactivation path.
  const now = Date.UTC(2026, 0, 8, 0, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  const exactBoundary = new Date(now).toISOString();
  assert.equal(
    isAgencyBillingSuspended(
      agency({ subscription_status: "trialing", trial_ends_at: exactBoundary }),
    ),
    true,
  );
});

test("isAgencyBillingSuspended: covers every SubscriptionStatus deterministically (no undefined fall-through)", () => {
  // Tripwire — adding a new SubscriptionStatus to types.ts without
  // updating isAgencyBillingSuspended would slip through as
  // undefined-as-boolean and silently change the auth middleware's
  // error code on the new state.
  for (const status of SUBSCRIPTION_STATUSES) {
    const out = isAgencyBillingSuspended(agency({ subscription_status: status }));
    assert.equal(typeof out, "boolean", `status ${status} must map to a boolean`);
  }
});
