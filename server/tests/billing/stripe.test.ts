/**
 * Tests for `server/src/billing/stripe.ts`.
 *
 * The Stripe SDK wrappers in this file have two distinct failure modes that
 * the rest of the billing pipeline depends on:
 *
 *  1. **No billing configured (`STRIPE_SECRET_KEY` unset).** Every exported
 *     helper must short-circuit to `null` rather than attempt to construct a
 *     `new Stripe(undefined)` client. Today this is the default state on
 *     every Cloud Agent VM, every CI run, and every local dev session — so
 *     a regression that started throwing in this branch would break boot
 *     for every contributor before they ever wrote a line of billing code.
 *     The contract pinned here is:
 *       getStripe() === null
 *       createStripeCustomer(...) === null
 *       createCheckoutSession(...) === null
 *       createBillingPortalSession(...) === null
 *       syncSubscriptionQuantity(...) === null
 *       updateSubscriptionPlan(...) === null
 *
 *  2. **Stripe IS configured but the requested price ID is missing.** Both
 *     `createCheckoutSession` and `updateSubscriptionPlan` look up a Stripe
 *     Price ID via `priceIdForTier(tier)`. If `STRIPE_PRICE_BASIC` /
 *     `STRIPE_PRICE_PRO` is unset, the function must return `null` *before*
 *     calling Stripe — otherwise Stripe would 400 with an opaque
 *     `parameter_missing` error and the upstream `startCheckout` would
 *     surface a generic `checkout_failed`, with no signal in the logs that
 *     the operator simply forgot to set the price-ID env var.
 *
 *     Pinning this fail-fast branch matters because the most common
 *     deployment misconfiguration is "Stripe secret set, price IDs not yet
 *     set". The current behaviour cleanly surfaces as
 *     `error: "checkout_failed"` upstream, but a regression that fell
 *     through to `stripe.checkout.sessions.create(...)` would make a real
 *     outbound API call (and a real failed-checkout audit-trail entry in
 *     Stripe) before failing — much harder to debug.
 *
 * The Stripe class is lazy: `new Stripe("sk_test_xyz")` does NOT make a
 * network call. As long as we never call a method on the returned client,
 * we can construct it freely in tests without needing to stub anything.
 * The module memoises the client at file scope, so once any test puts the
 * module into the "billing enabled" state, the cached client persists. The
 * tests below are written so they pass regardless of that cache state.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  createBillingPortalSession,
  createCheckoutSession,
  createStripeCustomer,
  getStripe,
  syncSubscriptionQuantity,
  updateSubscriptionPlan,
} from "../../src/billing/stripe.js";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// getStripe()
// ---------------------------------------------------------------------------

test("getStripe: returns null when STRIPE_SECRET_KEY is unset", () => {
  // The dev / Cloud Agent default. Every downstream helper checks this
  // null and degrades to its own null/error path, so the entire billing
  // surface depends on this branch returning cleanly.
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(getStripe(), null);
});

test("getStripe: returns null when STRIPE_SECRET_KEY is whitespace-only", () => {
  // Mirrors the trim contract in `billingEnabled()` (pinned separately in
  // billing/config.test.ts). A leading-newline value pasted into Railway is
  // the canonical operator footgun; if we treated whitespace-only as
  // configured, `new Stripe("\n")` would succeed silently and the first
  // real API call would 401 deep inside the checkout flow.
  process.env.STRIPE_SECRET_KEY = "   \n\t";
  assert.equal(getStripe(), null);
});

// ---------------------------------------------------------------------------
// createStripeCustomer() — no-stripe branch
// ---------------------------------------------------------------------------

test("createStripeCustomer: returns null when billing is not configured (no outbound API call)", async () => {
  // The signup completion flow calls this with the freshly-created agency
  // and tolerates `null` as "skip Stripe, leave stripe_customer_id unset".
  // A regression that threw here would crash every dev signup with an
  // unhandled rejection.
  delete process.env.STRIPE_SECRET_KEY;
  const customer = await createStripeCustomer({
    email: "test@example.com",
    name: "Test Agency",
    agencyId: 42,
  });
  assert.equal(customer, null);
});

// ---------------------------------------------------------------------------
// createCheckoutSession()
// ---------------------------------------------------------------------------

test("createCheckoutSession: returns null when billing is not configured", async () => {
  // Mirrors the contract in `startCheckout`: when STRIPE_SECRET_KEY is
  // unset, the helper must return null and `startCheckout` surfaces
  // `checkout_failed` (not `billing_not_configured` — that's reserved for
  // the `PATCH /v1/billing/plan` route).
  delete process.env.STRIPE_SECRET_KEY;
  const session = await createCheckoutSession({
    customerId: "cus_test",
    agencyId: 1,
    planTier: "basic",
    seatQuantity: 1,
    logsUnlimited: false,
  });
  assert.equal(session, null);
});

test("createCheckoutSession: returns null when STRIPE_PRICE_BASIC is unset (no Stripe API call)", async () => {
  // STRIPE_SECRET_KEY is set, but the basic price ID is missing. This is
  // the most common production misconfiguration: secret rotated, price IDs
  // not yet copied. The helper must fail-fast at `priceIdForTier` instead
  // of issuing a Stripe call with `price: undefined`, which Stripe would
  // happily 400 — but only AFTER putting a failed-checkout entry in the
  // Stripe dashboard audit trail.
  process.env.STRIPE_SECRET_KEY = "sk_test_stripe_unit_priceless_basic";
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_PRO;

  const session = await createCheckoutSession({
    customerId: "cus_test",
    agencyId: 1,
    planTier: "basic",
    seatQuantity: 1,
    logsUnlimited: false,
  });
  assert.equal(session, null);
});

test("createCheckoutSession: returns null when STRIPE_PRICE_PRO is unset and tier is 'pro'", async () => {
  // Symmetric to the basic case. The Pro tier gates AI dispatch — pinning
  // this branch keeps a half-configured deploy from offering Pro checkout
  // in the UI without a usable Stripe price behind it.
  process.env.STRIPE_SECRET_KEY = "sk_test_stripe_unit_priceless_pro";
  process.env.STRIPE_PRICE_BASIC = "price_basic_real";
  delete process.env.STRIPE_PRICE_PRO;

  const session = await createCheckoutSession({
    customerId: "cus_test",
    agencyId: 1,
    planTier: "pro",
    seatQuantity: 5,
    logsUnlimited: true,
  });
  assert.equal(session, null);
});

// ---------------------------------------------------------------------------
// createBillingPortalSession()
// ---------------------------------------------------------------------------

test("createBillingPortalSession: returns null when billing is not configured", async () => {
  // Used by `POST /v1/billing/portal`. When billing isn't configured, the
  // upstream route surfaces `portal_failed` (a 400) — not a 500. The null
  // return is what makes that contract possible.
  delete process.env.STRIPE_SECRET_KEY;
  const portal = await createBillingPortalSession("cus_test");
  assert.equal(portal, null);
});

// ---------------------------------------------------------------------------
// syncSubscriptionQuantity()
// ---------------------------------------------------------------------------

test("syncSubscriptionQuantity: returns null when billing is not configured (skipped during seat-count sweeps)", async () => {
  // `syncSeatsForAgency` runs from `addRadioUser` / `disableRadioUser` and
  // must NOT throw if billing isn't wired up. Pinning the null here is
  // what stops "adding a radio in dev crashes the request" regressions.
  delete process.env.STRIPE_SECRET_KEY;
  const sub = await syncSubscriptionQuantity("sub_test", 5);
  assert.equal(sub, null);
});

// ---------------------------------------------------------------------------
// updateSubscriptionPlan()
// ---------------------------------------------------------------------------

test("updateSubscriptionPlan: returns null when billing is not configured", async () => {
  // The `PATCH /v1/billing/plan` route guards on `billingEnabled()` itself,
  // but the helper must also no-op so callers from elsewhere (e.g. an
  // owner-portal future feature) don't have to repeat the check.
  delete process.env.STRIPE_SECRET_KEY;
  const sub = await updateSubscriptionPlan({
    subscriptionId: "sub_test",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 1,
  });
  assert.equal(sub, null);
});

test("updateSubscriptionPlan: returns null when target plan tier has no price ID configured", async () => {
  // Stripe IS configured, but the operator never set STRIPE_PRICE_PRO. A
  // user clicking "upgrade to pro" in the admin panel must NOT issue a
  // Stripe call with `price: undefined` — that surfaces in the Stripe
  // dashboard as a failed update and is brutal to debug because the
  // upstream error message is just `stripe_update_failed`.
  process.env.STRIPE_SECRET_KEY = "sk_test_stripe_unit_update_priceless";
  process.env.STRIPE_PRICE_BASIC = "price_basic_real";
  delete process.env.STRIPE_PRICE_PRO;

  const sub = await updateSubscriptionPlan({
    subscriptionId: "sub_test",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 3,
  });
  assert.equal(sub, null);
});
