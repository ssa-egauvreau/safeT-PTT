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
import {
  isBillingActive,
  isBillingSuspended,
  trialDaysLeft,
} from "../../src/billing/subscription.js";
import type { AgencyRow } from "../../src/store.js";

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

// ---------------------------------------------------------------------------
// isBillingSuspended
//
// This helper decides whether a disabled-agency 403 should surface
// `agency_suspended_billing` (the customer-facing "your trial ended / payment
// failed" copy in the handset login screen) versus the generic
// `agency_disabled` (admin manually flipped the kill switch). Each branch
// covers a real customer-impacting scenario:
//
//  - Grandfathered (`signup_completed_at == null`) tenants must NEVER show
//    the billing copy when an admin disables them; they have no Stripe
//    relationship and the wording is misleading.
//  - `comped` and `active` tenants are paying / sponsored — disabled by
//    them means an operator manually killed access, not billing.
//  - `trialing` with a future `trial_ends_at` is an in-flight trial; an
//    admin disable here is operational, not billing-driven.
//  - `trialing` with an EXPIRED `trial_ends_at` is what the trialSweep
//    cron flips to disabled — that IS a billing situation.
//  - `past_due` and `canceled` are unambiguously billing problems.
// ---------------------------------------------------------------------------

function fakeAgency(overrides: Partial<AgencyRow>): AgencyRow {
  // Minimum AgencyRow shape — only the fields the helper inspects matter,
  // but TS demands the rest. Defaults match a fresh self-service signup.
  return {
    id: 1,
    name: "Test Agency",
    slug: "test-agency",
    radio_key: "rk_test",
    disabled: true,
    created_at: "2025-01-01T00:00:00.000Z",
    default_codec: "imbe",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: "trialing",
    plan_tier: "basic",
    trial_ends_at: null,
    transmission_retention_days: 3,
    logs_unlimited: false,
    billing_email: "ops@example.com",
    signup_completed_at: "2025-01-01T00:00:00.000Z",
    trial_email_used: true,
    ...overrides,
  } as AgencyRow;
}

test("isBillingSuspended: null / undefined agency → false (no agency, no copy)", () => {
  assert.equal(isBillingSuspended(null), false);
  assert.equal(isBillingSuspended(undefined), false);
});

test("isBillingSuspended: grandfathered tenant (signup_completed_at == null) → false", () => {
  // Pre-billing tenants migrated into the default agency keep
  // `signup_completed_at = null`. Any disable on those tenants is admin
  // action, never billing.
  assert.equal(
    isBillingSuspended(
      fakeAgency({ signup_completed_at: null, subscription_status: "canceled" }),
    ),
    false,
  );
});

test("isBillingSuspended: comped → false (sponsored tenants are never billing-suspended)", () => {
  assert.equal(
    isBillingSuspended(fakeAgency({ subscription_status: "comped" })),
    false,
  );
});

test("isBillingSuspended: active → false (paying tenants disabled by admin, not Stripe)", () => {
  assert.equal(
    isBillingSuspended(fakeAgency({ subscription_status: "active" })),
    false,
  );
});

test("isBillingSuspended: trialing with future trial_ends_at → false", () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: future }),
    ),
    false,
  );
});

test("isBillingSuspended: trialing with expired trial_ends_at → true (trial swept)", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: past }),
    ),
    true,
  );
});

test("isBillingSuspended: trialing with NULL trial_ends_at → true (defensive)", () => {
  // A self-service trialing tenant should always have trial_ends_at; if it's
  // null the row is corrupt. Surfacing the billing copy keeps the support
  // funnel pointed at finance instead of engineering.
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: null }),
    ),
    true,
  );
});

test("isBillingSuspended: past_due → true (failed payment)", () => {
  assert.equal(
    isBillingSuspended(fakeAgency({ subscription_status: "past_due" })),
    true,
  );
});

test("isBillingSuspended: canceled → true (subscription ended)", () => {
  assert.equal(
    isBillingSuspended(fakeAgency({ subscription_status: "canceled" })),
    true,
  );
});

test("isBillingSuspended: 'now' override is honoured (exact-boundary trial)", () => {
  // Pinning `now` proves the helper compares against the supplied clock —
  // important because the production caller relies on Date.now() but tests
  // need a deterministic frame.
  const trialEnd = "2025-06-10T12:00:00.000Z";
  // Just before the deadline: still trialing, NOT suspended.
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: trialEnd }),
      new Date("2025-06-10T11:59:59.000Z"),
    ),
    false,
  );
  // Right at the deadline (>= not >): suspended. Matches the apiRoutes copy.
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: trialEnd }),
      new Date("2025-06-10T12:00:00.000Z"),
    ),
    true,
  );
  // After the deadline: suspended.
  assert.equal(
    isBillingSuspended(
      fakeAgency({ subscription_status: "trialing", trial_ends_at: trialEnd }),
      new Date("2025-06-10T12:00:01.000Z"),
    ),
    true,
  );
});
