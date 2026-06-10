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
  mapStripeStatus,
  subscriptionPatchFromStripe,
} from "../../src/billing/webhooks.js";

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
// subscriptionPatchFromStripe
//
// This is the projection that turns a Stripe.Subscription into the
// `updateAgencyBilling` patch the webhook handler writes. It is the ONLY
// place the platform decides whether a Stripe state should disable a tenant
// (`disabled = true`) or not. A regression in any branch below either
// silently keeps a delinquent tenant on the air, or silently kicks a
// paying tenant off — both customer-visible incidents.
// ---------------------------------------------------------------------------

function fakeSub(input: {
  id?: string;
  status: Stripe.Subscription.Status;
  metadata?: Record<string, string>;
  trial_end?: number | null;
}): Stripe.Subscription {
  return {
    id: input.id ?? "sub_test_1",
    status: input.status,
    metadata: (input.metadata ?? {}) as Stripe.Metadata,
    trial_end: input.trial_end ?? null,
  } as unknown as Stripe.Subscription;
}

test("subscriptionPatchFromStripe: active + pro + logs_unlimited → enabled, retention null", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({
      id: "sub_a",
      status: "active",
      metadata: { agency_id: "7", plan_tier: "pro", logs_unlimited: "true" },
    }),
  );
  assert.equal(patch.stripeSubscriptionId, "sub_a");
  assert.equal(patch.subscriptionStatus, "active");
  assert.equal(patch.planTier, "pro");
  assert.equal(patch.logsUnlimited, true);
  assert.equal(patch.transmissionRetentionDays, null);
  assert.equal(patch.disabled, false);
  assert.equal(patch.trialEndsAt, null);
});

test("subscriptionPatchFromStripe: active + basic + bounded retention 3 days when logs_unlimited unset", () => {
  // Default plan tier and default retention are the silent defaults a
  // self-service signup relies on; if a regression flipped logs_unlimited
  // to default-true here, every basic-plan agency would suddenly retain
  // recordings forever and blow out the Postgres volume on Railway.
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "active", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.planTier, "basic");
  assert.equal(patch.logsUnlimited, false);
  assert.equal(patch.transmissionRetentionDays, 3);
  assert.equal(patch.disabled, false);
});

test("subscriptionPatchFromStripe: trialing keeps disabled = false (trial users must keep talking)", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "trialing", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "trialing");
  assert.equal(patch.disabled, false);
});

test("subscriptionPatchFromStripe: past_due → disabled = true (gate paying-but-failing tenants)", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "past_due", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "past_due");
  assert.equal(patch.disabled, true);
});

test("subscriptionPatchFromStripe: unpaid → past_due → disabled = true", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "unpaid", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "past_due");
  assert.equal(patch.disabled, true);
});

test("subscriptionPatchFromStripe: canceled → disabled = true", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "canceled", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "canceled");
  assert.equal(patch.disabled, true);
});

test("subscriptionPatchFromStripe: incomplete_expired → canceled → disabled = true", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "incomplete_expired", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "canceled");
  assert.equal(patch.disabled, true);
});

test("subscriptionPatchFromStripe: incomplete (fail-safe) → past_due → disabled = true", () => {
  // Anything we don't explicitly recognise must fall through to past_due.
  // Pinning this behaviour ensures a future Stripe status enum addition
  // can't sneak through as `active` and let a non-paying tenant on the air.
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "incomplete", metadata: { agency_id: "7" } }),
  );
  assert.equal(patch.subscriptionStatus, "past_due");
  assert.equal(patch.disabled, true);
});

test("subscriptionPatchFromStripe: trial_end is converted from unix-seconds to ISO string", () => {
  // Stripe sends seconds; the DB column is TIMESTAMPTZ. A regression that
  // skipped the *1000 multiplier would produce an ISO date in 1970, and
  // every freshly-converted trial would render as "expired" in the admin UI.
  const patch = subscriptionPatchFromStripe(
    fakeSub({
      status: "trialing",
      metadata: { agency_id: "7" },
      trial_end: 1_700_000_000, // 2023-11-14T22:13:20Z
    }),
  );
  assert.equal(patch.trialEndsAt, "2023-11-14T22:13:20.000Z");
});

test("subscriptionPatchFromStripe: trial_end null → trialEndsAt null (no synthetic deadline)", () => {
  const patch = subscriptionPatchFromStripe(
    fakeSub({ status: "active", metadata: { agency_id: "7" }, trial_end: null }),
  );
  assert.equal(patch.trialEndsAt, null);
});

test("subscriptionPatchFromStripe: plan_tier metadata other than 'pro' falls back to 'basic'", () => {
  // The metadata is operator-controlled (set when the checkout session is
  // created). A typo or future tier name MUST default to the cheapest plan,
  // never silently elevate a tenant to pro features.
  for (const planRaw of ["", "BASIC", "Pro", "enterprise", "free", "  pro  "]) {
    const patch = subscriptionPatchFromStripe(
      fakeSub({ status: "active", metadata: { agency_id: "7", plan_tier: planRaw } }),
    );
    assert.equal(patch.planTier, "basic", `plan_tier="${planRaw}" must coerce to basic`);
  }
});

test("subscriptionPatchFromStripe: logs_unlimited only flips on the literal string 'true'", () => {
  // Same rationale as plan_tier: anything ambiguous defaults OFF (3-day
  // retention). A regression that flipped on "True" / "1" / "yes" would
  // grant unlimited storage to anyone who fat-fingered their metadata.
  for (const raw of ["false", "TRUE", "True", "1", "yes", "", undefined as unknown as string]) {
    const patch = subscriptionPatchFromStripe(
      fakeSub({
        status: "active",
        metadata: { agency_id: "7", ...(raw !== undefined ? { logs_unlimited: raw } : {}) },
      }),
    );
    assert.equal(patch.logsUnlimited, false, `logs_unlimited="${raw}" must default off`);
    assert.equal(patch.transmissionRetentionDays, 3);
  }
});
