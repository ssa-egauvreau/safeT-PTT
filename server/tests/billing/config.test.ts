/**
 * Tests for `server/src/billing/config.ts`.
 *
 * Every billing call site keys off these env-readers — a regression here
 * silently breaks Stripe initialisation, checkout URLs, or trial enforcement
 * across the entire self-service signup flow added in 4e7ffa6.
 *
 * Properties pinned by this file:
 *
 *  1. **`billingEnabled`** is a strict, trimmed truthiness check on
 *     `STRIPE_SECRET_KEY` — empty / whitespace-only / unset must all return
 *     `false` so `getStripe()` never instantiates a Stripe client with a bad
 *     credential and the billing routes degrade to `billing_not_configured`.
 *
 *  2. **`stripeSecretKey` / `stripeWebhookSecret` / `stripePriceBasic` /
 *     `stripePricePro` / `stripePriceLogsUnlimited`** all return `null` when
 *     missing or whitespace-only, and trim their value otherwise. A leading
 *     newline copy-pasted into Railway is the most common operator footgun;
 *     these helpers must not return it verbatim.
 *
 *  3. **`publicAppUrl`** falls back to the production hostname when neither
 *     `PUBLIC_APP_URL` nor `APP_URL` is set, prefers `PUBLIC_APP_URL` over
 *     `APP_URL`, and strips trailing slashes so checkout `success_url` /
 *     `cancel_url` don't get a double-slash and 404 from Vite preview.
 *
 *  4. **`priceIdForTier`** routes only the literal string `"pro"` to the
 *     pro price; every other input (including casing variants) maps to the
 *     basic price. This is the only thing keeping a typo'd plan tier from
 *     silently subscribing a tenant to the wrong tier.
 *
 *  5. **`billingFromEmail`** has a hard-coded fallback so verification email
 *     send never throws on a missing env var, but env-supplied values win.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

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

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

const config = await import("../../src/billing/config.js");

// ---------------------------------------------------------------------------
// billingEnabled
// ---------------------------------------------------------------------------

test("billingEnabled: false when STRIPE_SECRET_KEY is unset", () => {
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(config.billingEnabled(), false);
  });
});

test("billingEnabled: false when STRIPE_SECRET_KEY is empty or whitespace", () => {
  withEnv({ STRIPE_SECRET_KEY: "" }, () => assert.equal(config.billingEnabled(), false));
  withEnv({ STRIPE_SECRET_KEY: "   " }, () => assert.equal(config.billingEnabled(), false));
  withEnv({ STRIPE_SECRET_KEY: "\n\t  " }, () => assert.equal(config.billingEnabled(), false));
});

test("billingEnabled: true when STRIPE_SECRET_KEY has any non-whitespace value", () => {
  withEnv({ STRIPE_SECRET_KEY: "sk_test_123" }, () => assert.equal(config.billingEnabled(), true));
  withEnv({ STRIPE_SECRET_KEY: "  sk_test_123  " }, () =>
    assert.equal(config.billingEnabled(), true),
  );
});

// ---------------------------------------------------------------------------
// stripeSecretKey / stripeWebhookSecret / stripePrice*
// ---------------------------------------------------------------------------

const STRING_GETTERS: Array<[keyof typeof config, string]> = [
  ["stripeSecretKey", "STRIPE_SECRET_KEY"],
  ["stripeWebhookSecret", "STRIPE_WEBHOOK_SECRET"],
  ["stripePriceBasic", "STRIPE_PRICE_BASIC"],
  ["stripePricePro", "STRIPE_PRICE_PRO"],
  ["stripePriceLogsUnlimited", "STRIPE_PRICE_LOGS_UNLIMITED"],
  ["resendApiKey", "RESEND_API_KEY"],
];

for (const [getter, env] of STRING_GETTERS) {
  test(`${getter}: null when ${env} is unset, empty, or whitespace`, () => {
    withEnv({ [env]: undefined }, () => assert.equal((config[getter] as () => string | null)(), null));
    withEnv({ [env]: "" }, () => assert.equal((config[getter] as () => string | null)(), null));
    withEnv({ [env]: "   " }, () => assert.equal((config[getter] as () => string | null)(), null));
  });

  test(`${getter}: trims whitespace and returns ${env}`, () => {
    withEnv({ [env]: "  hello-world  " }, () =>
      assert.equal((config[getter] as () => string | null)(), "hello-world"),
    );
  });
}

// ---------------------------------------------------------------------------
// publicAppUrl
// ---------------------------------------------------------------------------

test("publicAppUrl: defaults to safet-ptt.com when neither PUBLIC_APP_URL nor APP_URL is set", () => {
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: undefined }, () => {
    assert.equal(config.publicAppUrl(), "https://safet-ptt.com");
  });
});

test("publicAppUrl: strips a single trailing slash", () => {
  withEnv({ PUBLIC_APP_URL: "https://app.example.com/" }, () => {
    assert.equal(config.publicAppUrl(), "https://app.example.com");
  });
});

test("publicAppUrl: strips repeated trailing slashes", () => {
  withEnv({ PUBLIC_APP_URL: "https://app.example.com////" }, () => {
    assert.equal(config.publicAppUrl(), "https://app.example.com");
  });
});

test("publicAppUrl: PUBLIC_APP_URL takes precedence over APP_URL", () => {
  withEnv({ PUBLIC_APP_URL: "https://primary.example.com", APP_URL: "https://fallback.example.com" }, () => {
    assert.equal(config.publicAppUrl(), "https://primary.example.com");
  });
});

test("publicAppUrl: falls back to APP_URL when PUBLIC_APP_URL is unset", () => {
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: "https://legacy.example.com/" }, () => {
    assert.equal(config.publicAppUrl(), "https://legacy.example.com");
  });
});

test("publicAppUrl: whitespace-only PUBLIC_APP_URL falls back to APP_URL or default", () => {
  withEnv({ PUBLIC_APP_URL: "   ", APP_URL: "https://legacy.example.com" }, () => {
    assert.equal(config.publicAppUrl(), "https://legacy.example.com");
  });
  withEnv({ PUBLIC_APP_URL: "   ", APP_URL: undefined }, () => {
    assert.equal(config.publicAppUrl(), "https://safet-ptt.com");
  });
});

// ---------------------------------------------------------------------------
// priceIdForTier
// ---------------------------------------------------------------------------

test("priceIdForTier: 'pro' returns STRIPE_PRICE_PRO", () => {
  withEnv({ STRIPE_PRICE_PRO: "price_pro_x", STRIPE_PRICE_BASIC: "price_basic_x" }, () => {
    assert.equal(config.priceIdForTier("pro"), "price_pro_x");
  });
});

test("priceIdForTier: 'basic' returns STRIPE_PRICE_BASIC", () => {
  withEnv({ STRIPE_PRICE_PRO: "price_pro_x", STRIPE_PRICE_BASIC: "price_basic_x" }, () => {
    assert.equal(config.priceIdForTier("basic"), "price_basic_x");
  });
});

test("priceIdForTier: returns null when the matching env var is unset", () => {
  withEnv({ STRIPE_PRICE_PRO: undefined, STRIPE_PRICE_BASIC: "price_basic_x" }, () => {
    assert.equal(config.priceIdForTier("pro"), null);
    assert.equal(config.priceIdForTier("basic"), "price_basic_x");
  });
});

// ---------------------------------------------------------------------------
// billingFromEmail
// ---------------------------------------------------------------------------

test("billingFromEmail: defaults to billing@safetptt.com when unset", () => {
  withEnv({ BILLING_FROM_EMAIL: undefined }, () => {
    assert.equal(config.billingFromEmail(), "billing@safetptt.com");
  });
});

test("billingFromEmail: trims and returns env value when set", () => {
  withEnv({ BILLING_FROM_EMAIL: "  noreply@example.com  " }, () => {
    assert.equal(config.billingFromEmail(), "noreply@example.com");
  });
});

test("billingFromEmail: empty / whitespace env falls back to default", () => {
  withEnv({ BILLING_FROM_EMAIL: "" }, () =>
    assert.equal(config.billingFromEmail(), "billing@safetptt.com"),
  );
  withEnv({ BILLING_FROM_EMAIL: "   " }, () =>
    assert.equal(config.billingFromEmail(), "billing@safetptt.com"),
  );
});
