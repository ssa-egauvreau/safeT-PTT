/**
 * Tests for `server/src/billing/config.ts`.
 *
 * `config.ts` is the trust boundary between Railway env vars and the rest
 * of the billing module. Every helper here gates real money:
 *
 *  - `billingEnabled()` is consulted by `getStripe()`, `routes.ts`, and
 *    `webhooks.ts` to short-circuit when Stripe is unconfigured. A
 *    regression that returned `true` on a blank/whitespace key would
 *    have the runtime trying (and failing noisily) to call Stripe on
 *    every request.
 *  - `priceIdForTier()` decides which Stripe price ID is used for the
 *    Basic vs Pro plan. Swapping these silently bills Pro customers at
 *    the Basic rate (or vice-versa).
 *  - `publicAppUrl()` is folded into `success_url` / `cancel_url` for
 *    Stripe Checkout. A trailing slash leaks into the redirect URL and
 *    the browser sees `//admin?...`. A malformed value would also let a
 *    misconfigured deploy redirect to an attacker-controlled host —
 *    pinned by the trim/strip rule plus the explicit fallback.
 *  - `billingFromEmail()` is the From: address for verification email.
 *    Falling back to the wrong default would burn deliverability
 *    silently.
 *
 * Each test isolates the env vars it touches so the rest of the suite
 * (and parallel test workers) can run unaffected.
 */

import { afterEach, test } from "node:test";
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

// Every config helper reads `process.env`; snapshot the keys this suite
// touches and restore after each case so nothing leaks between tests.
const ENV_KEYS = [
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

function snapshot(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    out[k] = process.env[k];
  }
  return out;
}

function restore(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = snap[k]!;
    }
  }
}

const ORIGINAL = snapshot();
afterEach(() => restore(ORIGINAL));

test("billingEnabled: false when STRIPE_SECRET_KEY is unset, blank, or whitespace", () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(billingEnabled(), false);

  process.env.STRIPE_SECRET_KEY = "";
  assert.equal(billingEnabled(), false);

  process.env.STRIPE_SECRET_KEY = "   ";
  assert.equal(
    billingEnabled(),
    false,
    "whitespace-only must read as unset — the check is .trim()-aware",
  );
});

test("billingEnabled: true when STRIPE_SECRET_KEY has any non-whitespace content", () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
  assert.equal(billingEnabled(), true);
});

test("stripeSecretKey / stripeWebhookSecret / stripePrice*: trim and return null on blank", () => {
  process.env.STRIPE_SECRET_KEY = "  sk_live_abcdef  ";
  process.env.STRIPE_WEBHOOK_SECRET = "  whsec_xyz  ";
  process.env.STRIPE_PRICE_BASIC = "  price_basic  ";
  process.env.STRIPE_PRICE_PRO = "  price_pro  ";
  process.env.STRIPE_PRICE_LOGS_UNLIMITED = "  price_logs  ";

  assert.equal(stripeSecretKey(), "sk_live_abcdef");
  assert.equal(stripeWebhookSecret(), "whsec_xyz");
  assert.equal(stripePriceBasic(), "price_basic");
  assert.equal(stripePricePro(), "price_pro");
  assert.equal(stripePriceLogsUnlimited(), "price_logs");

  // Empty string and whitespace-only must both read as null so missing
  // keys fail open (no Stripe calls) instead of being passed through
  // verbatim.
  process.env.STRIPE_PRICE_BASIC = "";
  process.env.STRIPE_PRICE_PRO = "   ";
  delete process.env.STRIPE_PRICE_LOGS_UNLIMITED;
  assert.equal(stripePriceBasic(), null);
  assert.equal(stripePricePro(), null);
  assert.equal(stripePriceLogsUnlimited(), null);
});

test("priceIdForTier: 'basic' tier resolves to STRIPE_PRICE_BASIC, 'pro' to STRIPE_PRICE_PRO", () => {
  // The single most expensive bug in this file would be flipping these
  // mappings — Pro customers get billed at Basic rate or vice-versa.
  process.env.STRIPE_PRICE_BASIC = "price_basic_id";
  process.env.STRIPE_PRICE_PRO = "price_pro_id";
  assert.equal(priceIdForTier("basic"), "price_basic_id");
  assert.equal(priceIdForTier("pro"), "price_pro_id");
});

test("priceIdForTier: returns null when the tier's price env var is unset", () => {
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_PRO;
  assert.equal(priceIdForTier("basic"), null);
  assert.equal(priceIdForTier("pro"), null);
});

test("publicAppUrl: prefers PUBLIC_APP_URL, falls back to APP_URL, then to the production hostname", () => {
  delete process.env.PUBLIC_APP_URL;
  delete process.env.APP_URL;
  assert.equal(
    publicAppUrl(),
    "https://safet-ptt.com",
    "must hard-code the production hostname when nothing is set so prod redirects don't 404",
  );

  process.env.APP_URL = "https://staging.safet-ptt.com";
  assert.equal(publicAppUrl(), "https://staging.safet-ptt.com");

  process.env.PUBLIC_APP_URL = "https://app.example.com";
  assert.equal(
    publicAppUrl(),
    "https://app.example.com",
    "PUBLIC_APP_URL must take precedence over APP_URL",
  );
});

test("publicAppUrl: strips trailing slashes so success_url doesn't double up '//admin'", () => {
  // `stripe.ts` builds `${publicAppUrl()}/admin?billing=success`. A
  // trailing slash on the env var would push Stripe to redirect the
  // browser to `https://app.example.com//admin?billing=success`,
  // which most servers normalise but which is fragile and looks broken
  // in the address bar.
  process.env.PUBLIC_APP_URL = "https://app.example.com/";
  assert.equal(publicAppUrl(), "https://app.example.com");
  process.env.PUBLIC_APP_URL = "https://app.example.com////";
  assert.equal(publicAppUrl(), "https://app.example.com");
});

test("publicAppUrl: ignores blank / whitespace-only values and treats them as unset", () => {
  process.env.PUBLIC_APP_URL = "   ";
  process.env.APP_URL = "https://app2.example.com";
  assert.equal(
    publicAppUrl(),
    "https://app2.example.com",
    "whitespace-only PUBLIC_APP_URL must NOT shadow a valid APP_URL",
  );

  process.env.PUBLIC_APP_URL = "";
  process.env.APP_URL = "";
  assert.equal(publicAppUrl(), "https://safet-ptt.com");
});

test("resendApiKey: trims and returns null on blank", () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(resendApiKey(), null);

  process.env.RESEND_API_KEY = "   ";
  assert.equal(resendApiKey(), null);

  process.env.RESEND_API_KEY = "  re_abc123  ";
  assert.equal(resendApiKey(), "re_abc123");
});

test("billingFromEmail: returns the configured override, otherwise the documented default", () => {
  delete process.env.BILLING_FROM_EMAIL;
  assert.equal(billingFromEmail(), "billing@safetptt.com");

  process.env.BILLING_FROM_EMAIL = "   ";
  assert.equal(
    billingFromEmail(),
    "billing@safetptt.com",
    "whitespace-only override must fall back to the default — the From: header is the customer's first impression of the platform and a blank one tanks deliverability",
  );

  process.env.BILLING_FROM_EMAIL = "  no-reply@example.com  ";
  assert.equal(billingFromEmail(), "no-reply@example.com");
});
