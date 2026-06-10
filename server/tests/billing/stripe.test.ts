/**
 * Tests for `server/src/billing/stripe.ts` — the Stripe-client wrapper.
 *
 * Every call site (`signup.ts`, `subscription.ts`, `webhooks.ts`,
 * `routes.ts`) checks for `null` returns to decide whether to short-
 * circuit with a `billing_not_configured` / `error: <stripe>_failed`
 * response. A regression that threw instead of returning `null` would
 * crash the route handlers with an opaque 500 in any environment that
 * isn't fully configured for Stripe — which includes the Cloud Agent
 * VM, local dev, and the e2e CI lane.
 *
 * Properties pinned by this file (the no-Stripe-credentials path):
 *
 *  1. **`getStripe()`** returns `null` when `STRIPE_SECRET_KEY` is unset
 *     or whitespace-only. No throw, no cached client.
 *
 *  2. **`createStripeCustomer`**, **`createCheckoutSession`**,
 *     **`createBillingPortalSession`**, **`syncSubscriptionQuantity`**,
 *     **`updateSubscriptionPlan`** all resolve to `null` when billing
 *     is disabled. This is the contract every caller relies on to
 *     degrade gracefully — never throw, never leak a Stripe SDK error
 *     from a missing-credentials path.
 *
 *  3. **`createCheckoutSession`** also returns `null` when the
 *     requested plan tier has no `STRIPE_PRICE_*` env var configured.
 *     This is a separate guard from billingEnabled() and must not
 *     throw — a misconfigured tier should land in the route handler
 *     as a 400 `checkout_failed`, never a 500.
 *
 * The fully-configured (live Stripe) paths are intentionally NOT
 * covered here; they require a Stripe test secret and round-trip
 * to api.stripe.com. The billing routes test (`billing/routes.test.ts`)
 * and the webhook test exercise the configured paths through the
 * shared `getStripe()` indirection.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  createBillingPortalSession,
  createCheckoutSession,
  createStripeCustomer,
  getStripe,
  syncSubscriptionQuantity,
  updateSubscriptionPlan,
} from "../../src/billing/stripe.js";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LOGS_UNLIMITED",
  "PUBLIC_APP_URL",
  "APP_URL",
] as const;

type EnvSnapshot = Map<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const out: EnvSnapshot = new Map();
  for (const k of ENV_KEYS) out.set(k, process.env[k]);
  return out;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let snap: EnvSnapshot;

beforeEach(() => {
  snap = snapshotEnv();
});

afterEach(() => {
  restoreEnv(snap);
});

// ---------------------------------------------------------------------------
// getStripe()
// ---------------------------------------------------------------------------

test("getStripe: returns null when STRIPE_SECRET_KEY is unset", () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(getStripe(), null);
});

test("getStripe: returns null when STRIPE_SECRET_KEY is whitespace-only", () => {
  // Whitespace-only secret must NOT initialise a Stripe client. The cached
  // client would otherwise outlive the request and every later call would
  // 401 with no actionable error.
  process.env.STRIPE_SECRET_KEY = "   \t\n";
  assert.equal(getStripe(), null);
});

test("getStripe: returns null when STRIPE_SECRET_KEY is the empty string", () => {
  process.env.STRIPE_SECRET_KEY = "";
  assert.equal(getStripe(), null);
});

// ---------------------------------------------------------------------------
// Async wrapper short-circuits — none of these may THROW on a missing key
// ---------------------------------------------------------------------------

test("createStripeCustomer: resolves null when billing is disabled (no throw)", async () => {
  // `signup.ts` awaits this and persists the returned customer id when
  // present. A throw here would crash the signup flow at the Cloud Agent
  // boundary; the contract is that this is a silent no-op.
  delete process.env.STRIPE_SECRET_KEY;
  const result = await createStripeCustomer({
    email: "a@example.com",
    name: "Test Agency",
    agencyId: 7,
  });
  assert.equal(result, null);
});

test("createCheckoutSession: resolves null when billing is disabled (no throw)", async () => {
  // The HTTP handler interprets `null` → 400 `checkout_failed`. Throwing
  // would 500 the response instead, breaking the admin UI's retry logic.
  delete process.env.STRIPE_SECRET_KEY;
  const result = await createCheckoutSession({
    customerId: "cus_anything",
    agencyId: 7,
    planTier: "basic",
    seatQuantity: 1,
    logsUnlimited: false,
  });
  assert.equal(result, null);
});

test("createCheckoutSession: resolves null when billing IS enabled but the plan tier has no price env var", async () => {
  // This is a separate failure mode from "no Stripe key" — billing is
  // configured, but the operator forgot to set STRIPE_PRICE_BASIC /
  // STRIPE_PRICE_PRO. The wrapper must NOT attempt to build a Stripe
  // line-item with `price: undefined` (Stripe SDK would throw a confusing
  // schema error) and must NOT instantiate a Stripe API call. Returning
  // null lets the route surface a clean 400 `checkout_failed`.
  process.env.STRIPE_SECRET_KEY = "sk_test_for_priceless_tier";
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_PRO;

  const result = await createCheckoutSession({
    customerId: "cus_x",
    agencyId: 7,
    planTier: "basic",
    seatQuantity: 1,
    logsUnlimited: false,
  });
  assert.equal(result, null);
});

test("createBillingPortalSession: resolves null when billing is disabled (no throw)", async () => {
  // The HTTP handler maps `null` → 400 `portal_failed`. A throw would
  // 500 the response and surface in the admin BillingPanel as a generic
  // "Network error" with no context.
  delete process.env.STRIPE_SECRET_KEY;
  const result = await createBillingPortalSession("cus_anything");
  assert.equal(result, null);
});

test("syncSubscriptionQuantity: resolves null when billing is disabled (no throw)", async () => {
  // Called from `syncSeatsForAgency` whenever a user is enabled/disabled
  // in the admin console. A throw here would crash the user-management
  // surface in every dev environment without Stripe.
  delete process.env.STRIPE_SECRET_KEY;
  const result = await syncSubscriptionQuantity("sub_anything", 5);
  assert.equal(result, null);
});

test("updateSubscriptionPlan: resolves null when billing is disabled (no throw)", async () => {
  // Called from `changePlan` on PATCH /v1/billing/plan. The plan-route
  // handler ALREADY 503s on `!billingEnabled()` before reaching this
  // path, but defence-in-depth: a regression that moves the route guard
  // would otherwise crash here.
  delete process.env.STRIPE_SECRET_KEY;
  const result = await updateSubscriptionPlan({
    subscriptionId: "sub_x",
    planTier: "pro",
    logsUnlimited: true,
    seatQuantity: 1,
  });
  assert.equal(result, null);
});

test("updateSubscriptionPlan: resolves null when billing IS enabled but plan tier has no price env var", async () => {
  // Same separation as createCheckoutSession — even with a Stripe key,
  // the wrapper must refuse to talk to Stripe when the target plan
  // tier's price id is unset. Otherwise `Stripe.subscriptions.update`
  // would either throw or write an `undefined` price into the items
  // array (which would silently delete the original price item).
  process.env.STRIPE_SECRET_KEY = "sk_test_for_priceless_update";
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_PRO;

  const result = await updateSubscriptionPlan({
    subscriptionId: "sub_x",
    planTier: "pro",
    logsUnlimited: false,
    seatQuantity: 1,
  });
  assert.equal(result, null);
});
