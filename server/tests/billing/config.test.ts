/**
 * Env-driven tests for `server/src/billing/config.ts`.
 *
 * These getters are read from many places in the billing stack — every
 * Stripe write goes through `getStripe()` which is gated by `billingEnabled()`,
 * the checkout flow picks a price via `priceIdForTier()`, and Stripe redirects
 * land on `publicAppUrl()`. A regression that mis-trims, mis-defaults, or
 * mis-routes any of these silently breaks production billing without a
 * crash — exactly the class of bug that's expensive to discover post-deploy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  billingEnabled,
  priceIdForTier,
  publicAppUrl,
  stripePriceBasic,
  stripePricePro,
  stripeSecretKey,
  stripeWebhookSecret,
  resendApiKey,
  billingFromEmail,
} from "../../src/billing/config.js";

/** Snapshot/restore the env vars these tests touch so order doesn't matter. */
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  }
}

test("billingEnabled: true only when STRIPE_SECRET_KEY is set and non-blank", () => {
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "   " }, () => {
    // Whitespace-only must NOT count as "configured" — otherwise the
    // billing router would try to talk to Stripe with an empty key on
    // every request and burn 503s.
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "sk_test_dummy" }, () => {
    assert.equal(billingEnabled(), true);
  });
});

test("stripeSecretKey/stripeWebhookSecret/resendApiKey: trim and null-on-empty", () => {
  withEnv(
    {
      STRIPE_SECRET_KEY: "  sk_test_x  ",
      STRIPE_WEBHOOK_SECRET: "  whsec_y  ",
      RESEND_API_KEY: "  re_z  ",
    },
    () => {
      assert.equal(stripeSecretKey(), "sk_test_x");
      assert.equal(stripeWebhookSecret(), "whsec_y");
      assert.equal(resendApiKey(), "re_z");
    },
  );
  withEnv(
    {
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
    },
    () => {
      assert.equal(stripeSecretKey(), null);
      assert.equal(stripeWebhookSecret(), null);
      assert.equal(resendApiKey(), null);
    },
  );
});

test("priceIdForTier: routes 'pro' to STRIPE_PRICE_PRO and 'basic' to STRIPE_PRICE_BASIC", () => {
  // A swap here is the textbook "we charged the wrong price" regression.
  withEnv(
    {
      STRIPE_PRICE_BASIC: "price_basic_id",
      STRIPE_PRICE_PRO: "price_pro_id",
    },
    () => {
      assert.equal(priceIdForTier("basic"), "price_basic_id");
      assert.equal(priceIdForTier("pro"), "price_pro_id");
      assert.equal(stripePriceBasic(), "price_basic_id");
      assert.equal(stripePricePro(), "price_pro_id");
    },
  );
});

test("priceIdForTier: returns null when the matching price env is unset", () => {
  // The checkout flow short-circuits to `checkout_failed` when no price is
  // configured. Verifying null here pins that "missing price" stays a
  // null sentinel, not an empty string that would slip past the
  // `if (!basePrice)` guard in `createCheckoutSession`.
  withEnv(
    { STRIPE_PRICE_BASIC: undefined, STRIPE_PRICE_PRO: undefined },
    () => {
      assert.equal(priceIdForTier("basic"), null);
      assert.equal(priceIdForTier("pro"), null);
    },
  );
});

test("publicAppUrl: prefers PUBLIC_APP_URL over APP_URL and strips trailing slashes", () => {
  withEnv(
    { PUBLIC_APP_URL: "https://example.com/", APP_URL: "https://other.com" },
    () => {
      // Trailing slash MUST be stripped — Stripe success_url / cancel_url
      // append `/admin?billing=success`, so a leftover slash gives
      // `//admin?billing=success` which 404s on most edge proxies.
      assert.equal(publicAppUrl(), "https://example.com");
    },
  );
  withEnv(
    { PUBLIC_APP_URL: undefined, APP_URL: "https://fallback.com///" },
    () => {
      assert.equal(publicAppUrl(), "https://fallback.com");
    },
  );
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: undefined }, () => {
    // The default has to be the production hostname — the SPA generates
    // signup verification deeplinks against this, and an accidental
    // `localhost` default would leak into emailed links.
    assert.equal(publicAppUrl(), "https://safet-ptt.com");
  });
});

test("billingFromEmail: defaults to billing@safetptt.com when env is empty", () => {
  withEnv({ BILLING_FROM_EMAIL: undefined }, () => {
    assert.equal(billingFromEmail(), "billing@safetptt.com");
  });
  withEnv({ BILLING_FROM_EMAIL: "  ops@safet-ptt.com  " }, () => {
    assert.equal(billingFromEmail(), "ops@safet-ptt.com");
  });
});
