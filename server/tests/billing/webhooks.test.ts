/**
 * Tests for the pure helpers exported from `server/src/billing/webhooks.ts`.
 *
 * The webhook handler itself talks to Stripe + the agency store, but two
 * tiny helpers do the entire conversion of Stripe-shaped data into
 * platform decisions, and they are pinned here:
 *
 *  - `mapStripeStatus` is the single source of truth for "what happens
 *    when Stripe says X". A regression that maps `unpaid` → `active`
 *    silently keeps a non-paying agency online; mapping a future Stripe
 *    state (e.g. `paused`) onto `active` is even worse — currently it
 *    falls through to `past_due`, which trips the disabled gate in
 *    `applySubscription`. The default-branch test pins that fail-safe.
 *  - `agencyIdFromMeta` is how the webhook recovers WHICH agency to
 *    update. A regression that returned `0` instead of `null` would
 *    overwrite agency id 0 (or, worse, the first row in the SET); a
 *    `NaN` slipping through would `UPDATE agencies WHERE id = NaN`,
 *    failing mid-webhook and forcing Stripe to retry into eternity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import {
  agencyIdFromMeta,
  mapStripeStatus,
} from "../../src/billing/webhooks.js";

test("mapStripeStatus: collapses every non-active Stripe state onto our paywall states", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
  // Both Stripe failure states must trip the past_due paywall.
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
  // Both terminal cancellation states must collapse onto our `canceled`
  // — `incomplete_expired` is "the customer never finished checkout"
  // and is functionally a cancel.
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: unknown / future Stripe states fall back to past_due (fail-closed)", () => {
  // Stripe can ship new subscription states without a Stripe SDK
  // upgrade (the union type is just a TypeScript projection of the
  // remote API). The default branch must NOT fall back to "active"; if
  // it does, an unknown state would silently keep a possibly-broken
  // agency online. `past_due` is the safe choice — it disables the
  // agency until an admin resolves the situation.
  const exotic = "paused" as unknown as Stripe.Subscription.Status;
  assert.equal(mapStripeStatus(exotic), "past_due");

  const incomplete = "incomplete" as unknown as Stripe.Subscription.Status;
  assert.equal(
    mapStripeStatus(incomplete),
    "past_due",
    "'incomplete' (the post-Checkout, pre-payment state) must NOT count as active",
  );
});

test("mapStripeStatus: never returns 'comped' (that's a platform-only state, never a Stripe state)", () => {
  // The "comped" state is set manually by the platform owner from the
  // owner portal — Stripe never emits it. A regression that mapped any
  // Stripe state onto comped would un-track that agency from billing
  // entirely.
  const stripeStates: Stripe.Subscription.Status[] = [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete_expired",
    "incomplete" as Stripe.Subscription.Status,
  ];
  for (const s of stripeStates) {
    assert.notEqual(mapStripeStatus(s), "comped", `state ${s} must not collapse onto 'comped'`);
  }
});

test("agencyIdFromMeta: extracts numeric agency_id from Stripe metadata", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "42" }), 42);
  assert.equal(agencyIdFromMeta({ agency_id: "1" }), 1);
});

test("agencyIdFromMeta: returns null when metadata is missing or empty", () => {
  // The webhook handler treats `null` here as "this event isn't ours,
  // ignore it"; any non-null number triggers an UPDATE on the agencies
  // table, so the boundary cases must read as null cleanly.
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta(undefined), null);
  assert.equal(agencyIdFromMeta({}), null);
  // Stripe metadata values can technically be empty strings — must
  // also surface as null instead of NaN.
  assert.equal(agencyIdFromMeta({ agency_id: "" }), null);
});

test("agencyIdFromMeta: tolerates trailing-junk strings (parseInt semantics)", () => {
  // Documented Node behaviour: parseInt("42abc", 10) === 42. This is
  // the historical behaviour of the helper — we want to assert it
  // explicitly so a refactor to Number()/coerce doesn't silently
  // tighten the contract and start dropping legitimate Stripe events
  // whose metadata was double-stringified by an earlier integration.
  assert.equal(agencyIdFromMeta({ agency_id: "42abc" }), 42);
});

test("agencyIdFromMeta: returns null for non-numeric agency_id strings", () => {
  // A non-numeric value (e.g. someone wrote "agency_42" or a slug)
  // must NOT silently collapse to 0 or NaN — it must read as null so
  // the webhook ignores the event instead of issuing a destructive
  // UPDATE on agency id 0.
  assert.equal(agencyIdFromMeta({ agency_id: "not-a-number" }), null);
  assert.equal(agencyIdFromMeta({ agency_id: "agency_42" }), null);
  assert.equal(agencyIdFromMeta({ agency_id: "abc" }), null);
});

test("agencyIdFromMeta: parses negative values verbatim (no silent clamping)", () => {
  // Negative is a clear signal of a misconfigured metadata value, but
  // the helper today returns the parsed number as-is and lets the
  // caller's UPDATE WHERE id = -1 simply hit zero rows. Pin that
  // contract — a regression that started clamping to 0 would silently
  // re-route a misconfigured event onto agency id 0.
  assert.equal(agencyIdFromMeta({ agency_id: "-1" }), -1);
});

test("agencyIdFromMeta: does NOT use other metadata keys (just `agency_id`)", () => {
  // Pin the exact key — a refactor that started reading `agencyId` or
  // `id` would silently start sending writes to agencies whose
  // metadata has unrelated numeric fields.
  assert.equal(agencyIdFromMeta({ agencyId: "42" } as unknown as Stripe.Metadata), null);
  assert.equal(agencyIdFromMeta({ id: "42" } as unknown as Stripe.Metadata), null);
});
