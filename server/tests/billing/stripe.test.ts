/**
 * Tests for `server/src/billing/stripe.ts`.
 *
 * Every helper in this file is a thin wrapper around the Stripe SDK that
 * MUST short-circuit to `null` when the API key is not configured. This
 * is the platform's fail-closed posture for billing:
 *
 *  - The platform runs without billing in many environments (Cloud Agent
 *    VMs, local dev, on-prem trial deployments). The radio path must
 *    keep working; only the billing endpoints degrade.
 *  - If `getStripe()` instantiated a `new Stripe(undefined!)` it would
 *    throw at module-init time and crash the server-wide boot path.
 *  - If `createCheckoutSession()` didn't bail when the price env var is
 *    missing, Stripe would respond with a confusing
 *    "No such price: 'undefined'" error to the admin panel.
 *
 * These tests pin the contract: with billing disabled (no
 * STRIPE_SECRET_KEY) every wrapper returns `null` synchronously without
 * touching the Stripe SDK. The webhook handler + routes treat `null` as
 * "billing not configured" and respond 503 to the caller.
 *
 * The webhook handler is exercised separately in `webhooks.test.ts`;
 * this file covers only the SDK-wrapper layer.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
  "PUBLIC_APP_URL",
  "APP_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

const stripeMod = await import("../../src/billing/stripe.js");

test("getStripe: returns null when STRIPE_SECRET_KEY is unset (no SDK boot)", () => {
  // A regression that instantiated `new Stripe(undefined!)` would throw
  // synchronously at first call and crash any boot path that touches
  // billing (e.g. the hourly trial sweep, the admin Billing panel poll).
  assert.equal(stripeMod.getStripe(), null);
});

test("getStripe: returns null when STRIPE_SECRET_KEY is whitespace only", () => {
  // A common operator footgun is a leading newline in a copy-pasted env
  // var. `billingEnabled()` trims before checking truthiness, so the
  // wrapper must agree and treat whitespace-only as unset.
  process.env.STRIPE_SECRET_KEY = "   \n\t ";
  assert.equal(stripeMod.getStripe(), null);
});

test("createStripeCustomer: returns null and skips the Stripe API call when billing is disabled", async () => {
  // A regression that called `stripe.customers.create()` on a null
  // client would throw `TypeError: Cannot read properties of null` and
  // surface as a 500 from the signup endpoint. Pinning the null return
  // proves the bail-out is in place.
  const result = await stripeMod.createStripeCustomer({
    email: "tester@example.com",
    name: "Test Agency",
    agencyId: 7,
    metadata: { trial: "true" },
  });
  assert.equal(result, null);
});

test("createCheckoutSession: returns null when billing is disabled (no Stripe call)", async () => {
  // Set the price env vars so we prove the bail-out is on the
  // Stripe-client check, not on `priceIdForTier()` returning null.
  process.env.STRIPE_PRICE_BASIC = "price_basic_x";
  process.env.STRIPE_PRICE_PRO = "price_pro_x";
  const result = await stripeMod.createCheckoutSession({
    customerId: "cus_xxx",
    agencyId: 7,
    planTier: "pro",
    seatQuantity: 4,
    logsUnlimited: true,
  });
  assert.equal(result, null);
});

test("createCheckoutSession: returns null when the price env var for the tier is unset", async () => {
  // With billing enabled but the Pro price env var missing, the helper
  // must still bail out to null so the admin gets a clean
  // `checkout_failed` rather than a Stripe "No such price" error.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  // STRIPE_PRICE_PRO intentionally left unset.
  process.env.STRIPE_PRICE_BASIC = "price_basic_x";
  const result = await stripeMod.createCheckoutSession({
    customerId: "cus_xxx",
    agencyId: 7,
    planTier: "pro",
    seatQuantity: 1,
    logsUnlimited: false,
  });
  assert.equal(result, null);
});

test("createBillingPortalSession: returns null when billing is disabled", async () => {
  // The admin Billing panel's "Manage subscription" button calls this
  // endpoint. With no STRIPE_SECRET_KEY the surrounding route returns
  // 400 `portal_failed`; if this helper instead threw, it would 500.
  const result = await stripeMod.createBillingPortalSession("cus_xxx");
  assert.equal(result, null);
});

test("syncSubscriptionQuantity: returns null when billing is disabled", async () => {
  // Called from `syncSeatsForAgency` when an admin adds/removes a radio
  // user. Without billing the helper must no-op cleanly so seat changes
  // still succeed locally (the local user count is what gates concurrent
  // logins; Stripe sync is an additive billing concern).
  const result = await stripeMod.syncSubscriptionQuantity("sub_xxx", 5);
  assert.equal(result, null);
});

test("updateSubscriptionPlan: returns null when billing is disabled", async () => {
  // Called from `changePlan` when an admin switches Basic ↔ Pro. With
  // billing disabled the surrounding route still updates the local
  // `plan_tier` column (so feature gates like AI dispatch unlock), but
  // this helper must not crash.
  process.env.STRIPE_PRICE_BASIC = "price_basic_x";
  process.env.STRIPE_PRICE_PRO = "price_pro_x";
  const result = await stripeMod.updateSubscriptionPlan({
    subscriptionId: "sub_xxx",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 3,
  });
  assert.equal(result, null);
});

test("updateSubscriptionPlan: returns null when the target tier's price env var is unset", async () => {
  // Billing is enabled but STRIPE_PRICE_PRO is missing. A regression
  // that proceeded with `priceIdForTier('pro') === null` would send
  // `items: [{ id, price: null }]` to Stripe and 400 from the SDK.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_BASIC = "price_basic_x";
  // STRIPE_PRICE_PRO intentionally unset.
  const result = await stripeMod.updateSubscriptionPlan({
    subscriptionId: "sub_xxx",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 1,
  });
  assert.equal(result, null);
});
