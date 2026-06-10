/**
 * Tests for the `/v1/admin/user-templates` REST surface (added by the
 * "user permission templates" feature). These routes let an agency admin
 * store reusable per-agency permission presets and apply them to a user in
 * one shot. The blast radius is large:
 *
 *  - a regression that widens the admin-only gate would let a dispatcher
 *    or a platform owner mutate any agency's template catalog, which is
 *    the on-disk source of truth for "what channels does a new hire get?".
 *  - a regression that drops one of the five routes silently breaks the
 *    Settings → Users template editor with no test-time signal.
 *  - a regression in the URL/body validators would either crash the route
 *    (a 500 + alert) or let malformed payloads reach the Postgres layer.
 *
 * These tests pin the contract by exercising the real Express router
 * through `bootRouter()`, with the session cache pre-seeded so the
 * router-level "is this account still enabled?" middleware doesn't try to
 * hit Postgres (which is unavailable in this test process). Where the
 * happy-path DB call would otherwise reach `requirePool()`, we assert the
 * `fail()` helper translates the throw into a clean 503 rather than a 500
 * — graceful degradation, not a crash that would surface as a Railway
 * health alert on every redeploy.
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

/** Pre-seed the session cache for `userId` so the DB-backed middleware no-ops. */
function preseedAuth(userId: number): void {
  setCachedAuth(userId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
}

/**
 * Helper: ensure DATABASE_URL is unset before a request, restore it after.
 * Returns the previous value so the caller can restore via the finally block.
 */
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

test("user-templates routes: the five expected verbs+paths are registered", () => {
  // Catches a refactor that accidentally drops one of the five routes the
  // Settings → Users template editor relies on. Without this, deleting any
  // single route would still pass `npm test`.
  const router = createApiRouter();
  type RouteLayer = {
    route?: { path: string; methods: Record<string, boolean> };
  };
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const registered = new Set<string>();
  for (const layer of layers) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) {
        registered.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
  }
  for (const route of [
    "GET /admin/user-templates",
    "POST /admin/user-templates",
    "PATCH /admin/user-templates/:id",
    "DELETE /admin/user-templates/:id",
    "POST /admin/user-templates/:id/apply",
  ]) {
    assert.ok(registered.has(route), `expected ${route} to be registered`);
  }
});

test("GET /v1/admin/user-templates: unauthenticated → 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
  }
});

test("GET /v1/admin/user-templates: dispatcher → 403 (admin-only)", async () => {
  // Dispatchers can read presence/air state but must not touch the agency
  // permission catalog. The /admin/* prefix doesn't enforce admin by itself;
  // every handler must wear `requireAdmin`. This pins that wiring.
  clearAuthCache();
  const dispatcherUserId = 9_800_001;
  preseedAuth(dispatcherUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherUserId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/admin/user-templates: platform owner (no agencyId) → 403", async () => {
  // Platform owners manage tenants but must not directly mutate the per-
  // agency permission catalog. `requireAdmin` enforces `agencyId != null`.
  // A regression that swapped to `requireAuth` would let owner tokens
  // cross the tenant boundary.
  clearAuthCache();
  const ownerUserId = 9_800_002;
  preseedAuth(ownerUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: ownerUserId,
      role: "owner",
      agencyId: null,
      agencyName: null,
    });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/admin/user-templates: admin with no DATABASE_URL → 503 (not a 500)", async () => {
  // Happy-path read with the admin gate passed but Postgres unavailable.
  // The store layer throws `database_unavailable`; the route's `fail()`
  // helper must translate to 503 so dev/CI and a Railway warm-up window
  // never see a 500 stack trace on this endpoint.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_003;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
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

test("POST /v1/admin/user-templates: rejects missing name with 400 (no DB hit)", async () => {
  // Name is the human label admins see in the editor; an empty string
  // would create a phantom row that's impossible to select from the list.
  // The handler must validate BEFORE calling `createUserPermissionTemplate`,
  // so the route returns 400 even with no DB. Pinning the order also
  // ensures we don't leak partial template rows.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_004;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    // Empty / whitespace name must 400 — never a 503 (which would mean the
    // validator ran AFTER `requirePool()` and missed the trim guard).
    for (const name of ["", "   ", "\n\t"]) {
      const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, memberships: [] }),
      });
      assert.equal(res.status, 400, `name=${JSON.stringify(name)} should 400, got ${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "missing_fields");
    }
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("POST /v1/admin/user-templates: unauthenticated → 401 (cannot mutate catalog)", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Patrol", memberships: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("POST /v1/admin/user-templates: dispatcher → 403, cannot create templates", async () => {
  clearAuthCache();
  const dispatcherUserId = 9_800_005;
  preseedAuth(dispatcherUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherUserId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Patrol", memberships: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("PATCH /v1/admin/user-templates/:id: non-numeric id → 400 before any DB hit", async () => {
  // `Number.isFinite(NaN)` is false, so a string id like "abc" must return
  // 400 missing_fields. A regression that skipped the finite check would
  // call `updateUserPermissionTemplate(NaN, ...)` and either 404 or 500.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_006;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/not-a-number`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Patrol" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_fields");
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("PATCH /v1/admin/user-templates/:id: whitespace-only name → 400, never a silent reset", async () => {
  // Sending `{name: "   "}` must reject — otherwise the trimmed empty
  // string would wipe a perfectly good template label without warning.
  // The handler trims and rejects before calling `update`, so this 400s
  // even with no DB.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_007;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/123`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_fields");
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("PATCH /v1/admin/user-templates/:id: dispatcher → 403 (cannot mutate)", async () => {
  clearAuthCache();
  const dispatcherUserId = 9_800_008;
  preseedAuth(dispatcherUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherUserId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/123`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Patrol" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("DELETE /v1/admin/user-templates/:id: non-numeric id → 400 before any DB hit", async () => {
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_009;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/abc`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_fields");
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("DELETE /v1/admin/user-templates/:id: dispatcher → 403", async () => {
  clearAuthCache();
  const dispatcherUserId = 9_800_010;
  preseedAuth(dispatcherUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherUserId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/admin/user-templates/:id/apply: missing userId → 400 before any DB hit", async () => {
  // Apply needs both a template id (URL) and a user id (body). Missing
  // either must 400 — never reach `getUserPermissionTemplate` which would
  // otherwise crash with a Postgres error in dev.
  const prevDbUrl = clearDatabaseUrl();
  clearAuthCache();
  const adminUserId = 9_800_011;
  preseedAuth(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    // No body at all.
    const noBody = await fetch(`${baseUrl}/v1/admin/user-templates/5/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noBody.status, 400);
    assert.equal(((await noBody.json()) as { error?: string }).error, "missing_fields");

    // Non-numeric userId.
    const badUser = await fetch(`${baseUrl}/v1/admin/user-templates/5/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "abc" }),
    });
    assert.equal(badUser.status, 400);
    assert.equal(((await badUser.json()) as { error?: string }).error, "missing_fields");

    // Non-numeric templateId in the URL.
    const badTemplate = await fetch(`${baseUrl}/v1/admin/user-templates/oops/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: 7 }),
    });
    assert.equal(badTemplate.status, 400);
    assert.equal(((await badTemplate.json()) as { error?: string }).error, "missing_fields");
  } finally {
    await close();
    clearAuthCache();
    restoreDatabaseUrl(prevDbUrl);
  }
});

test("POST /v1/admin/user-templates/:id/apply: dispatcher → 403 (cannot bulk-apply permissions)", async () => {
  // Applying a template is the highest-impact mutation in this surface —
  // a single call rewrites every channel grant for a user. Locking it
  // behind admin-only is non-negotiable.
  clearAuthCache();
  const dispatcherUserId = 9_800_012;
  preseedAuth(dispatcherUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherUserId, agencyId: 42, role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/5/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: 99 }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/admin/user-templates/:id/apply: unauthenticated → 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/user-templates/5/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 7 }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});
