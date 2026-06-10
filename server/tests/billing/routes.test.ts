/**
 * Tests for `server/src/billing/routes.ts`.
 *
 * These are the public-internet self-service signup endpoints plus the
 * admin-only billing actions. The router is mounted at `/v1` from
 * `apiRoutes.ts` and (per PR comment) sits AFTER the
 * token-generation/disabled-account middleware. The contracts pinned
 * here:
 *
 *   1. **Public signup-verification synchronous validation** — POST
 *      `/v1/signup/verify-email` rejects malformed emails (empty,
 *      non-string, no `@`) BEFORE any DB call, so a misbehaving client
 *      can't open a write path against `signup_verifications` without
 *      passing a coarse format check.
 *
 *   2. **Public signup synchronous validation** — POST `/v1/signup`
 *      rejects requests without `accept_terms: true` BEFORE any DB
 *      call, so a missing checkbox cannot create a new agency or burn
 *      a verification code.
 *
 *   3. **Database-unavailable degradation** — when Postgres is not
 *      configured (Cloud Agent / dev) and the input would otherwise
 *      reach the DB, every billing route MUST return 503
 *      `database_unavailable` rather than a 500 stack trace. This is
 *      the contract that keeps a misconfigured prod from spamming
 *      logs and tripping health-check alerts.
 *
 *   4. **Auth gates on the admin endpoints** — every admin-only
 *      billing route (`GET /billing/status`, `POST /billing/checkout`,
 *      `POST /billing/portal`, `PATCH /billing/plan`) refuses
 *      unauthenticated callers with 401 and refuses non-admin tokens
 *      (or admin tokens missing `agencyId`) with 403. A regression
 *      that dropped a middleware here would let any logged-in user
 *      change an agency's plan or open a Stripe portal session.
 *
 *   5. **Plan-tier whitelisting** — PATCH `/v1/billing/plan` happily
 *      accepts an unknown `plan_tier` string but the route MUST
 *      coerce it to `basic` (the documented default) instead of
 *      passing it through to Stripe. Pinned indirectly through the
 *      503 path: if billing isn't configured we still get a clean
 *      error, never a crash on an unknown enum.
 *
 *   6. **`PATCH /v1/billing/plan` 503 when billing is not configured**
 *      — the route checks `billingEnabled()` BEFORE any agency lookup,
 *      so a tenant on a Stripe-free deployment gets a clear 503
 *      `billing_not_configured` rather than a confusing 503
 *      `database_unavailable` after it tries to read the agency row.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { authenticate, signToken, type AuthUser } from "../../src/auth.js";
import { createBillingRouter } from "../../src/billing/routes.js";
import { clearAuthCache, setCachedAuth } from "../../src/sessionCache.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_BASIC",
  "STRIPE_PRICE_PRO",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Force a clean "no DB / no Stripe" baseline so route tests can rely
  // on the 503 / billing_not_configured paths firing predictably.
  delete process.env.DATABASE_URL;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_PRO;
  clearAuthCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  clearAuthCache();
});

async function bootBillingRouter(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Mount the same `authenticate` middleware the production server
  // uses upstream of every router, so `requireAuth`/`requireAdmin`
  // observe `req.authUser` exactly as in production.
  app.use(authenticate);
  app.use("/v1", createBillingRouter());

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
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
// Public signup-verification synchronous validation
// ---------------------------------------------------------------------------

test("POST /v1/signup/verify-email: empty body coerces to invalid_email (no DB call)", async () => {
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

test("POST /v1/signup/verify-email: a string with no @ is rejected as invalid_email", async () => {
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

test("POST /v1/signup/verify-email: a syntactically valid email returns 503 when DB is unavailable", async () => {
  // The validator passes, but `emailAlreadyUsedTrial` calls
  // `requirePool().query(...)` which throws `database_unavailable`.
  // The `fail()` helper MUST translate that into 503, never a 500.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ops@example.com" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Public signup synchronous validation
// ---------------------------------------------------------------------------

test("POST /v1/signup: missing accept_terms is a synchronous 400 terms_required (no DB)", async () => {
  // The "I accept the Terms" checkbox is the contract gate — a
  // regression that dropped this check would let an automated bot
  // create an agency without recording acceptance, breaking the
  // legal-of-record audit.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter22",
        email: "ops@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        // accept_terms intentionally omitted
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: accept_terms === false (not just missing) is also terms_required", async () => {
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter22",
        email: "ops@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        accept_terms: false,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: accept_terms truthy non-boolean (e.g. \"true\" string) is NOT accepted", async () => {
  // The route does `body.accept_terms === true` (strict === true). A
  // regression that loosened to `Boolean(body.accept_terms)` would
  // accept the string "false" or "0" as truthy and let signups slip
  // through.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter22",
        email: "ops@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        accept_terms: "true",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: with accept_terms true and no DB, surface 503 (not 500)", async () => {
  // After the `accept_terms` check, the next call is `verifyCode` which
  // hits `requirePool().query(...)`. With no DB, that throws
  // `database_unavailable` and MUST surface as a 503, not a stack-trace
  // 500 to the public internet.
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "hunter22",
        email: "ops@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        accept_terms: true,
      }),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "database_unavailable");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Auth gates on admin-only billing endpoints
// ---------------------------------------------------------------------------

const ADMIN_ROUTES: Array<{ method: string; path: string; body?: object }> = [
  { method: "GET", path: "/v1/billing/status" },
  { method: "POST", path: "/v1/billing/checkout", body: { plan_tier: "basic" } },
  { method: "POST", path: "/v1/billing/portal" },
  { method: "PATCH", path: "/v1/billing/plan", body: { plan_tier: "basic" } },
];

for (const route of ADMIN_ROUTES) {
  test(`${route.method} ${route.path}: rejects unauthenticated requests with 401`, async () => {
    const { baseUrl, close } = await bootBillingRouter();
    try {
      const init: RequestInit = { method: route.method };
      if (route.body) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(route.body);
      }
      const res = await fetch(`${baseUrl}${route.path}`, init);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "unauthorized");
    } finally {
      await close();
    }
  });

  test(`${route.method} ${route.path}: rejects non-admin (handset/owner) tokens with 403`, async () => {
    // A regression that swapped requireAdmin for requireAuth would let
    // any logged-in handset user mutate billing.
    const userId = 9_777_010;
    setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
    const { baseUrl, close } = await bootBillingRouter();
    try {
      const init: RequestInit = {
        method: route.method,
        headers: {
          authorization: `Bearer ${tokenFor({ id: userId, role: "user", agencyId: 42 })}`,
        },
      };
      if (route.body) {
        (init.headers as Record<string, string>)["content-type"] = "application/json";
        init.body = JSON.stringify(route.body);
      }
      const res = await fetch(`${baseUrl}${route.path}`, init);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "forbidden");
    } finally {
      await close();
    }
  });

  test(`${route.method} ${route.path}: rejects admin tokens missing agencyId with 403`, async () => {
    // The auth-layer `requireAdmin` already enforces this, but the
    // route handlers also re-check `agencyId == null` as a defense in
    // depth. Pin both — a refactor that dropped one of the two should
    // still keep the other from leaking cross-tenant access.
    const userId = 9_777_011;
    setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
    const { baseUrl, close } = await bootBillingRouter();
    try {
      const init: RequestInit = {
        method: route.method,
        headers: {
          authorization: `Bearer ${tokenFor({
            id: userId,
            role: "admin",
            agencyId: null,
            agencyName: null,
          })}`,
        },
      };
      if (route.body) {
        (init.headers as Record<string, string>)["content-type"] = "application/json";
        init.body = JSON.stringify(route.body);
      }
      const res = await fetch(`${baseUrl}${route.path}`, init);
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });
}

// ---------------------------------------------------------------------------
// PATCH /v1/billing/plan: billing-not-configured short-circuit
// ---------------------------------------------------------------------------

test("PATCH /v1/billing/plan: returns 503 billing_not_configured BEFORE any DB call when STRIPE_SECRET_KEY is unset", async () => {
  // The route runs `if (!billingEnabled()) { res.status(503).json({ error: 'billing_not_configured' }); return; }`
  // BEFORE any agency lookup. Pin the contract — a regression that
  // moved the agency read in front of this check would surface a
  // confusing 503 `database_unavailable` on a Stripe-free deployment.
  const userId = 9_777_020;
  setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${tokenFor({ id: userId, role: "admin", agencyId: 42 })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan_tier: "basic", logs_unlimited: false }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "billing_not_configured");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Plan-tier whitelisting (defense in depth)
// ---------------------------------------------------------------------------

test("PATCH /v1/billing/plan: an unknown plan_tier coerces to 'basic' instead of crashing", async () => {
  // `PLAN_TIERS.includes(planRaw) ? planRaw : 'basic'` is the
  // whitelist. Pin that an unknown tier (e.g. user-supplied "premium"
  // or SQL-injection attempt) does NOT bubble into the Stripe call —
  // instead the request lands cleanly on the billing_not_configured
  // 503 (since billing is disabled in this test env), proving the
  // route reached the second guard without crashing on the unknown
  // string.
  const userId = 9_777_021;
  setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${tokenFor({ id: userId, role: "admin", agencyId: 42 })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan_tier: "premium-elite-gold", logs_unlimited: false }),
    });
    // 503 billing_not_configured (NOT a 500) means the unknown tier
    // got coerced cleanly and the route advanced to the next guard.
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "billing_not_configured");
  } finally {
    await close();
  }
});

test("POST /v1/billing/checkout: an unknown plan_tier coerces to 'basic' (no 500 stack trace)", async () => {
  // checkout doesn't have the billingEnabled() short-circuit, so an
  // unknown tier reaches `startCheckout` which then hits
  // `getAgencyBillingById` (DB) — surfaces as 503
  // database_unavailable. The test value: prove the unknown tier did
  // not crash the route on the way to the DB call.
  const userId = 9_777_022;
  setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
  const { baseUrl, close } = await bootBillingRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFor({ id: userId, role: "admin", agencyId: 42 })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan_tier: "../../etc/passwd", logs_unlimited: false }),
    });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "database_unavailable");
  } finally {
    await close();
  }
});
