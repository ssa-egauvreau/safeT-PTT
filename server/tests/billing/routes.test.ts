/**
 * HTTP-level coverage for `server/src/billing/routes.ts`.
 *
 * The billing router exposes two surfaces with very different blast radius:
 *
 *  1. **Public self-service signup** (`POST /v1/signup/verify-email` and
 *     `POST /v1/signup`). These are unauthenticated by design — anyone on
 *     the internet can hit them. The only thing standing between a malformed
 *     / abusive request and the database is the input-validation block at
 *     the top of each handler:
 *       - `requestSignupVerification` returns `invalid_email` for anything
 *         that doesn't trim to a string containing `@`. If that check
 *         regresses, every garbage payload becomes a DB write + Resend send.
 *       - `completeSignup` returns `terms_required` when `accept_terms` is
 *         not the boolean `true`. Skipping this check lets a tenant slip
 *         through signup without ever accepting the Terms of Service, which
 *         is the contractual basis for billing.
 *
 *  2. **Authenticated admin billing actions** (`/v1/billing/status`,
 *     `/v1/billing/checkout`, `/v1/billing/portal`, `/v1/billing/plan`).
 *     PR #273 fixed the router mount order so these endpoints run through
 *     the same session-cache / disabled-account middleware as every other
 *     authenticated route. The `requireAuth` + `requireAdmin` middleware
 *     this file exercises is the *innermost* gate — if any one of the four
 *     endpoints loses either gate in a refactor, a radio handset, a
 *     dispatcher session, or a platform owner (no `agencyId`) could mutate
 *     a tenant's billing state. Pin all four routes explicitly.
 *
 *  3. **`PATCH /v1/billing/plan` billing-not-configured guard**. The plan
 *     endpoint is the only one that calls `billingEnabled()` *after* the
 *     auth check and before talking to Stripe. With `STRIPE_SECRET_KEY`
 *     unset, the response must be `503 billing_not_configured` (not a 500
 *     or, worse, a write that drifts the agency's row out of sync with
 *     Stripe). The other three endpoints intentionally don't run that
 *     guard — they degrade through specific Stripe-failure error codes
 *     instead — so the test below pins this asymmetry deliberately.
 *
 * Test isolation: each test mounts only the billing router under `/v1`,
 * runs `authenticate` middleware in front of it, and never enables the
 * full apiRoutes session-cache middleware. That keeps the router under
 * test isolated from the cross-router auth-gate ordering already covered
 * in `apiRoutes.test.ts` ("superseded admin token is rejected before
 * billing handlers").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createBillingRouter } from "../../src/billing/routes.js";
import { authenticate, signToken, type AuthUser } from "../../src/auth.js";

/**
 * Stand up an Express app with only the billing router mounted at `/v1`.
 * `authenticate` populates `req.authUser` from the bearer token (or leaves it
 * undefined for anonymous requests), exactly mirroring the production wiring.
 */
async function bootBillingRouter(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(authenticate);
  app.use("/v1", createBillingRouter());

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function tokenFor(overrides: Partial<AuthUser>): string {
  const user: AuthUser = {
    id: 1,
    username: "test-user",
    displayName: "Test User",
    role: "admin",
    unitId: null,
    agencyId: 42,
    agencyName: "Test Agency",
    gen: 0,
    ...overrides,
  };
  return signToken(user);
}

// ---------------------------------------------------------------------------
// Public signup: POST /v1/signup/verify-email
// ---------------------------------------------------------------------------

test("POST /v1/signup/verify-email: missing email field → 400 invalid_email", async () => {
  // The handler reads `req.body?.email ?? ""`, which trims to "" and fails
  // the `!normalized || !normalized.includes("@")` guard in
  // `requestSignupVerification`. This check runs BEFORE any DB call, so we
  // can assert it without provisioning Postgres.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_email");
  } finally {
    await close();
  }
});

test("POST /v1/signup/verify-email: non-email string → 400 invalid_email", async () => {
  // A string without `@` is the canonical "this is not an email" case.
  // Catches a regression where the validation block is loosened or removed
  // and the request would otherwise reach Resend with garbage input.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_email");
  } finally {
    await close();
  }
});

test("POST /v1/signup/verify-email: whitespace-only email → 400 invalid_email", async () => {
  // The handler trims the input before the `@` check, so a string that
  // looks present in the JSON body but is empty after trim must still be
  // rejected. Prevents a "looks set, actually empty" bug from sailing past.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_email");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Public signup: POST /v1/signup
// ---------------------------------------------------------------------------

test("POST /v1/signup: accept_terms !== true → 400 terms_required", async () => {
  // `completeSignup` checks `!input.acceptTerms` FIRST, before touching the
  // DB. Explicit `false` is the most common bad payload (the SPA shouldn't
  // submit it that way, but defence-in-depth requires the server to refuse).
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_display_name: "Admin",
        admin_password: "hunter2-hunter2",
        email: "admin@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        accept_terms: false,
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: missing accept_terms field → 400 terms_required", async () => {
  // The route normalises with `body.accept_terms === true`. A missing key
  // must NOT default to true — it has to fail closed so a stray client
  // can't dodge the ToS gate by simply omitting the field.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter2-hunter2",
        email: "admin@example.com",
        verification_code: "123456",
        plan_tier: "basic",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: truthy non-boolean accept_terms (the string 'true') → 400 terms_required", async () => {
  // The route uses strict `=== true`, so a string "true" must be refused.
  // Locks in the "fail closed on coercion" contract — a future refactor
  // that swaps strict equality for a truthy check would silently let
  // every JSON value through.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter2-hunter2",
        email: "admin@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        accept_terms: "true",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Admin billing endpoints: unauthenticated → 401
// ---------------------------------------------------------------------------

const ADMIN_BILLING_ENDPOINTS: Array<{ method: "GET" | "POST" | "PATCH"; path: string }> = [
  { method: "GET", path: "/v1/billing/status" },
  { method: "POST", path: "/v1/billing/checkout" },
  { method: "POST", path: "/v1/billing/portal" },
  { method: "PATCH", path: "/v1/billing/plan" },
];

for (const ep of ADMIN_BILLING_ENDPOINTS) {
  test(`${ep.method} ${ep.path}: no bearer token → 401 unauthorized`, async () => {
    // `requireAuth` (the first middleware on every admin billing route)
    // must answer 401 when no `req.authUser` is present. A regression that
    // drops this middleware would let an anonymous caller probe billing
    // state or — for POST/PATCH — try to mutate a tenant's plan.
    const { baseUrl, close } = await bootBillingRouter();
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: ep.method === "GET" ? undefined : { "content-type": "application/json" },
        body: ep.method === "GET" ? undefined : JSON.stringify({}),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "unauthorized");
    } finally {
      await close();
    }
  });
}

// ---------------------------------------------------------------------------
// Admin billing endpoints: non-admin roles → 403
// ---------------------------------------------------------------------------

const NON_ADMIN_ROLES: Array<{ label: string; overrides: Partial<AuthUser> }> = [
  // A handset bearer token MUST never reach billing — radios can't manage
  // money. Same for dispatchers: they sit on the console but don't pay bills.
  { label: "radio", overrides: { role: "radio" } },
  { label: "dispatcher", overrides: { role: "dispatcher" } },
  // Platform owners administer the platform, not individual tenants — and
  // they have no `agencyId`, so even an "admin" role with `agencyId: null`
  // must be refused by `requireAdmin`.
  {
    label: "owner-no-agency",
    overrides: { role: "owner", agencyId: null, agencyName: null },
  },
  {
    label: "admin-without-agencyId",
    overrides: { role: "admin", agencyId: null, agencyName: null },
  },
];

for (const ep of ADMIN_BILLING_ENDPOINTS) {
  for (const variant of NON_ADMIN_ROLES) {
    test(`${ep.method} ${ep.path}: ${variant.label} token → 403 forbidden`, async () => {
      // `requireAdmin` enforces two things: role === "admin" AND agencyId
      // is set. Both must reject — the test matrix above keeps all four
      // failure modes locked down across all four billing endpoints.
      const { baseUrl, close } = await bootBillingRouter();
      try {
        const token = tokenFor(variant.overrides);
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: ep.method === "GET" ? undefined : JSON.stringify({}),
        });
        assert.equal(res.status, 403);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "forbidden");
      } finally {
        await close();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// PATCH /v1/billing/plan: billing-not-configured guard
// ---------------------------------------------------------------------------

test("PATCH /v1/billing/plan: STRIPE_SECRET_KEY unset → 503 billing_not_configured", async () => {
  // After the auth gate passes, the plan handler is the only one that
  // explicitly refuses to run when Stripe isn't configured (because writing
  // to the local agency row without updating Stripe drifts the two stores
  // out of sync). Pin the 503 contract so a future refactor can't quietly
  // drop this guard.
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const token = tokenFor({ role: "admin", agencyId: 42 });
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan_tier: "basic", logs_unlimited: false }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "billing_not_configured");
  } finally {
    await close();
    if (prevSecret !== undefined) {
      process.env.STRIPE_SECRET_KEY = prevSecret;
    }
  }
});
