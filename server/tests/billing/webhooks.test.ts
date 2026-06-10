/**
 * Tests for the pure helpers in `server/src/billing/webhooks.ts`.
 *
 * The webhook handler itself involves Stripe signature verification, DB
 * writes, and event dispatch — those are intentionally out of scope here.
 * The two helpers we DO cover are the single points where the platform
 * translates Stripe's domain into our own, and a regression in either
 * silently corrupts every downstream billing state transition:
 *
 *  - `mapStripeStatus(status)` converts the Stripe subscription status enum
 *    to our internal `SubscriptionStatus`. The webhook calls `applySubscription`
 *    which writes the mapped value straight into `agencies.subscription_status`
 *    AND uses it to flip `disabled` (canceled/past_due → disabled = true).
 *    Misclassifying "unpaid" as "active" would keep a delinquent agency live;
 *    misclassifying "active" as "past_due" would lock out a paying customer.
 *    We also pin the default-branch behavior: any unknown future Stripe state
 *    must collapse to "past_due" so the agency is held in a safe-default
 *    holding pattern until a human reviews it.
 *
 *  - `agencyIdFromMeta(meta)` parses the `agency_id` we set on every Stripe
 *    customer/subscription/checkout-session. If this ever returns the wrong
 *    agency id we'd write a paid subscription to the wrong tenant — a
 *    cross-tenant billing leak. The helper must reject missing metadata,
 *    blank strings, and non-numeric junk, while accepting both bare and
 *    decorated numeric strings (Stripe metadata values are always strings).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const { mapStripeStatus, agencyIdFromMeta } = await import("../../src/billing/webhooks.js");

test("mapStripeStatus: known states map 1:1", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
});

test("mapStripeStatus: past_due and unpaid both collapse to past_due", () => {
  // "unpaid" is what Stripe transitions to after past_due retries exhaust;
  // the platform treats them the same so the admin UI only has one
  // "payment failed" state to render.
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
});

test("mapStripeStatus: canceled and incomplete_expired both collapse to canceled", () => {
  // A subscription that never gets confirmed (incomplete_expired) is a
  // signup that didn't pay — semantically the same as a canceled sub for
  // our access-control purposes.
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: unknown / future Stripe states fall back to past_due (safe default)", () => {
  // If Stripe adds a state we don't know about, defaulting to past_due
  // disables the agency until a human reconciles it — the safe direction
  // to fail.
  assert.equal(
    mapStripeStatus("incomplete" as Stripe.Subscription.Status),
    "past_due",
  );
  assert.equal(
    mapStripeStatus("paused" as Stripe.Subscription.Status),
    "past_due",
  );
});

test("agencyIdFromMeta: extracts a numeric agency_id from metadata", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "1" }), 1);
  assert.equal(agencyIdFromMeta({ agency_id: "42" }), 42);
});

test("agencyIdFromMeta: tolerates extra Stripe metadata fields and parses just agency_id", () => {
  const meta = {
    agency_id: "7",
    plan_tier: "pro",
    logs_unlimited: "false",
  } as Stripe.Metadata;
  assert.equal(agencyIdFromMeta(meta), 7);
});

test("agencyIdFromMeta: returns null when metadata is missing or blank", () => {
  // A subscription event with no metadata must NOT silently route to
  // agency #0 or NaN — it must explicitly drop, which is what `null` signals
  // to `applySubscription`.
  assert.equal(agencyIdFromMeta(undefined), null);
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta({} as Stripe.Metadata), null);
  assert.equal(agencyIdFromMeta({ agency_id: "" } as unknown as Stripe.Metadata), null);
});

test("agencyIdFromMeta: rejects non-numeric strings (must not return NaN)", () => {
  // parseInt would happily turn "abc" into NaN — Number.isFinite(NaN) is
  // false so the helper must surface null, not NaN.
  assert.equal(agencyIdFromMeta({ agency_id: "abc" } as Stripe.Metadata), null);
  assert.equal(agencyIdFromMeta({ agency_id: "not-a-number" } as Stripe.Metadata), null);
});

test("agencyIdFromMeta: parseInt of '12abc' yields 12 — document the prefix-tolerant behavior", () => {
  // This is the documented behavior of `Number.parseInt`, but the test
  // pins it explicitly so a future switch to `Number(raw)` (strict) is a
  // deliberate, reviewed change rather than a silent semantics shift.
  assert.equal(agencyIdFromMeta({ agency_id: "12abc" } as Stripe.Metadata), 12);
});
