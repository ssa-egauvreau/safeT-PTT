/**
 * HTTP-level tests for the billing router (`server/src/billing/routes.ts`)
 * mounted under `/v1` via `createApiRouter()`.
 *
 * The billing router was the subject of PR #273 (regression test in
 * `apiRoutes.test.ts`): it must be mounted **after** the
 * disabled-account / token-generation enforcement middleware so a stale
 * token can't bypass session checks via a billing endpoint. These tests
 * pin the rest of that contract:
 *
 *   - Authenticated billing actions all sit behind `requireAuth` +
 *     `requireAdmin` — owner tokens (no agencyId) and unauthenticated
 *     requests must be rejected before any Stripe round-trip happens.
 *
 *   - `PATCH /v1/billing/plan` short-circuits to 503
 *     `billing_not_configured` when `STRIPE_SECRET_KEY` is missing, even
 *     for a valid admin. This prevents the dev/CI environment from
 *     silently invoking the (uninitialised) Stripe client.
 *
 *   - The public signup endpoints (`POST /v1/signup`,
 *     `POST /v1/signup/verify-email`) validate their inputs *before*
 *     touching the database. Without these checks an empty / malformed
 *     payload would surface as a 503 `database_unavailable` (or worse,
 *     a 500) instead of the documented 400 `invalid_email` /
 *     `terms_required` contract the SignupPage UI relies on.
 *
 * All tests run with `DATABASE_URL` unset so the pure-validation paths
 * exit before any DB call. Tests that intentionally need the DB-backed
 * path (e.g. the trial / verification-code lookup) are covered separately;
 * here we only pin the "request that never reaches the database" guards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter } from "../../src/apiRoutes.js";
import { authenticate, signToken, type AuthUser } from "../../src/auth.js";
import { clearAuthCache, setCachedAuth } from "../../src/sessionCache.js";

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

/** Save / restore DATABASE_URL around a test that must run DB-less. */
function withoutDatabase<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  return Promise.resolve(fn()).finally(() => {
    if (prev !== undefined) {
      process.env.DATABASE_URL = prev;
    }
  });
}

// ---------------------------------------------------------------------------
// Authenticated billing routes — auth gates
// ---------------------------------------------------------------------------

const PROTECTED_ROUTES: Array<{ method: string; path: string; body?: object }> = [
  { method: "GET", path: "/v1/billing/status" },
  { method: "POST", path: "/v1/billing/checkout", body: { plan_tier: "basic" } },
  { method: "POST", path: "/v1/billing/portal", body: {} },
  { method: "PATCH", path: "/v1/billing/plan", body: { plan_tier: "basic" } },
];

for (const route of PROTECTED_ROUTES) {
  test(`${route.method} ${route.path}: rejects unauthenticated requests with 401`, async () => {
    await withoutDatabase(async () => {
      const { baseUrl, close } = await bootRouter();
      try {
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        assert.equal(
          res.status,
          401,
          `${route.method} ${route.path} must require auth`,
        );
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "unauthorized");
      } finally {
        await close();
      }
    });
  });

  test(`${route.method} ${route.path}: platform owner (no agencyId) gets 403`, async () => {
    await withoutDatabase(async () => {
      clearAuthCache();
      const ownerId = 9_999_100 + PROTECTED_ROUTES.indexOf(route);
      // Pre-seed the cache so the upstream disabled-account middleware
      // doesn't try to hit Postgres before we reach `requireAdmin`.
      setCachedAuth(ownerId, {
        tokenGeneration: 0,
        userDisabled: false,
        agencyDisabled: false,
      });
      const { baseUrl, close } = await bootRouter();
      try {
        const token = tokenFor({
          id: ownerId,
          role: "owner",
          agencyId: null,
          agencyName: null,
        });
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        assert.equal(
          res.status,
          403,
          `${route.method} ${route.path} must reject owner tokens`,
        );
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "forbidden");
      } finally {
        await close();
        clearAuthCache();
      }
    });
  });

  test(`${route.method} ${route.path}: dispatcher role (non-admin) gets 403`, async () => {
    await withoutDatabase(async () => {
      clearAuthCache();
      const userId = 9_999_200 + PROTECTED_ROUTES.indexOf(route);
      setCachedAuth(userId, {
        tokenGeneration: 0,
        userDisabled: false,
        agencyDisabled: false,
      });
      const { baseUrl, close } = await bootRouter();
      try {
        const token = tokenFor({
          id: userId,
          role: "dispatcher",
          agencyId: 42,
        });
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        // Dispatchers can talk on the radio but must never modify billing.
        assert.equal(
          res.status,
          403,
          `${route.method} ${route.path} must be admin-only`,
        );
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "forbidden");
      } finally {
        await close();
        clearAuthCache();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// PATCH /v1/billing/plan — early 503 when Stripe is not configured
// ---------------------------------------------------------------------------

test("PATCH /v1/billing/plan: returns 503 billing_not_configured before any DB read when STRIPE_SECRET_KEY is missing", async () => {
  // The plan-change endpoint guards against running with an unconfigured
  // Stripe client by short-circuiting to 503 *before* it loads the agency
  // row. Without this guard, dev/CI environments would hit the DB only
  // to fail later at Stripe — slower, noisier, and confusing.
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  await withoutDatabase(async () => {
    clearAuthCache();
    const adminId = 9_999_300;
    setCachedAuth(adminId, {
      tokenGeneration: 0,
      userDisabled: false,
      agencyDisabled: false,
    });
    const { baseUrl, close } = await bootRouter();
    try {
      const token = tokenFor({ id: adminId, role: "admin", agencyId: 42 });
      const res = await fetch(`${baseUrl}/v1/billing/plan`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan_tier: "pro", logs_unlimited: true }),
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "billing_not_configured");
    } finally {
      await close();
      clearAuthCache();
      if (prevSecret !== undefined) {
        process.env.STRIPE_SECRET_KEY = prevSecret;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Public signup endpoints — input validation BEFORE the DB
// ---------------------------------------------------------------------------

test("POST /v1/signup/verify-email: rejects empty payload with 400 invalid_email (no DB hit)", async () => {
  // The handler trims and lower-cases the email before calling the
  // database; an empty / missing email must fail fast with the documented
  // 400 contract the SignupPage relies on. If this regresses to a 500 or
  // 503 (database_unavailable) the SPA's "Resend code" UX silently breaks.
  await withoutDatabase(async () => {
    const { baseUrl, close } = await bootRouter();
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
});

test("POST /v1/signup/verify-email: rejects an email without '@' as invalid_email", async () => {
  await withoutDatabase(async () => {
    const { baseUrl, close } = await bootRouter();
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
});

test("POST /v1/signup: rejects accept_terms !== true with 400 terms_required (no DB hit)", async () => {
  // `completeSignup` checks `acceptTerms` first thing. The route must
  // surface this as 400 `terms_required` *before* the DB-backed
  // verification-code lookup — otherwise the signup form's "you must
  // accept the terms" inline error would degrade to a generic
  // "database_unavailable" 503 in dev.
  await withoutDatabase(async () => {
    const { baseUrl, close } = await bootRouter();
    try {
      const res = await fetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency_name: "New Agency",
          admin_username: "admin",
          admin_password: "supersecret-passphrase",
          email: "owner@example.com",
          verification_code: "000000",
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
});

test("POST /v1/signup: a non-true accept_terms value is rejected (string 'true' is NOT enough)", async () => {
  // Defence in depth: the route uses strict `=== true` matching, so a
  // form that posts the string "true" or a truthy object MUST still be
  // rejected. This pins the contract before someone "helpfully" relaxes
  // it to a truthy check and lets clients accidentally bypass the legal
  // attestation.
  await withoutDatabase(async () => {
    const { baseUrl, close } = await bootRouter();
    try {
      const res = await fetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency_name: "Other Agency",
          admin_username: "admin2",
          admin_password: "another-passphrase",
          email: "owner2@example.com",
          verification_code: "111111",
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
});
