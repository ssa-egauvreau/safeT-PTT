/**
 * Integration tests for `server/src/billing/routes.ts`.
 *
 * The billing router serves two very different audiences:
 *
 *  1. PUBLIC self-service signup (`POST /signup/verify-email`,
 *     `POST /signup`) — no auth, no agency context. These endpoints sit
 *     on the open internet and MUST reject malformed input cleanly with
 *     400, never 500. A regression that 500'd on a missing body field
 *     would noise up Railway alerts and let attackers infer details
 *     from stack-traced error responses.
 *
 *  2. AUTHENTICATED admin actions (`GET /billing/status`,
 *     `POST /billing/checkout`, `POST /billing/portal`,
 *     `PATCH /billing/plan`) — every route MUST go through both
 *     `requireAuth` and `requireAdmin`. A regression that dropped
 *     either gate would let a logged-in dispatcher (or worse, a radio
 *     handset JWT) trigger Stripe Checkout for someone else's agency
 *     or open the customer billing portal — a multi-tenant data leak.
 *
 * The router is mounted under `/v1` (matching production), so the
 * test paths below match what the SPA actually calls.
 *
 * What this file pins specifically:
 *
 *  - `POST /v1/signup/verify-email` with invalid email → 400 with the
 *    `invalid_email` error code.
 *  - `POST /v1/signup` with `accept_terms !== true` → 400
 *    `terms_required`. Strictly === true; truthy strings rejected at
 *    the route layer.
 *  - `POST /v1/signup` coerces an unknown `plan_tier` to "basic"
 *    (so a malicious caller can't bypass the price ceiling by sending
 *    `plan_tier: "free"`); coverage is via the reachable next-step
 *    failure.
 *  - All four admin endpoints require auth and admin role:
 *      no token → 401, dispatcher token → 403, owner (no agencyId) → 403.
 *  - `PATCH /v1/billing/plan` returns 503 `billing_not_configured`
 *    when STRIPE_SECRET_KEY is unset, BEFORE touching the DB. Proves
 *    the early-return guard is wired ahead of the DB read.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createBillingRouter } from "../../src/billing/routes.js";
import { authenticate, signToken, type AuthUser } from "../../src/auth.js";

async function bootRouter(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  // Tests in this file pin behavior that should hold WITHOUT a DB
  // (input validation runs before DB) and WITHOUT Stripe (early
  // billing_not_configured gates).
  delete process.env.DATABASE_URL;
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  if (ORIGINAL_DB_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DB_URL;
  }
  if (ORIGINAL_STRIPE_KEY === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_KEY;
  }
});

// ---------------------------------------------------------------------------
// Public signup endpoints — no auth, must validate input cleanly
// ---------------------------------------------------------------------------

test("POST /v1/signup/verify-email: rejects an invalid email with 400 invalid_email", async () => {
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

test("POST /v1/signup/verify-email: rejects an empty body with 400 invalid_email", async () => {
  // A regression that crashed on `req.body.email` being undefined
  // would 500 here. The String(... ?? '').trim() guard in the route
  // is what keeps this clean — pin it.
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

test("POST /v1/signup/verify-email: missing JSON body returns 400 invalid_email, not 500", async () => {
  // Same guard as above, exercised via the no-body path that
  // express.json() turns into `req.body === undefined`.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_email");
  } finally {
    await close();
  }
});

test("POST /v1/signup: rejects missing accept_terms (must be strictly === true)", async () => {
  // The route coerces `body.accept_terms === true`, so any other
  // value (missing, false, "true", 1) falls through to `acceptTerms: false`
  // in `completeSignup`, which returns `terms_required`.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test",
        admin_username: "admin",
        admin_password: "hunter2hunter2",
        email: "admin@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        // accept_terms intentionally missing
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
  }
});

test("POST /v1/signup: rejects accept_terms='true' (string) because the gate is strictly === true", async () => {
  // Pin the route's strict-equality coercion. A regression that did
  // `Boolean(body.accept_terms)` would let `"true"` (and `1`, and
  // `"yes"`) silently pass the ToS gate.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test",
        admin_username: "admin",
        admin_password: "hunter2hunter2",
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

test("POST /v1/signup: unknown plan_tier is silently coerced to 'basic' (no error to attacker)", async () => {
  // The route validates plan_tier against the PLAN_TIERS allow-list.
  // A regression that trusted the raw string would let a malicious
  // caller send `plan_tier: "enterprise"` and end up with whatever
  // tier the downstream Stripe call mapped to (or crash). The
  // observable contract for THIS test: with terms accepted, the
  // request proceeds past plan validation and hits the DB →
  // `database_unavailable` → 503. A 400 here would mean plan_tier
  // got rejected as invalid; a 500 would mean an unhandled crash.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test",
        admin_username: "admin",
        admin_password: "hunter2hunter2",
        email: "admin@example.com",
        verification_code: "123456",
        plan_tier: "enterprise-x", // not in PLAN_TIERS
        accept_terms: true,
      }),
    });
    // 503 = the request progressed past the gates and hit the DB.
    // The exact error code matters less than "didn't 500 and didn't
    // 400 with plan-tier-specific wording".
    assert.equal(
      res.status,
      503,
      "unknown plan_tier should be coerced to 'basic', then progress to the DB step",
    );
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Admin-only billing actions — require auth + admin role
// ---------------------------------------------------------------------------

test("GET /v1/billing/status: 401 with no bearer token", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/status`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
  }
});

test("GET /v1/billing/status: 403 for a dispatcher token (admin role required)", async () => {
  // Dispatchers can run the console, but they MUST NOT be able to
  // open the agency's billing portal or change subscription tiers.
  // A regression that swapped requireAdmin for requireAuth here would
  // let any logged-in seat access billing.
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "forbidden");
  } finally {
    await close();
  }
});

test("GET /v1/billing/status: 403 for a radio handset token", async () => {
  // Radio JWTs are long-lived and live on user devices; they MUST NOT
  // be able to read or change agency billing.
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "radio", unitId: "U-101" });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("GET /v1/billing/status: 403 for a platform owner token (no agencyId)", async () => {
  // Owners administrate the platform across tenants; they don't
  // belong to one agency, so `requireAdmin` rejects them on the
  // `agencyId == null` branch. This is the tenant-isolation contract.
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "owner", agencyId: null, agencyName: null });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("POST /v1/billing/checkout: 401 with no token", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("POST /v1/billing/checkout: 403 for dispatcher", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("POST /v1/billing/portal: 401 with no token", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/portal`, { method: "POST" });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("POST /v1/billing/portal: 403 for radio handset", async () => {
  // Symmetric to the GET /status case — pin every admin-gated path
  // against the radio role since handset JWTs are the highest-volume
  // tokens in the system.
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "radio", unitId: "U-101" });
    const res = await fetch(`${baseUrl}/v1/billing/portal`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("PATCH /v1/billing/plan: 401 with no token", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("PATCH /v1/billing/plan: 403 for dispatcher (admin role gate)", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "dispatcher" });
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("PATCH /v1/billing/plan: 503 billing_not_configured when STRIPE_SECRET_KEY is unset (admin token)", async () => {
  // This route uniquely runs `billingEnabled()` BEFORE the DB read.
  // Pin that ordering — a regression that moved the DB call ahead of
  // the env-var check would return 503 database_unavailable instead
  // (different code path, different user-facing message in the
  // admin Billing panel).
  delete process.env.STRIPE_SECRET_KEY;
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "admin", agencyId: 42 });
    const res = await fetch(`${baseUrl}/v1/billing/plan`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: "pro" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "billing_not_configured");
  } finally {
    await close();
  }
});

test("GET /v1/billing/status: admin with no DATABASE_URL → 503 database_unavailable (not 500)", async () => {
  // The `fail()` helper translates the `database_unavailable` error
  // thrown by `requirePool()` into a clean 503. Pin that mapping so
  // a regression that bubbled the raw error into a 500 (and dumped
  // a stack to logs) doesn't ship.
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ role: "admin", agencyId: 42 });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
  }
});
