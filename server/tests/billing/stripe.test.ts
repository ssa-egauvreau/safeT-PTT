/**
 * Tests for `server/src/billing/stripe.ts`.
 *
 * The Stripe wrapper is intentionally thin — every helper either returns a
 * Stripe object (live API call) or `null` (billing not configured). The
 * `null` path is what every billing route depends on to degrade gracefully:
 *
 *   - `routes.ts:/billing/portal` reads `openBillingPortal()` and returns
 *     `portal_failed` to the admin UI when this layer says `null`.
 *   - `subscription.ts:startCheckout()` reads `createStripeCustomer()` and
 *     `createCheckoutSession()` and surfaces `stripe_customer_failed` /
 *     `checkout_failed` when either returns `null`.
 *   - `signup.ts:completeSignup()` calls `createStripeCustomer()` and
 *     happily continues past a `null` return so dev / CI signups don't
 *     hard-fail when no Stripe key is configured.
 *
 * A regression that made any of these helpers throw instead of returning
 * `null` would convert a graceful "billing_not_configured" UX into a 500
 * stack trace on every dev / CI request. This file pins the contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

const stripeMod = await import("../../src/billing/stripe.js");

// ---------------------------------------------------------------------------
// getStripe
// ---------------------------------------------------------------------------

test("getStripe: returns null when STRIPE_SECRET_KEY is unset", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(stripeMod.getStripe(), null);
  });
});

test("getStripe: returns null when STRIPE_SECRET_KEY is whitespace", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "   " }, () => {
    assert.equal(stripeMod.getStripe(), null);
  });
});

// ---------------------------------------------------------------------------
// Helpers must short-circuit to null when billing is not configured.
//
// All of these are critical: each is called from a request handler that
// would otherwise 500 on every request without a Stripe key.
// ---------------------------------------------------------------------------

test("createStripeCustomer: returns null when billing is not configured (no throw)", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
    const result = await stripeMod.createStripeCustomer({
      email: "ops@example.com",
      name: "Ops Dept",
      agencyId: 7,
    });
    assert.equal(result, null);
  });
});

test("createCheckoutSession: returns null when STRIPE_SECRET_KEY is unset", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_PRICE_BASIC: "price_basic" }, async () => {
    const result = await stripeMod.createCheckoutSession({
      customerId: "cus_x",
      agencyId: 7,
      planTier: "basic",
      seatQuantity: 1,
      logsUnlimited: false,
    });
    assert.equal(result, null);
  });
});

test("createCheckoutSession: returns null when the matching price ID is missing", async () => {
  // Even with a valid secret key, the helper must not call Stripe with an
  // undefined price — Stripe would 400 with a confusing parameter error.
  // Returning null lets the caller surface `checkout_failed` cleanly.
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PRICE_BASIC: undefined,
      STRIPE_PRICE_PRO: undefined,
    },
    async () => {
      const result = await stripeMod.createCheckoutSession({
        customerId: "cus_x",
        agencyId: 7,
        planTier: "basic",
        seatQuantity: 1,
        logsUnlimited: false,
      });
      assert.equal(result, null);
    },
  );
});

test("createBillingPortalSession: returns null when billing is not configured", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
    const result = await stripeMod.createBillingPortalSession("cus_test");
    assert.equal(result, null);
  });
});

test("syncSubscriptionQuantity: returns null when billing is not configured", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
    const result = await stripeMod.syncSubscriptionQuantity("sub_test", 5);
    assert.equal(result, null);
  });
});

test("updateSubscriptionPlan: returns null when STRIPE_SECRET_KEY is unset", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_PRICE_BASIC: "price_basic" }, async () => {
    const result = await stripeMod.updateSubscriptionPlan({
      subscriptionId: "sub_test",
      planTier: "basic",
      logsUnlimited: false,
      seatQuantity: 1,
    });
    assert.equal(result, null);
  });
});

test("updateSubscriptionPlan: returns null when the matching price ID is missing", async () => {
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PRICE_BASIC: undefined,
      STRIPE_PRICE_PRO: undefined,
    },
    async () => {
      const result = await stripeMod.updateSubscriptionPlan({
        subscriptionId: "sub_test",
        planTier: "pro",
        logsUnlimited: false,
        seatQuantity: 1,
      });
      assert.equal(result, null);
    },
  );
});
