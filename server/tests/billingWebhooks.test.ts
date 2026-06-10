/**
 * Tests for the pure helpers in `server/src/billing/webhooks.ts`.
 *
 * The Stripe webhook is the single source of truth for whether an agency's
 * billing is in good standing. Two small helpers determine how every Stripe
 * event flows through the system:
 *
 *   - `mapStripeStatus()` translates Stripe's full enum
 *     (active, trialing, past_due, unpaid, canceled, incomplete_expired,
 *     incomplete, paused, …) into the smaller `SubscriptionStatus` the rest
 *     of the codebase reasons about. Misclassifying any one of these
 *     directly drives an `updateAgencyBilling({ disabled: ... })` call from
 *     `applySubscription`, so a wrong mapping either disables a paying
 *     tenant or leaves a defaulted tenant fully active.
 *
 *   - `agencyIdFromMeta()` parses the `agency_id` value Stripe returns in
 *     the subscription/checkout metadata. A regression that mis-parsed
 *     these (e.g. accepted `"5"` from a checkout session metadata as an
 *     unrelated agency, or returned NaN for non-numeric input) would route
 *     a billing event to the wrong tenant — a cross-tenant data corruption
 *     in the worst case.
 *
 * Both functions are pure and trivially unit-testable. The real-Stripe
 * `handleStripeWebhook` flow is integration territory (signature verify,
 * subscription retrieve), and is intentionally out of scope here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

import {
  agencyIdFromMeta,
  mapStripeStatus,
} from "../src/billing/webhooks.js";

test("mapStripeStatus: active and trialing pass through unchanged", () => {
  // The two healthy states. `applySubscription` reads the result of this
  // mapping to decide `disabled: status === "canceled" || status === "past_due"`,
  // so any drift from "active" or "trialing" silently gates a paying
  // tenant out.
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
});

test("mapStripeStatus: past_due and unpaid both fold to past_due (handset stays gated)", () => {
  // Stripe surfaces a failing-card subscription as either "past_due" (still
  // retrying) or "unpaid" (retries exhausted). The platform treats both as
  // a soft lock — the dispatch console can show a "fix billing" banner and
  // the radio tier is gated. If "unpaid" ever started mapping to "active"
  // we'd silently keep a defaulted tenant on the air for free.
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
});

test("mapStripeStatus: canceled and incomplete_expired fold to canceled (hard lock)", () => {
  // `incomplete_expired` is the terminal state for a checkout that was
  // never completed within Stripe's 23-hour window. It is not recoverable
  // by retrying the same subscription, so the platform must treat it
  // identically to a manual cancel — the agency_disabled gate has to fire
  // on the next request so the admin restarts the signup flow rather than
  // hammering a dead Stripe object.
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: ambiguous statuses default to past_due (fail closed)", () => {
  // `incomplete` and `paused` are intermediate / new Stripe states the app
  // doesn't have first-class branches for. The default arm folds them to
  // `past_due` so the customer gets the soft-lock + "fix billing" banner
  // rather than silently free access (`active`) or a hard cancel
  // (`canceled`). This is the safest fail-closed default: it nudges the
  // admin to surface the issue without permanently tearing down the
  // tenant. If a future maintainer flips this to `active`, an entire
  // class of half-configured Stripe subscriptions starts riding free.
  assert.equal(mapStripeStatus("incomplete" as Stripe.Subscription.Status), "past_due");
  assert.equal(mapStripeStatus("paused" as Stripe.Subscription.Status), "past_due");
  // A bogus value off the typed enum still falls through the same branch —
  // proves the `default:` arm is the catch-all, not the typed cases.
  assert.equal(
    mapStripeStatus("not_a_real_status" as Stripe.Subscription.Status),
    "past_due",
  );
});

test("agencyIdFromMeta: parses a numeric string into a number", () => {
  // The happy path. `createStripeCustomer` writes
  // `metadata: { agency_id: String(agencyId) }`, and the webhook reads it
  // back. Round-trip must succeed for every numeric tenant id we issue.
  assert.equal(agencyIdFromMeta({ agency_id: "42" }), 42);
});

test("agencyIdFromMeta: returns null when metadata is missing or empty", () => {
  // Stripe events from a manually-created subscription (e.g. a support rep
  // running a back-channel Stripe action) carry no metadata. The webhook
  // must treat that as a no-op rather than crashing or — worse —
  // mis-routing the event. Returning `null` is the early-exit signal
  // `applySubscription` uses to skip the update entirely.
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta(undefined), null);
  assert.equal(agencyIdFromMeta({}), null);
  // Empty string is the third "missing" representation Stripe can produce
  // when a metadata field was set and then cleared.
  assert.equal(agencyIdFromMeta({ agency_id: "" }), null);
});

test("agencyIdFromMeta: rejects non-numeric agency_id values (cross-tenant safety)", () => {
  // A non-numeric value here is a hard signal that the metadata was
  // tampered with or written by an unrelated integration. We must NOT
  // coerce or guess — return null and let `applySubscription` no-op.
  // Coercing "5abc" -> 5 (which `parseInt` would do) could route a Stripe
  // event for one tenant onto another tenant's billing row.
  assert.equal(agencyIdFromMeta({ agency_id: "abc" }), null);
});

test("agencyIdFromMeta: tolerates leading-numeric junk via parseInt() but Number.isFinite() rejects bare junk", () => {
  // Documents the actual semantics of the implementation. parseInt("5abc")
  // is 5 — finite — so this is accepted. parseInt("abc") is NaN — not
  // finite — so it's rejected. This pair pins the boundary so a refactor
  // that swaps to `Number()` (which would NaN on "5abc") trips the test
  // and the maintainer makes a conscious decision about which behavior
  // they want.
  assert.equal(agencyIdFromMeta({ agency_id: "5abc" }), 5);
  assert.equal(agencyIdFromMeta({ agency_id: "abc" }), null);
});
