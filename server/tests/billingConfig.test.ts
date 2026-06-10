/**
 * Tests for `server/src/billing/config.ts` — the env-var read layer for the
 * Stripe billing pipeline added in the self-service billing rollout
 * (commit 4e7ffa6).
 *
 * Why these matter:
 *  - `billingEnabled()` and `stripeSecretKey()` decide whether the entire
 *    `getStripe()` client is constructed. A regression that flipped a
 *    whitespace-only env var to "enabled" would either crash on the first
 *    Stripe call or — worse — instantiate a Stripe client against an empty
 *    secret and silently 401 every checkout attempt.
 *  - `priceIdForTier()` is the single source of truth that maps the public
 *    plan name ("basic" / "pro") to a Stripe Price ID. Mis-routing here would
 *    bill the wrong tier and break the Pro = AI-dispatch gate.
 *  - `publicAppUrl()` is the redirect base for Stripe checkout success/cancel
 *    URLs. A trailing-slash regression would yield doubled slashes like
 *    `https://safet-ptt.com//admin?billing=success` which some browsers
 *    treat as a separate origin and breaks the post-checkout session cookie.
 *  - `billingFromEmail()` is the "From:" on the signup verification email;
 *    pinning the default keeps dev environments from accidentally sending as
 *    a placeholder no-reply that a recipient mail server would reject.
 *
 * The helpers are pure (read-only environment access), so each test snapshots
 * and restores the relevant variables to keep the test file independent.
 */

import { test } from "node:test";
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
} from "../src/billing/config.js";

/**
 * Snapshot/restore a set of env vars so each test is fully independent.
 * Returns a `restore()` callback that undoes every change made in `mutator`.
 */
function withEnv<T>(keys: string[], mutator: (set: (k: string, v: string | undefined) => void) => T): T {
  const snapshot = new Map<string, string | undefined>();
  for (const k of keys) {
    snapshot.set(k, process.env[k]);
  }
  const set = (k: string, v: string | undefined): void => {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  };
  try {
    return mutator(set);
  } finally {
    for (const [k, v] of snapshot) {
      set(k, v);
    }
  }
}

test("billingEnabled: only true when STRIPE_SECRET_KEY has non-whitespace content", () => {
  // Whitespace-only secret must NOT enable billing — otherwise getStripe()
  // would construct a Stripe client with an empty string and every API call
  // would 401 with no actionable error in the console.
  withEnv(["STRIPE_SECRET_KEY"], (set) => {
    set("STRIPE_SECRET_KEY", undefined);
    assert.equal(billingEnabled(), false, "unset → disabled");

    set("STRIPE_SECRET_KEY", "");
    assert.equal(billingEnabled(), false, "empty string → disabled");

    set("STRIPE_SECRET_KEY", "   ");
    assert.equal(billingEnabled(), false, "whitespace-only → disabled");

    set("STRIPE_SECRET_KEY", "sk_test_123");
    assert.equal(billingEnabled(), true, "real secret → enabled");

    set("STRIPE_SECRET_KEY", "  sk_test_abc  ");
    assert.equal(billingEnabled(), true, "padded secret → enabled (trimmed)");
  });
});

test("stripeSecretKey / stripeWebhookSecret: trim and return null when blank", () => {
  // `null` vs empty-string distinction matters — the webhook handler checks
  // `if (!stripe || !secret)` and short-circuits with a 503. A regression
  // that returned "" instead of null would still pass the falsy check, but
  // any caller using `!== null` would mis-handle it.
  withEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], (set) => {
    set("STRIPE_SECRET_KEY", undefined);
    set("STRIPE_WEBHOOK_SECRET", undefined);
    assert.equal(stripeSecretKey(), null);
    assert.equal(stripeWebhookSecret(), null);

    set("STRIPE_SECRET_KEY", "   ");
    set("STRIPE_WEBHOOK_SECRET", "\n\t");
    assert.equal(stripeSecretKey(), null, "whitespace → null");
    assert.equal(stripeWebhookSecret(), null, "whitespace → null");

    set("STRIPE_SECRET_KEY", "  sk_live_xyz  ");
    set("STRIPE_WEBHOOK_SECRET", "  whsec_abc  ");
    assert.equal(stripeSecretKey(), "sk_live_xyz", "trimmed");
    assert.equal(stripeWebhookSecret(), "whsec_abc", "trimmed");
  });
});

test("priceIdForTier: pro routes to STRIPE_PRICE_PRO; everything else to STRIPE_PRICE_BASIC", () => {
  // This is the only mapping between the public plan name and the Stripe
  // Price ID. A regression that swapped the two would charge basic
  // customers the pro rate (overbilling) or unlock AI dispatch to basic
  // customers (the Pro gate is plan_tier === "pro" — see
  // `agencyAllowsAiDispatch` in store.ts).
  withEnv(["STRIPE_PRICE_BASIC", "STRIPE_PRICE_PRO", "STRIPE_PRICE_LOGS_UNLIMITED"], (set) => {
    set("STRIPE_PRICE_BASIC", "price_basic_123");
    set("STRIPE_PRICE_PRO", "price_pro_456");
    set("STRIPE_PRICE_LOGS_UNLIMITED", "price_logs_789");

    assert.equal(priceIdForTier("basic"), "price_basic_123");
    assert.equal(priceIdForTier("pro"), "price_pro_456");
    assert.equal(stripePriceBasic(), "price_basic_123");
    assert.equal(stripePricePro(), "price_pro_456");
    assert.equal(stripePriceLogsUnlimited(), "price_logs_789");

    // Missing price IDs return null so createCheckoutSession can fail fast
    // instead of asking Stripe to look up an empty Price ID.
    set("STRIPE_PRICE_BASIC", undefined);
    set("STRIPE_PRICE_PRO", undefined);
    set("STRIPE_PRICE_LOGS_UNLIMITED", undefined);
    assert.equal(priceIdForTier("basic"), null);
    assert.equal(priceIdForTier("pro"), null);
    assert.equal(stripePriceLogsUnlimited(), null);
  });
});

test("publicAppUrl: strips trailing slashes; prefers PUBLIC_APP_URL over APP_URL; defaults to prod", () => {
  // Trailing slashes cause Stripe checkout to redirect to a doubled path
  // (`//admin?billing=success`) which some session middleware treats as a
  // different origin, breaking the post-checkout login. The strip is non-
  // negotiable.
  withEnv(["PUBLIC_APP_URL", "APP_URL"], (set) => {
    set("PUBLIC_APP_URL", undefined);
    set("APP_URL", undefined);
    assert.equal(publicAppUrl(), "https://safet-ptt.com", "default to prod");

    set("APP_URL", "http://localhost:8080");
    assert.equal(publicAppUrl(), "http://localhost:8080", "APP_URL fallback");

    set("APP_URL", "http://localhost:8080/");
    assert.equal(publicAppUrl(), "http://localhost:8080", "trailing slash trimmed");

    set("APP_URL", "http://localhost:8080///");
    assert.equal(publicAppUrl(), "http://localhost:8080", "multiple trailing slashes trimmed");

    set("PUBLIC_APP_URL", "https://staging.example/");
    assert.equal(publicAppUrl(), "https://staging.example", "PUBLIC_APP_URL wins over APP_URL");
  });
});

test("resendApiKey / billingFromEmail: trim and provide deterministic defaults", () => {
  // `sendVerificationEmail` falls back to a console log when resendApiKey()
  // is null — pinning the null-on-whitespace behaviour ensures dev never
  // tries to POST to api.resend.com with a placeholder bearer token, which
  // would 401 and surface as a confusing "email_send_failed" to the user.
  withEnv(["RESEND_API_KEY", "BILLING_FROM_EMAIL"], (set) => {
    set("RESEND_API_KEY", undefined);
    set("BILLING_FROM_EMAIL", undefined);
    assert.equal(resendApiKey(), null);
    assert.equal(billingFromEmail(), "billing@safetptt.com", "default From: address");

    set("RESEND_API_KEY", "   ");
    assert.equal(resendApiKey(), null, "whitespace → null (skip live email)");

    set("RESEND_API_KEY", "  re_test_123  ");
    set("BILLING_FROM_EMAIL", "  noreply@example.com  ");
    assert.equal(resendApiKey(), "re_test_123");
    assert.equal(billingFromEmail(), "noreply@example.com");

    set("BILLING_FROM_EMAIL", "   ");
    assert.equal(
      billingFromEmail(),
      "billing@safetptt.com",
      "whitespace-only From: falls back to default — never sends with blank header",
    );
  });
});
