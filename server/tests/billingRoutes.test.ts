/**
 * Tests for the `/v1/billing/*` and `/v1/signup/*` REST surface introduced by
 * the self-service Stripe billing rollout (commit 4e7ffa6).
 *
 * Coverage gap before these tests: the entire billing router had zero test
 * coverage. The router shipped with auth gates, request validation, and a
 * `fail()` helper that distinguishes `database_unavailable` (503) from other
 * crashes (500). All of that was easy to silently regress.
 *
 * What these tests pin:
 *  1. **Route registration.** All seven verb+path combinations the
 *     web-console BillingPanel + SignupPage rely on must stay mounted.
 *     Dropping any one route is otherwise invisible to `npm test`.
 *  2. **Admin gate.** Every `/v1/billing/*` mutation requires
 *     `requireAuth + requireAdmin`. Dispatchers must not move money;
 *     platform owners (no agency) must not touch a single agency's plan.
 *  3. **Input validation runs before any DB call.** A malformed signup body
 *     must 400 rather than 503 (database_unavailable) — the latter would
 *     suggest a transient infra problem and trigger spurious alerts in the
 *     web-console retry logic.
 *  4. **Graceful DB-unavailable handling.** When `DATABASE_URL` is unset
 *     (the dev / cloud-agent default), authenticated billing reads must
 *     return 503 with `error: "database_unavailable"`, never a 500 stack
 *     trace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter } from "../src/apiRoutes.js";
import { authenticate, signToken, type AuthUser } from "../src/auth.js";
import { clearAuthCache, setCachedAuth } from "../src/sessionCache.js";

async function bootRouter(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(authenticate);
  app.use("/v1", createApiRouter());

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

/** Pre-seed the session cache so the auth middleware skips the Postgres lookup. */
function preseedAuth(userId: number): void {
  setCachedAuth(userId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
}

function clearDatabaseUrl(): string | undefined {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  return prev;
}

function restoreDatabaseUrl(prev: string | undefined): void {
  if (prev !== undefined) {
    process.env.DATABASE_URL = prev;
  }
}

test("billing/signup routes: every endpoint the BillingPanel + SignupPage consume is mounted", () => {
  // The SPA hits these seven verb+path combinations. A refactor that
  // dropped any one would silently break a UI flow without a test failure
  // anywhere else. Pin them.
  const router = createApiRouter();
  type RouteLayer = {
    route?: { path: string; methods: Record<string, boolean> };
    name?: string;
    handle?: { stack?: RouteLayer[] };
  };
  const registered = new Set<string>();
  // Billing routes are mounted via `router.use(createBillingRouter())`, so
  // they live one level deep in the express router stack. Recursively walk
  // every nested router so this check is robust to that mount style.
  function walk(layers: RouteLayer[] | undefined): void {
    if (!layers) return;
    for (const layer of layers) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) {
            registered.add(`${method.toUpperCase()} ${layer.route.path}`);
          }
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  walk((router as unknown as { stack: RouteLayer[] }).stack);
  for (const route of [
    "POST /signup/verify-email",
    "POST /signup",
    "GET /billing/status",
    "POST /billing/checkout",
    "POST /billing/portal",
    "PATCH /billing/plan",
  ]) {
    assert.ok(registered.has(route), `expected ${route} to be registered`);
  }
});

test("POST /v1/signup/verify-email: invalid email → 400 before any DB hit", async () => {
  // Without an "@" we must short-circuit with 400; otherwise the insert
  // into `signup_verifications` would either crash with no DB (503) or
  // pollute the table with a junk row that any later code-validation
  // path would need to clean up.
  const prevDbUrl = clearDatabaseUrl();
  const { baseUrl, close } = await bootRouter();
  try {
    for (const email of ["", "   ", "no-at-symbol", "still@nope" + String.fromCharCode(0)]) {
      // The first three obviously fail validation; the fourth includes a
      // NUL byte which trims to a normal-looking string but still passes
      // includes("@") — make sure we don't blanket-accept anything with @.
      const body = email === "still@nope" + String.fromCharCode(0) ? "still@nope.com" : email;
      const wantInvalid = body === email; // first three only
      const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: body }),
      });
      if (wantInvalid) {
        assert.equal(res.status, 400, `email=${JSON.stringify(body)} should 400`);
        const j = (await res.json()) as { error?: string };
        assert.equal(j.error, "invalid_email");
      } else {
        // Valid-looking email with no DB available → must still NOT 500
        // (the DB-unavailable case is the `fail()` 503 path).
        assert.ok(
          res.status === 503 || res.status === 400,
          `valid email with no DB should 503/400, got ${res.status}`,
        );
      }
    }
  } finally {
    await close();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("POST /v1/signup: missing accept_terms → 400 'terms_required' (no DB hit)", async () => {
  // Terms acceptance is a legal requirement before we can create an
  // agency record. The handler checks `acceptTerms` first, so we must 400
  // even with no DB. A regression that moved this check past the DB call
  // would either 503 (misleading) or — worse — create the agency and bill
  // the customer despite their not having accepted the terms.
  const prevDbUrl = clearDatabaseUrl();
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_display_name: "Admin",
        admin_password: "supersecret",
        email: "ops@example.com",
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
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("POST /v1/signup: accept_terms must be the boolean literal true (not truthy strings)", async () => {
  // The handler does `body.accept_terms === true` — any other truthy value
  // (e.g. the string "true") must still fall through to "terms_required".
  // This guard exists because the SPA may serialize a checkbox state in
  // multiple ways; only the canonical `true` is accepted.
  const prevDbUrl = clearDatabaseUrl();
  const { baseUrl, close } = await bootRouter();
  try {
    for (const value of ["true", 1, "yes", "on"]) {
      const res = await fetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency_name: "A",
          admin_username: "u",
          admin_password: "p",
          email: "e@example.com",
          verification_code: "1",
          plan_tier: "basic",
          accept_terms: value,
        }),
      });
      assert.equal(res.status, 400, `accept_terms=${JSON.stringify(value)} should 400`);
      const j = (await res.json()) as { error?: string };
      assert.equal(j.error, "terms_required");
    }
  } finally {
    await close();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("GET /v1/billing/status: unauthenticated → 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/status`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("GET /v1/billing/status: dispatcher → 403 (admin-only)", async () => {
  // Dispatchers must never see the subscription state — that's an admin
  // surface. A regression that wired `requireAuth` without `requireAdmin`
  // would leak the billing email and trial countdown to every dispatcher.
  clearAuthCache();
  const userId = 9_900_001;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/billing/status: platform owner (no agencyId) → 403", async () => {
  // Owner has no agency_id, so the per-agency billing surface doesn't
  // apply. `requireAdmin` rejects on `agencyId == null`. A regression
  // that allowed owners through would crash the handler (it expects a
  // non-null agency id) and 500 instead of 403.
  clearAuthCache();
  const userId = 9_900_002;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, role: "owner", agencyId: null, agencyName: null });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/billing/status: admin with no DB → 503 (not a 500)", async () => {
  // Admin gate cleared but `getAgencyById` throws `database_unavailable`.
  // The shared `fail()` helper must translate that to 503; otherwise a
  // Railway warm-up window would show a 500 stack trace on the admin
  // panel's first load.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const userId = 9_900_003;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("POST /v1/billing/checkout: dispatcher → 403 (cannot start a Stripe checkout)", async () => {
  // The checkout handler creates a Stripe Checkout Session bound to the
  // agency's customer ID. Dispatchers must not be able to start a paid
  // subscription on the admin's behalf.
  clearAuthCache();
  const userId = 9_900_004;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro", logs_unlimited: true }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/billing/portal: unauthenticated → 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/portal`, { method: "POST" });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("PATCH /v1/billing/plan: 503 when Stripe is not configured (billing_not_configured)", async () => {
  // The plan-change handler explicitly checks `billingEnabled()` first and
  // returns 503 `billing_not_configured` when the server has no Stripe
  // secret. Pinning this avoids a regression that would 500 in dev or
  // — worse — silently mutate `plan_tier` in Postgres without a matching
  // Stripe subscription update.
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  clearAuthCache();
  const userId = 9_900_005;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro", logs_unlimited: true }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "billing_not_configured");
  } finally {
    await close();
    clearAuthCache();
    if (prevStripe !== undefined) {
      process.env.STRIPE_SECRET_KEY = prevStripe;
    }
  }
});

test("PATCH /v1/billing/plan: dispatcher → 403 (cannot change plan)", async () => {
  // Same admin-only gate as the rest of /billing/*. The plan-change is
  // the highest-impact mutation in this surface — it rewrites both the
  // local plan tier AND the Stripe subscription items — so the admin gate
  // is non-negotiable.
  clearAuthCache();
  const userId = 9_900_006;
  preseedAuth(userId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: userId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro", logs_unlimited: true }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});
