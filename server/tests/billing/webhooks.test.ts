/**
 * Tests for the pure helpers in `server/src/billing/webhooks.ts`.
 *
 * The webhook handler is the only path that writes a paying agency's
 * subscription state. Two pure helpers do the load-bearing work:
 *
 *  1. `mapStripeStatus` — collapses Stripe's 8+ subscription statuses into the
 *     5 we store. A misclassification here either keeps a canceled customer
 *     logged in (lost revenue) or disables an `active` customer (support
 *     incident). The mapping also feeds the `disabled` flag in
 *     `customer.subscription.updated`, so getting this wrong locks tenants out.
 *
 *  2. `agencyIdFromMeta` — every webhook event correlates back to an agency via
 *     `metadata.agency_id`. If this returns the wrong number, we update the
 *     wrong tenant. If it accepts non-numeric garbage, we either crash the
 *     handler (event retried forever) or silently route to NaN.
 *
 * Both helpers are pure, so we can pin every branch deterministically without
 * standing up Stripe or Postgres.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { agencyIdFromMeta, mapStripeStatus } from "../../src/billing/webhooks.js";

test("mapStripeStatus: 'active' and 'trialing' pass through (the live states)", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
});

test("mapStripeStatus: 'past_due' and 'unpaid' both collapse to 'past_due'", () => {
  // Both indicate a failed-but-recoverable invoice; we surface them as one
  // state to keep the admin UI simple.
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
});

test("mapStripeStatus: 'canceled' and 'incomplete_expired' both collapse to 'canceled'", () => {
  // An expired-incomplete subscription is functionally canceled — the customer
  // never paid in time, so we treat them like a churned tenant.
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: unknown / interim Stripe states default to 'past_due' (fail-closed)", () => {
  // We deliberately do not unlock the agency for `incomplete`, `paused`, or
  // future Stripe statuses we haven't audited yet. `past_due` is the safest
  // landing zone because it lets admins log in to fix billing but keeps the
  // tenant disabled in the webhook's `active = (status in active|trialing)`
  // check.
  assert.equal(mapStripeStatus("incomplete"), "past_due");
  assert.equal(mapStripeStatus("paused"), "past_due");
  // Cast through unknown so a future Stripe type bump doesn't silently mute
  // this guard.
  assert.equal(mapStripeStatus("anything_else" as unknown as "incomplete"), "past_due");
});

test("agencyIdFromMeta: pulls a positive integer agency_id out of the Stripe metadata bag", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "42" }), 42);
});

test("agencyIdFromMeta: returns null when metadata is missing or the field is absent", () => {
  assert.equal(agencyIdFromMeta(undefined), null);
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta({}), null);
  assert.equal(agencyIdFromMeta({ agency_id: "" }), null, "empty string must not parse to 0");
});

test("agencyIdFromMeta: parseInt-style coercion ignores trailing garbage but rejects pure garbage", () => {
  // parseInt happily eats trailing junk after a leading number, which is fine
  // because Stripe metadata is server-set — but this test pins the behaviour
  // so a future tightening (e.g. strict Number()) is intentional.
  assert.equal(agencyIdFromMeta({ agency_id: "17abc" }), 17);
  // Pure non-numeric is NaN, which Number.isFinite rejects.
  assert.equal(agencyIdFromMeta({ agency_id: "abc" }), null);
});

test("agencyIdFromMeta: rejects NaN and Infinity-like inputs (no wild writes)", () => {
  // The webhook handler skips work when this returns null, so anything that
  // could land as NaN/Infinity must collapse to null instead of routing the
  // update to a bogus row.
  assert.equal(agencyIdFromMeta({ agency_id: "NaN" }), null);
  assert.equal(agencyIdFromMeta({ agency_id: "Infinity" }), null);
});

test("agencyIdFromMeta: accepts negative ids verbatim (callers gate further)", () => {
  // The helper is a parser, not a validator — callers (`applySubscription`,
  // the webhook switch) gate on `if (agencyId)` so negative/zero ids are still
  // safe in practice, but the parser itself preserves the numeric value.
  assert.equal(agencyIdFromMeta({ agency_id: "-3" }), -3);
});
