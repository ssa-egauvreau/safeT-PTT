/**
 * Tests for `server/src/billing/webhooks.ts` pure helpers.
 *
 * The Stripe webhook is the only path that flips an agency between active
 * and `disabled = true`. A regression in either of the helpers below silently
 * lets a delinquent tenant keep talking on the radio (status mis-mapped) or
 * orphans a webhook event because the agency_id can't be resolved.
 *
 * Properties pinned by this file:
 *
 *  1. **`mapStripeStatus`** must:
 *     - Pass through `active` and `trialing` verbatim — these gate the
 *       handset login path (`agency.disabled` flips off these two).
 *     - Coalesce `past_due` AND `unpaid` to `past_due` so the admin UI shows
 *       a single "Payment problem" state regardless of Stripe's internal
 *       lifecycle nuance.
 *     - Coalesce `canceled` AND `incomplete_expired` to `canceled` — both
 *       mean "no working subscription, suspend the tenant".
 *     - Map every other Stripe status (incomplete, paused, future additions)
 *       to `past_due`. This is intentionally fail-safe: an unknown status
 *       must NEVER be silently promoted to `active`.
 *
 *  2. **`agencyIdFromMeta`** must:
 *     - Return `null` for null / undefined / missing-key metadata so the
 *       webhook handler can skip the event cleanly.
 *     - Parse a stringified integer to a finite number (Stripe metadata is
 *       always strings).
 *     - Return `null` for non-numeric values so a corrupted metadata bag
 *       cannot accidentally apply changes to agency `NaN`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  agencyIdFromMeta,
  isStripeSubscriptionActive,
  mapStripeStatus,
  shouldDisableForSubscriptionUpdate,
  subscriptionBillingPatch,
} from "../../src/billing/webhooks.js";

/**
 * Builds a minimal Stripe.Subscription-shaped object good enough for the
 * pure-projection helpers under test. We cast to Stripe.Subscription so the
 * tests stay compact — the helpers only touch `id`, `status`, `metadata`,
 * and `trial_end`.
 */
function fakeStripeSub(over: {
  id?: string;
  status: Stripe.Subscription.Status;
  metadata?: Record<string, string> | null;
  trial_end?: number | null;
}): Stripe.Subscription {
  return {
    id: over.id ?? "sub_test_1",
    status: over.status,
    metadata: (over.metadata ?? {}) as Stripe.Metadata,
    trial_end: over.trial_end ?? null,
  } as unknown as Stripe.Subscription;
}

// ---------------------------------------------------------------------------
// mapStripeStatus
// ---------------------------------------------------------------------------

test("mapStripeStatus: passes through active and trialing", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
});

test("mapStripeStatus: past_due and unpaid both map to past_due", () => {
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
});

test("mapStripeStatus: canceled and incomplete_expired both map to canceled", () => {
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: incomplete falls through to past_due (fail-safe default)", () => {
  assert.equal(mapStripeStatus("incomplete"), "past_due");
});

test("mapStripeStatus: paused falls through to past_due (fail-safe default)", () => {
  assert.equal(mapStripeStatus("paused"), "past_due");
});

test("mapStripeStatus: any unknown status maps to past_due (never to active)", () => {
  // Cast to bypass the literal-union; this future-proofs against Stripe
  // adding a new status that we haven't explicitly mapped.
  const unknown = mapStripeStatus("brand_new_status" as unknown as Stripe.Subscription.Status);
  assert.equal(unknown, "past_due");
  assert.notEqual(unknown, "active");
  assert.notEqual(unknown, "trialing");
  assert.notEqual(unknown, "comped");
});

// ---------------------------------------------------------------------------
// isStripeSubscriptionActive
// ---------------------------------------------------------------------------

test("isStripeSubscriptionActive: true only for active and trialing", () => {
  assert.equal(isStripeSubscriptionActive("active"), true);
  assert.equal(isStripeSubscriptionActive("trialing"), true);
});

test("isStripeSubscriptionActive: false for delinquent/canceled/unknown states", () => {
  assert.equal(isStripeSubscriptionActive("past_due"), false);
  assert.equal(isStripeSubscriptionActive("unpaid"), false);
  assert.equal(isStripeSubscriptionActive("canceled"), false);
  assert.equal(isStripeSubscriptionActive("incomplete_expired"), false);
  assert.equal(isStripeSubscriptionActive("incomplete"), false);
  assert.equal(isStripeSubscriptionActive("paused"), false);
  assert.equal(
    isStripeSubscriptionActive("brand_new_status" as unknown as Stripe.Subscription.Status),
    false,
  );
});

// ---------------------------------------------------------------------------
// agencyIdFromMeta
// ---------------------------------------------------------------------------

test("agencyIdFromMeta: null / undefined return null", () => {
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta(undefined), null);
});

test("agencyIdFromMeta: missing agency_id key returns null", () => {
  assert.equal(agencyIdFromMeta({} as Stripe.Metadata), null);
  assert.equal(agencyIdFromMeta({ other: "x" } as unknown as Stripe.Metadata), null);
});

test("agencyIdFromMeta: empty string returns null", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "" } as unknown as Stripe.Metadata), null);
});

test("agencyIdFromMeta: parses a stringified integer", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "42" } as unknown as Stripe.Metadata), 42);
});

test("agencyIdFromMeta: parses with leading whitespace", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "  42" } as unknown as Stripe.Metadata), 42);
});

test("agencyIdFromMeta: garbage input that has no leading digits returns null", () => {
  // Number.parseInt("abc", 10) = NaN; Number.isFinite(NaN) = false → null.
  assert.equal(
    agencyIdFromMeta({ agency_id: "not-a-number" } as unknown as Stripe.Metadata),
    null,
  );
});

test("agencyIdFromMeta: zero is preserved (not coerced to null)", () => {
  // We never expect agency_id=0 in practice, but the helper should not
  // confuse a legitimate 0 with a parse failure.
  assert.equal(agencyIdFromMeta({ agency_id: "0" } as unknown as Stripe.Metadata), 0);
});

// ---------------------------------------------------------------------------
// subscriptionBillingPatch
// ---------------------------------------------------------------------------
//
// Regression guard for the bug that motivated PR #278 ("avoid re-enabling
// suspended agencies on checkout webhook retries"). Before the fix, the
// `checkout.session.completed` branch unconditionally wrote `disabled: false`
// after `applySubscription`, so a Stripe webhook retry for a delinquent
// tenant (status=past_due / canceled / unpaid) silently re-opened the radio.
//
// The patch built here is the SINGLE source of truth that `applySubscription`
// now writes — there is no second `disabled` write to undo it. These tests
// pin that `disabled` is derived from the LIVE Stripe status for every
// non-active path, so the bug cannot regress without one of them tripping.

test("subscriptionBillingPatch: active status leaves agency enabled (disabled=false)", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, false);
  assert.equal(patch.subscriptionStatus, "active");
});

test("subscriptionBillingPatch: trialing leaves agency enabled (disabled=false)", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "trialing", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, false);
  assert.equal(patch.subscriptionStatus, "trialing");
});

test("subscriptionBillingPatch: past_due forces disabled=true (the bug)", () => {
  // The exact scenario from PR #278: a webhook arrives for a tenant whose
  // card stopped working. Before the fix, the checkout-completed branch
  // would clobber disabled back to false. The new patch must say disabled=true.
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "past_due", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
  assert.equal(patch.subscriptionStatus, "past_due");
});

test("subscriptionBillingPatch: canceled forces disabled=true", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "canceled", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
  assert.equal(patch.subscriptionStatus, "canceled");
});

test("subscriptionBillingPatch: unpaid forces disabled=true (coalesced to past_due)", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "unpaid", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
  assert.equal(patch.subscriptionStatus, "past_due");
});

test("subscriptionBillingPatch: incomplete_expired forces disabled=true", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "incomplete_expired", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
  assert.equal(patch.subscriptionStatus, "canceled");
});

test("subscriptionBillingPatch: incomplete (not yet paid) forces disabled=true", () => {
  // Stripe leaves a freshly-created subscription as "incomplete" until the
  // first invoice is paid. We must NOT enable the agency until Stripe flips
  // it to active/trialing.
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "incomplete", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
});

test("subscriptionBillingPatch: paused forces disabled=true", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "paused", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.disabled, true);
});

test("subscriptionBillingPatch: unknown future status fails closed (disabled=true)", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({
      status: "brand_new_stripe_status" as unknown as Stripe.Subscription.Status,
      metadata: { agency_id: "7" },
    }),
  );
  assert.equal(patch.disabled, true);
  // And the mapped status must be the fail-safe "past_due", never "active".
  assert.equal(patch.subscriptionStatus, "past_due");
});

test("subscriptionBillingPatch: stripeSubscriptionId is propagated from sub.id", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ id: "sub_abc123", status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.stripeSubscriptionId, "sub_abc123");
});

test("subscriptionBillingPatch: plan_tier metadata 'pro' selects pro tier", () => {
  const patch = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7", plan_tier: "pro" } }),
  );
  assert.equal(patch.planTier, "pro");
});

test("subscriptionBillingPatch: missing/unknown plan_tier defaults to basic", () => {
  // The defaulting is critical: a typo or stripped metadata field must not
  // accidentally upgrade a basic tenant to pro (which unlocks AI dispatch).
  const basicByDefault = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(basicByDefault.planTier, "basic");

  const basicFromTypo = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7", plan_tier: "PRO" } }),
  );
  assert.equal(basicFromTypo.planTier, "basic");
});

test("subscriptionBillingPatch: logs_unlimited='true' nulls the retention window", () => {
  // logs_unlimited tenants keep transmissions forever — the sweep skips
  // anything with null retention_days.
  const patch = subscriptionBillingPatch(
    fakeStripeSub({
      status: "active",
      metadata: { agency_id: "7", logs_unlimited: "true" },
    }),
  );
  assert.equal(patch.logsUnlimited, true);
  assert.equal(patch.transmissionRetentionDays, null);
});

test("subscriptionBillingPatch: logs_unlimited missing/false uses 3-day retention", () => {
  // The 3-day default mirrors the basic-tier marketing copy. Any change
  // here would shorten or lengthen retention silently for every basic tenant.
  const fromMissing = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(fromMissing.logsUnlimited, false);
  assert.equal(fromMissing.transmissionRetentionDays, 3);

  const fromExplicitFalse = subscriptionBillingPatch(
    fakeStripeSub({
      status: "active",
      metadata: { agency_id: "7", logs_unlimited: "false" },
    }),
  );
  assert.equal(fromExplicitFalse.logsUnlimited, false);
  assert.equal(fromExplicitFalse.transmissionRetentionDays, 3);
});

test("subscriptionBillingPatch: trial_end (unix seconds) is converted to ISO string", () => {
  // Stripe gives us seconds-since-epoch; we store ISO strings. Off-by-1000
  // here would put trial expiry ~50 years in the future.
  const epochSeconds = 1_700_000_000;
  const patch = subscriptionBillingPatch(
    fakeStripeSub({
      status: "trialing",
      metadata: { agency_id: "7" },
      trial_end: epochSeconds,
    }),
  );
  assert.equal(patch.trialEndsAt, new Date(epochSeconds * 1000).toISOString());
});

test("subscriptionBillingPatch: trial_end null/missing yields trialEndsAt=null", () => {
  const fromMissing = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(fromMissing.trialEndsAt, null);

  const fromExplicitNull = subscriptionBillingPatch(
    fakeStripeSub({ status: "active", metadata: { agency_id: "7" }, trial_end: null }),
  );
  assert.equal(fromExplicitNull.trialEndsAt, null);
});

// ---------------------------------------------------------------------------
// shouldDisableForSubscriptionUpdate
// ---------------------------------------------------------------------------
//
// On `customer.subscription.updated` / `.deleted`, the webhook reads the
// agency's CURRENT status and decides whether to flip `disabled`. The one
// hard rule: a `comped` agency (operator-controlled) must NEVER be auto-
// disabled by Stripe, even if Stripe replays a stale "canceled" event.

test("shouldDisableForSubscriptionUpdate: comped agency is a no-op regardless of sub status", () => {
  // Every Stripe status, on a comped agency, must produce `null` (no write).
  for (const status of [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "paused",
  ] as Stripe.Subscription.Status[]) {
    assert.equal(
      shouldDisableForSubscriptionUpdate(status, "comped"),
      null,
      `comped + ${status} should be a no-op but was not`,
    );
  }
});

test("shouldDisableForSubscriptionUpdate: non-comped + active → disabled=false", () => {
  assert.equal(shouldDisableForSubscriptionUpdate("active", "active"), false);
  assert.equal(shouldDisableForSubscriptionUpdate("active", "past_due"), false);
  assert.equal(shouldDisableForSubscriptionUpdate("trialing", "trialing"), false);
});

test("shouldDisableForSubscriptionUpdate: non-comped + delinquent → disabled=true", () => {
  for (const status of [
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "paused",
  ] as Stripe.Subscription.Status[]) {
    assert.equal(
      shouldDisableForSubscriptionUpdate(status, "active"),
      true,
      `active agency + Stripe ${status} should disable but did not`,
    );
  }
});

test("shouldDisableForSubscriptionUpdate: unknown future Stripe status fails closed (disable)", () => {
  assert.equal(
    shouldDisableForSubscriptionUpdate(
      "brand_new_status" as unknown as Stripe.Subscription.Status,
      "active",
    ),
    true,
  );
});
