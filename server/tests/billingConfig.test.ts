/**
 * Tests for the env-driven helpers in `server/src/billing/config.ts`.
 *
 * These getters are how the billing module decides whether Stripe is
 * configured at all (`billingEnabled`), where to redirect after Stripe
 * Checkout (`publicAppUrl`), and which Stripe price ID to bill against per
 * plan tier (`priceIdForTier`). They are pure env reads, but they have two
 * subtle behaviors worth pinning:
 *
 *   1. They `.trim()` the env value, so a stray newline / trailing space in a
 *      Railway env var doesn't poison `Stripe.subscriptions.create({ price })`.
 *   2. `publicAppUrl` falls back from `PUBLIC_APP_URL` → `APP_URL` →
 *      production default, and strips trailing slashes — without this, a
 *      Checkout `success_url` ends up double-slashed and Stripe rejects it
 *      with a validation error at runtime.
 *
 * Each test snapshots and restores the relevant env vars so the suite is
 * deterministic regardless of the ambient process environment.
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

/** Snapshot/restore helper — undefined means "delete the var, don't set ''". */
function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k]!;
    }
  }
  try {
    return body();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev[k]!;
      }
    }
  }
}

test("billingEnabled: true only when STRIPE_SECRET_KEY is non-blank", () => {
  // The router checks `billingEnabled()` before letting the admin reach the
  // Stripe-backed Checkout / Portal handlers. If this ever returned `true`
  // for an unset key, the request would crash with a Stripe SDK error
  // ("apiKey is required") — which 500s in front of the customer instead of
  // returning the controlled 503 `billing_not_configured` signal.
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(billingEnabled(), false);
  });
  withEnv({ STRIPE_SECRET_KEY: "   " }, () => {
    assert.equal(billingEnabled(), false, "whitespace-only value must not enable billing");
  });
  withEnv({ STRIPE_SECRET_KEY: "sk_test_123" }, () => {
    assert.equal(billingEnabled(), true);
  });
});

test("stripeSecretKey: trims surrounding whitespace and treats blanks as null", () => {
  // A trailing newline pasted into Railway's env var UI is the most common
  // failure mode here. The Stripe SDK will compare the trimmed key against
  // its expected format and reject it with an opaque error if we leave the
  // newline in. Pin the trim and the null-on-blank.
  withEnv({ STRIPE_SECRET_KEY: "  sk_test_42\n" }, () => {
    assert.equal(stripeSecretKey(), "sk_test_42");
  });
  withEnv({ STRIPE_SECRET_KEY: "" }, () => {
    assert.equal(stripeSecretKey(), null);
  });
  withEnv({ STRIPE_SECRET_KEY: undefined }, () => {
    assert.equal(stripeSecretKey(), null);
  });
});

test("stripeWebhookSecret/stripePriceBasic/stripePricePro/stripePriceLogsUnlimited/resendApiKey: same trim + null contract", () => {
  // Sibling getters share the same trim+null contract. Group them in one
  // test so a future regression that adds a sixth getter without the trim
  // is easy to spot — and so a refactor that pulls the shared logic into a
  // helper still keeps the same observable behavior.
  withEnv({ STRIPE_WEBHOOK_SECRET: " whsec_42 " }, () => {
    assert.equal(stripeWebhookSecret(), "whsec_42");
  });
  withEnv({ STRIPE_PRICE_BASIC: "price_basic_id\n" }, () => {
    assert.equal(stripePriceBasic(), "price_basic_id");
  });
  withEnv({ STRIPE_PRICE_PRO: "price_pro_id" }, () => {
    assert.equal(stripePricePro(), "price_pro_id");
  });
  withEnv({ STRIPE_PRICE_LOGS_UNLIMITED: "price_logs_id" }, () => {
    assert.equal(stripePriceLogsUnlimited(), "price_logs_id");
  });
  withEnv({ RESEND_API_KEY: "  re_42  " }, () => {
    assert.equal(resendApiKey(), "re_42");
  });
  withEnv(
    {
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PRICE_BASIC: "",
      STRIPE_PRICE_PRO: "  ",
      STRIPE_PRICE_LOGS_UNLIMITED: undefined,
      RESEND_API_KEY: "",
    },
    () => {
      assert.equal(stripeWebhookSecret(), null);
      assert.equal(stripePriceBasic(), null);
      assert.equal(stripePricePro(), null);
      assert.equal(stripePriceLogsUnlimited(), null);
      assert.equal(resendApiKey(), null);
    },
  );
});

test("publicAppUrl: prefers PUBLIC_APP_URL over APP_URL, strips trailing slashes", () => {
  // Stripe's hosted Checkout sticks the success_url and cancel_url through a
  // strict validator — `https://safet-ptt.com//admin?billing=success` fails
  // immediately with `success_url is invalid`. The trailing-slash strip
  // here is the contract that prevents that.
  withEnv(
    { PUBLIC_APP_URL: "https://app.example.com/", APP_URL: "https://other.example/" },
    () => {
      assert.equal(publicAppUrl(), "https://app.example.com");
    },
  );
});

test("publicAppUrl: falls back to APP_URL when PUBLIC_APP_URL is unset", () => {
  // Older deployments only set `APP_URL`. A regression that dropped the
  // fallback would push every Checkout redirect to the production
  // `safet-ptt.com` even on dev/staging environments — sending users to the
  // wrong tenant after a successful payment.
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: "https://staging.example/" }, () => {
    assert.equal(publicAppUrl(), "https://staging.example");
  });
});

test("publicAppUrl: defaults to production when neither var is set", () => {
  // The ultimate fallback. If a developer ever loses both env vars
  // (cleanest dev environment), Checkout still works because the redirect
  // lands on the live marketing site.
  withEnv({ PUBLIC_APP_URL: undefined, APP_URL: undefined }, () => {
    assert.equal(publicAppUrl(), "https://safet-ptt.com");
  });
});

test("publicAppUrl: blank-string env vars fall through to the next fallback", () => {
  // `?.trim() || …` means an empty PUBLIC_APP_URL must NOT short-circuit;
  // we have to fall through to APP_URL. Pin this so a future refactor
  // doesn't accidentally take the empty value as authoritative.
  withEnv({ PUBLIC_APP_URL: "   ", APP_URL: "https://app.example/" }, () => {
    assert.equal(publicAppUrl(), "https://app.example");
  });
});

test("publicAppUrl: strips multiple trailing slashes", () => {
  // The replace pattern is `/\/+$/`, so even a paste of
  // `https://app.example.com///` collapses to a clean URL. Catches a regex
  // tweak that swaps `+` for `?`.
  withEnv({ PUBLIC_APP_URL: "https://app.example.com////" }, () => {
    assert.equal(publicAppUrl(), "https://app.example.com");
  });
});

test("priceIdForTier: 'pro' resolves to STRIPE_PRICE_PRO, anything else to STRIPE_PRICE_BASIC", () => {
  // The plan-change path passes user input straight into this resolver. If
  // 'pro' ever stopped routing to the pro price, an admin paying the pro
  // tier would silently be subscribed to the basic-tier price — a billing
  // bug we'd only catch by reading Stripe invoices.
  withEnv(
    { STRIPE_PRICE_BASIC: "price_basic", STRIPE_PRICE_PRO: "price_pro" },
    () => {
      assert.equal(priceIdForTier("pro"), "price_pro");
      assert.equal(priceIdForTier("basic"), "price_basic");
    },
  );
});

test("priceIdForTier: returns null when the matching env var is unset (Stripe call short-circuits)", () => {
  // `createCheckoutSession` checks `!basePrice` and bails early. The unit
  // contract here is "missing config => null", which lets the upstream
  // route surface 'checkout_failed' instead of crashing the Stripe SDK.
  withEnv({ STRIPE_PRICE_BASIC: undefined, STRIPE_PRICE_PRO: undefined }, () => {
    assert.equal(priceIdForTier("basic"), null);
    assert.equal(priceIdForTier("pro"), null);
  });
});

test("billingFromEmail: defaults to billing@safetptt.com when BILLING_FROM_EMAIL is unset", () => {
  // Resend rejects sends from unverified senders — the default has to match
  // the verified domain. A regression that changed the default to
  // `noreply@example.com` would block all signup verification emails on
  // production.
  withEnv({ BILLING_FROM_EMAIL: undefined }, () => {
    assert.equal(billingFromEmail(), "billing@safetptt.com");
  });
  withEnv({ BILLING_FROM_EMAIL: "" }, () => {
    assert.equal(billingFromEmail(), "billing@safetptt.com");
  });
  withEnv({ BILLING_FROM_EMAIL: "  hello@example.com  " }, () => {
    assert.equal(billingFromEmail(), "hello@example.com");
  });
});
