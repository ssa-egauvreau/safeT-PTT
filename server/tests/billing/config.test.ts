/**
 * Tests for `server/src/billing/config.ts`.
 *
 * Every billing decision flows through these env-driven helpers. The
 * dangerous regressions are subtle:
 *
 *  - `billingEnabled()` returns true with only a whitespace-padded env value.
 *    If a deploy ships with `STRIPE_SECRET_KEY="   "` (a common config-system
 *    mistake), `billingEnabled()` must report false so the API returns
 *    `billing_not_configured` instead of trying to instantiate Stripe with a
 *    bogus key.
 *
 *  - `priceIdForTier()` MUST route "pro" to the pro price and everything else
 *    to basic, or customers get billed at the wrong rate.
 *
 *  - `publicAppUrl()` is interpolated into Stripe success/cancel URLs. A
 *    trailing slash would produce `https://.../admin?billing=success`
 *    incorrectly (`//admin`), which breaks the redirect on some browsers.
 *    The helper must strip ALL trailing slashes and fall back to the
 *    production URL when no env is set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  billingEnabled,
  stripeSecretKey,
  stripeWebhookSecret,
  stripePriceBasic,
  stripePricePro,
  stripePriceLogsUnlimited,
  publicAppUrl,
  priceIdForTier,
  resendApiKey,
  billingFromEmail,
} = await import("../../src/billing/config.js");

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    const next = vars[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const prev = previous[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

test("billingEnabled: requires a non-empty, non-whitespace STRIPE_SECRET_KEY", () => {
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "   " }, () => {
    assert.equal(billingEnabled(), false, "whitespace-only env must not enable billing");
  });
  withEnv({ STRIPE_SECRET_KEY: "sk_test_abc" }, () => {
    assert.equal(billingEnabled(), true);
  });
});

test("stripeSecretKey / webhook / price env helpers trim and null on empty", () => {
  withEnv({ STRIPE_SECRET_KEY: "  sk_live_xyz  " }, () => {
    assert.equal(stripeSecretKey(), "sk_live_xyz");
  });
  withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(stripeSecretKey(), null);
  });

  withEnv({ STRIPE_WEBHOOK_SECRET: "whsec_padded   " }, () => {
    assert.equal(stripeWebhookSecret(), "whsec_padded");
  });
  withEnv({ STRIPE_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(stripeWebhookSecret(), null);
  });

  withEnv({ STRIPE_PRICE_BASIC: "price_basic_1" }, () => {
    assert.equal(stripePriceBasic(), "price_basic_1");
  });
  withEnv({ STRIPE_PRICE_PRO: "price_pro_1" }, () => {
    assert.equal(stripePricePro(), "price_pro_1");
  });
  withEnv({ STRIPE_PRICE_LOGS_UNLIMITED: "price_logs_1" }, () => {
    assert.equal(stripePriceLogsUnlimited(), "price_logs_1");
  });
});

test("priceIdForTier: pro -> pro price, anything else -> basic", () => {
  withEnv({ STRIPE_PRICE_BASIC: "price_basic_1", STRIPE_PRICE_PRO: "price_pro_1" }, () => {
    assert.equal(priceIdForTier("pro"), "price_pro_1");
    assert.equal(priceIdForTier("basic"), "price_basic_1");
  });
  // Missing price ids must surface as null so callers can refuse to create
  // a checkout session with an unconfigured price.
  withEnv({ STRIPE_PRICE_BASIC: undefined, STRIPE_PRICE_PRO: undefined }, () => {
    assert.equal(priceIdForTier("pro"), null);
    assert.equal(priceIdForTier("basic"), null);
  });
});

test("publicAppUrl: defaults to safet-ptt.com when no env is set", () => {
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: undefined }, () => {
    assert.equal(publicAppUrl(), "https://safet-ptt.com");
  });
});

test("publicAppUrl: prefers PUBLIC_APP_URL, falls back to APP_URL", () => {
  withEnv({ PUBLIC_APP_URL: "https://public.example.com", APP_URL: "https://other.example.com" }, () => {
    assert.equal(publicAppUrl(), "https://public.example.com");
  });
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: "https://only-app.example.com" }, () => {
    assert.equal(publicAppUrl(), "https://only-app.example.com");
  });
});

test("publicAppUrl: strips trailing slashes so success_url interpolation never doubles", () => {
  withEnv({ PUBLIC_APP_URL: "https://app.example.com/", APP_URL: undefined }, () => {
    assert.equal(publicAppUrl(), "https://app.example.com");
  });
  withEnv({ PUBLIC_APP_URL: "https://app.example.com///", APP_URL: undefined }, () => {
    assert.equal(publicAppUrl(), "https://app.example.com");
  });
});

test("resendApiKey / billingFromEmail: trim env values; from-email has a safe default", () => {
  withEnv({ RESEND_API_KEY: "  re_abc  " }, () => {
    assert.equal(resendApiKey(), "re_abc");
  });
  withEnv({ RESEND_API_KEY: "" }, () => {
    assert.equal(resendApiKey(), null);
  });

  withEnv({ BILLING_FROM_EMAIL: undefined }, () => {
    assert.equal(billingFromEmail(), "billing@safetptt.com");
  });
  withEnv({ BILLING_FROM_EMAIL: "  ops@example.com " }, () => {
    assert.equal(billingFromEmail(), "ops@example.com");
  });
});
