/**
 * Tests for `server/src/billing/config.ts`.
 *
 * Every billing decision — whether the Stripe SDK is wired up, which price IDs
 * back the basic/pro plans, which add-on backs `logs_unlimited`, and which
 * `success_url`/`cancel_url`/`return_url` Stripe redirects back to — flows
 * through these env helpers. If any of them misread an env var, the agency
 * either lands on the wrong Stripe Checkout (overcharged or under-provisioned)
 * or the API silently downgrades into "billing not configured" mode and skips
 * Stripe writes. The cost of a regression here is real money and broken
 * tenants, so this file pins every helper's input → output contract.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  billingEnabled,
  billingFromEmail,
  priceIdForTier,
  publicAppUrl,
  resendApiKey,
  stripePriceBasic,
  stripePriceLogsUnlimited,
  stripePricePro,
  stripeSecretKey,
  stripeWebhookSecret,
} from "../../src/billing/config.js";

const TRACKED_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
  "PUBLIC_APP_URL",
  "APP_URL",
  "RESEND_API_KEY",
  "BILLING_FROM_EMAIL",
] as const;

let saved: Partial<Record<(typeof TRACKED_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of TRACKED_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const v = saved[key];
    if (v === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = v;
    }
  }
});

test("billingEnabled: requires a non-empty STRIPE_SECRET_KEY", () => {
  assert.equal(billingEnabled(), false, "unset means Stripe is off");
  process.env.STRIPE_SECRET_KEY = "";
  assert.equal(billingEnabled(), false, "empty string is not configured");
  process.env.STRIPE_SECRET_KEY = "   ";
  assert.equal(billingEnabled(), false, "whitespace-only is not configured");
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  assert.equal(billingEnabled(), true);
});

test("stripeSecretKey / stripeWebhookSecret trim and return null when blank", () => {
  assert.equal(stripeSecretKey(), null);
  assert.equal(stripeWebhookSecret(), null);

  process.env.STRIPE_SECRET_KEY = "  sk_live_42  ";
  process.env.STRIPE_WEBHOOK_SECRET = "\twhsec_abc\n";
  assert.equal(stripeSecretKey(), "sk_live_42");
  assert.equal(stripeWebhookSecret(), "whsec_abc");

  process.env.STRIPE_SECRET_KEY = "   ";
  assert.equal(stripeSecretKey(), null, "whitespace-only collapses to null");
});

test("stripePriceBasic / stripePricePro / stripePriceLogsUnlimited each read their own var and trim", () => {
  process.env.STRIPE_PRICE_BASIC = " price_basic ";
  process.env.STRIPE_PRICE_PRO = "price_pro";
  process.env.STRIPE_PRICE_LOGS_UNLIMITED = "  price_logs  ";

  assert.equal(stripePriceBasic(), "price_basic");
  assert.equal(stripePricePro(), "price_pro");
  assert.equal(stripePriceLogsUnlimited(), "price_logs");
});

test("priceIdForTier picks the pro price for 'pro' and the basic price otherwise", () => {
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  process.env.STRIPE_PRICE_PRO = "price_pro";

  assert.equal(priceIdForTier("pro"), "price_pro");
  assert.equal(priceIdForTier("basic"), "price_basic");
});

test("priceIdForTier returns null when the requested tier's price is unset", () => {
  // Pro requested but only basic configured — must not silently fall back to
  // the basic price, since that would charge the wrong plan.
  process.env.STRIPE_PRICE_BASIC = "price_basic";
  assert.equal(priceIdForTier("pro"), null);
  assert.equal(priceIdForTier("basic"), "price_basic");
});

test("publicAppUrl prefers PUBLIC_APP_URL, falls back to APP_URL, then the production default", () => {
  assert.equal(publicAppUrl(), "https://safet-ptt.com");

  process.env.APP_URL = "https://staging.example.com";
  assert.equal(publicAppUrl(), "https://staging.example.com", "APP_URL is the secondary source");

  process.env.PUBLIC_APP_URL = "https://app.example.com";
  assert.equal(publicAppUrl(), "https://app.example.com", "PUBLIC_APP_URL wins when both are set");
});

test("publicAppUrl strips trailing slashes so we never build URLs like '…//admin'", () => {
  process.env.PUBLIC_APP_URL = "https://app.example.com/";
  assert.equal(publicAppUrl(), "https://app.example.com");
  process.env.PUBLIC_APP_URL = "https://app.example.com////";
  assert.equal(publicAppUrl(), "https://app.example.com");
});

test("publicAppUrl treats whitespace-only env values as unset", () => {
  process.env.PUBLIC_APP_URL = "   ";
  process.env.APP_URL = "   ";
  assert.equal(publicAppUrl(), "https://safet-ptt.com");
});

test("resendApiKey / billingFromEmail honor env, with a non-empty default sender", () => {
  assert.equal(resendApiKey(), null);
  assert.equal(billingFromEmail(), "billing@safetptt.com", "default keeps verification email working in dev");

  process.env.RESEND_API_KEY = "  re_abc  ";
  process.env.BILLING_FROM_EMAIL = "  ops@example.com  ";
  assert.equal(resendApiKey(), "re_abc");
  assert.equal(billingFromEmail(), "ops@example.com");
});
