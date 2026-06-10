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
import { agencyIdFromMeta, mapStripeStatus, processStripeEvent } from "../../src/billing/webhooks.js";

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
// processStripeEvent
// ---------------------------------------------------------------------------

test("processStripeEvent: checkout completion never force-enables a past-due subscription", async () => {
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  const fakeStripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        assert.equal(subscriptionId, "sub_123");
        return {
          id: "sub_123",
          status: "past_due",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "42" },
          subscription: "sub_123",
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.agencyId, 42);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updateCalls[0]?.patch.disabled, true);
  assert.ok(!updateCalls.some((call) => call.patch.disabled === false));
});
