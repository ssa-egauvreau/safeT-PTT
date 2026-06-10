/**
 * HTTP integration tests for the billing router.
 *
 * The billing router (`server/src/billing/routes.ts`) is mounted at `/v1`
 * via `apiRoutes.ts:createApiRouter` and is the public surface for:
 *
 *   - Self-service signup (`POST /v1/signup/verify-email`, `POST /v1/signup`)
 *   - Authenticated billing (`GET /v1/billing/status`,
 *     `POST /v1/billing/checkout`, `POST /v1/billing/portal`,
 *     `PATCH /v1/billing/plan`)
 *
 * Two regression classes matter most here:
 *
 *   1. **Validation runs before the database is touched**: a malformed
 *      signup email returns 400 even when no Postgres pool is configured.
 *      Without that guarantee a CI environment would 503-bomb on every
 *      request and signup behaviour would only be exercised in production.
 *
 *   2. **Auth gates stay wired**: every billing endpoint other than the
 *      public signup pair requires admin auth. A regression that dropped
 *      the `requireAuth` / `requireAdmin` middleware would leak per-tenant
 *      billing details (Stripe customer id, plan tier, billable seats) to
 *      unauthenticated callers.
 *
 * We boot a one-shot Express app that mirrors the production wiring:
 *   `app.use(express.json())` → `app.use(authenticate)` →
 *   `app.use("/v1", createApiRouter())`.
 *
 * The signup paths are deliberately mounted under the same `/v1` prefix
 * via `createApiRouter` (which `router.use(createBillingRouter())`s the
 * billing router at the top of `/v1`). Tests that don't need a token
 * just hit `${baseUrl}/v1/signup/...`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter } from "../../src/apiRoutes.js";
import { authenticate } from "../../src/auth.js";
import { clearAuthCache } from "../../src/sessionCache.js";

interface Booted {
  baseUrl: string;
  close: () => Promise<void>;
}

async function boot(): Promise<Booted> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(authenticate);
  app.use("/v1", createApiRouter());
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

function withoutDb<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  return fn().finally(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });
}

// ---------------------------------------------------------------------------
// Public signup surface — no auth required.
// ---------------------------------------------------------------------------

test("POST /v1/signup/verify-email: empty email returns 400 invalid_email (no DB)", async () => {
  await withoutDb(async () => {
    const { baseUrl, close } = await boot();
    try {
      const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "invalid_email");
    } finally {
      await close();
    }
  });
});

test("POST /v1/signup/verify-email: missing @ returns 400 invalid_email", async () => {
  await withoutDb(async () => {
    const { baseUrl, close } = await boot();
    try {
      const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ops.example.com" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "invalid_email");
    } finally {
      await close();
    }
  });
});

test("POST /v1/signup/verify-email: missing email field is treated as empty (400 invalid_email)", async () => {
  await withoutDb(async () => {
    const { baseUrl, close } = await boot();
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

test("POST /v1/signup: missing acceptTerms returns 400 terms_required (no DB)", async () => {
  // The terms gate runs BEFORE any DB query, so a regression that swapped
  // the order of `acceptTerms` vs `verifyCode` checks would silently let a
  // user create an agency without accepting the ToS — a legal contract
  // problem, not just a UX bug.
  await withoutDb(async () => {
    const { baseUrl, close } = await boot();
    try {
      const res = await fetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency_name: "Test Agency",
          admin_username: "admin",
          admin_password: "password123!",
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
    }
  });
});

test("POST /v1/signup: accept_terms missing entirely also fails terms_required", async () => {
  await withoutDb(async () => {
    const { baseUrl, close } = await boot();
    try {
      const res = await fetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agency_name: "Test Agency",
          admin_username: "admin",
          admin_password: "password123!",
          email: "ops@example.com",
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
});

// ---------------------------------------------------------------------------
// Authenticated billing surface — `requireAuth` + `requireAdmin`.
// ---------------------------------------------------------------------------

test("GET /v1/billing/status: 401 unauthorized without a bearer token", async () => {
  clearAuthCache();
  const { baseUrl, close } = await boot();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/status`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/billing/checkout: 401 unauthorized without a bearer token", async () => {
  clearAuthCache();
  const { baseUrl, close } = await boot();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "basic" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/billing/portal: 401 unauthorized without a bearer token", async () => {
  clearAuthCache();
  const { baseUrl, close } = await boot();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/portal`, { method: "POST" });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("PATCH /v1/billing/plan: 401 unauthorized without a bearer token", async () => {
  clearAuthCache();
  const { baseUrl, close } = await boot();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
    clearAuthCache();
  }
});

// ---------------------------------------------------------------------------
// Smoke test: every billing route is registered under the expected verb.
// A future refactor that accidentally drops a route from `createBillingRouter`
// would silently break the admin BillingPanel — pin them here.
// ---------------------------------------------------------------------------

test("createApiRouter: billing routes stay registered with the expected verbs", () => {
  const router = createApiRouter();
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
  // The billing router is mounted via `router.use(createBillingRouter())`,
  // so its routes appear under nested mounted routers, not the top stack.
  // Walk the layer tree to find them.
  const stack = (router as unknown as { stack: Array<RouteLayer & { handle?: { stack?: RouteLayer[] } }> }).stack;
  const registered = new Set<string>();
  function visit(layers: RouteLayer[] | undefined): void {
    if (!layers) return;
    for (const l of layers) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) {
          if (l.route.methods[m]) registered.add(`${m.toUpperCase()} ${l.route.path}`);
        }
      }
      const nested = (l as { handle?: { stack?: RouteLayer[] } }).handle;
      if (nested && Array.isArray(nested.stack)) visit(nested.stack);
    }
  }
  visit(stack);

  for (const route of [
    "POST /signup/verify-email",
    "POST /signup",
    "GET /billing/status",
    "POST /billing/checkout",
    "POST /billing/portal",
    "PATCH /billing/plan",
  ]) {
    assert.ok(
      registered.has(route),
      `expected billing route ${route} to be registered (got ${registered.size} routes)`,
    );
  }
});
