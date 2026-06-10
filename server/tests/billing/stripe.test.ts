/**
 * Tests for `server/src/billing/stripe.ts`.
 *
 * Every wrapper here MUST short-circuit to `null` when billing is not
 * configured (`STRIPE_SECRET_KEY` unset / blank). This is the load-bearing
 * guard that lets the rest of the platform run in dev / Cloud Agent mode
 * without a Stripe credential — and the contract every caller in
 * `subscription.ts`, `signup.ts`, and `webhooks.ts` relies on:
 *
 *   - A regression that constructed `new Stripe("")` would crash the
 *     Express request mid-handler with a "no API key provided" error,
 *     surfacing as a 500 to the user instead of a clean 400/503.
 *   - A regression that proceeded to `stripe.customers.create({...})`
 *     with a missing key would throw on the first network call,
 *     producing the same observable bug.
 *   - A regression that returned an empty object instead of `null`
 *     would slip past the truthiness checks in
 *     `subscription.ensureStripeCustomer` and try to write a `null`
 *     `stripeCustomerId` back to the agency row.
 *
 * The second contract pinned here is `createCheckoutSession` /
 * `updateSubscriptionPlan` returning `null` when the price ID for the
 * requested plan tier is unset. A regression that fell through with an
 * undefined price would either build a checkout URL with no line items
 * (Stripe rejects with a 400) or silently swap the agency to a
 * different price.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
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

const stripeMod = await import("../../src/billing/stripe.js");

// ---------------------------------------------------------------------------
// `getStripe` — the central guard
// ---------------------------------------------------------------------------

test("getStripe: returns null when STRIPE_SECRET_KEY is unset", () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(stripeMod.getStripe(), null);
});

test("getStripe: returns null when STRIPE_SECRET_KEY is whitespace-only", () => {
  // The config helper trims; whitespace is NOT a valid credential and
  // must fail the `billingEnabled()` gate.
  process.env.STRIPE_SECRET_KEY = "   \n\t";
  assert.equal(stripeMod.getStripe(), null);
});

// ---------------------------------------------------------------------------
// Wrapper functions short-circuit when billing is disabled
// ---------------------------------------------------------------------------

test("createStripeCustomer: returns null when billing is not configured (no network call)", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const result = await stripeMod.createStripeCustomer({
    email: "ops@example.com",
    name: "Test Agency",
    agencyId: 1,
  });
  assert.equal(result, null);
});

test("createCheckoutSession: returns null when billing is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  const result = await stripeMod.createCheckoutSession({
    customerId: "cus_test",
    agencyId: 1,
    planTier: "basic",
    seatQuantity: 5,
    logsUnlimited: false,
  });
  assert.equal(result, null);
});

test("createCheckoutSession: returns null when the requested plan's price ID is unset", async () => {
  // Even with billing nominally enabled (a secret key present), a
  // missing `STRIPE_PRICE_PRO` must NOT silently fall back to basic;
  // the wrapper must refuse the call so the route surfaces a clean
  // checkout_failed error.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_test";
  delete process.env.STRIPE_PRICE_PRO;
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  const result = await stripeMod.createCheckoutSession({
    customerId: "cus_test",
    agencyId: 1,
    planTier: "pro",
    seatQuantity: 5,
    logsUnlimited: false,
  });
  assert.equal(result, null, "missing pro price must short-circuit (no Stripe call)");
});

test("createBillingPortalSession: returns null when billing is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const result = await stripeMod.createBillingPortalSession("cus_test");
  assert.equal(result, null);
});

test("syncSubscriptionQuantity: returns null when billing is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const result = await stripeMod.syncSubscriptionQuantity("sub_test", 3);
  assert.equal(result, null);
});

test("updateSubscriptionPlan: returns null when billing is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  const result = await stripeMod.updateSubscriptionPlan({
    subscriptionId: "sub_test",
    planTier: "basic",
    logsUnlimited: false,
    seatQuantity: 5,
  });
  assert.equal(result, null);
});

test("updateSubscriptionPlan: returns null when the requested plan's price ID is unset", async () => {
  // Same fail-closed contract as createCheckoutSession — refuse to
  // change the plan if the operator hasn't wired the price ID for the
  // target tier.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_test";
  delete process.env.STRIPE_PRICE_PRO;
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  const result = await stripeMod.updateSubscriptionPlan({
    subscriptionId: "sub_test",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 5,
  });
  assert.equal(result, null);
});
