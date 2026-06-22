/**
 * Smoke + auth-gate tests for `server/src/apiRoutes.ts`.
 *
 * The motivating bug for this file is PR #151: a merge artifact left the
 * `GET /v1/audio/config` handler with duplicate imports and a half-stitched
 * `res.json({...})` block, which made the entire `apiRoutes.ts` module fail
 * to compile. Because no existing test imported `apiRoutes.ts` (the unit
 * tests cover the small pure helpers in isolation), the broken file shipped
 * into a PR without any test failure — the bug only surfaced as a runtime
 * crash when the server tried to boot.
 *
 * The tests below cover the whole class of "apiRoutes file got corrupted /
 * a route got accidentally deleted" regressions with minimal overhead:
 *
 *   1. Module smoke test — `createApiRouter()` loads and constructs a
 *      Router without throwing. A future merge artifact, import typo, or
 *      missing export anywhere in the 2,800-line route module fails here
 *      immediately.
 *
 *   2. Route-registration smoke test — a handful of business-critical
 *      endpoints (audio config, analytics, channels, transmissions,
 *      knowledge base ingest, app-update) must remain mounted with the
 *      correct HTTP verbs. Catches accidental deletion or method changes
 *      in a refactor.
 *
 *   3. Live request tests for `GET /v1/audio/config`. This is the exact
 *      handler PR #151 fixed; pinning its observable contract through a
 *      real Express stack proves both that the file compiles and that the
 *      handler is wired to the right middleware:
 *        - No bearer token → 401 from `requireAgencyMember`.
 *        - Platform owner (no agencyId) → 403 (must not leak agency-scoped
 *          data to cross-tenant owners).
 *        - Agency member but no `DATABASE_URL` → 503 `database_unavailable`
 *          (graceful degradation, not a 500 crash that would surface as a
 *          handset boot loop).
 *
 * The route's body logic — derivation of the device-facing summary from
 * the stored AudioLabConfig — is covered by `audioConfig.test.ts` and
 * `audioConfigDerive.test.ts`; this file only exercises the wiring around
 * it, which is what the merge artifact actually broke.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter } from "../src/apiRoutes.js";
import { authenticate, signToken, type AuthUser } from "../src/auth.js";
import { clearAuthCache, setCachedAuth } from "../src/sessionCache.js";

/**
 * Build a one-shot Express app that mounts the production router at `/v1`
 * with the same `authenticate` middleware the real server uses. Returns a
 * `fetch`-friendly base URL plus a teardown the test can defer.
 */
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

/** Mint a token for a synthetic user without going through the DB-backed login flow. */
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

test("createApiRouter: module loads and the router constructs without throwing", () => {
  // The PR #151 merge artifact in apiRoutes.ts was a hard syntax/import
  // error — no existing test triggered the import, so the broken file
  // passed `npm test`. Loading the module here is the trip-wire for that
  // class of regression.
  const router = createApiRouter();
  assert.ok(router, "createApiRouter() must return a Router instance");
  assert.equal(typeof router, "function", "express.Router is a callable middleware");
});

test("createApiRouter: business-critical routes stay registered with the expected verbs", () => {
  // If any of these routes silently disappear in a refactor, handsets or
  // the dispatch console break in production with no test failure. Pin
  // the verb + path explicitly — `endsWith` so we tolerate any future
  // versioning prefix shift, but the path tail must match exactly.
  const router = createApiRouter();
  // Express's internal Router uses an array of "layers"; each layer with a
  // `.route` corresponds to a `router.METHOD(path, …)` call.
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

  const required = [
    // PR #151 — the route the merge artifact broke.
    "GET /audio/config",
    "PUT /admin/audio-config",
    // High-blast-radius read paths the dispatch console polls.
    "GET /analytics/summary",
    "GET /analytics/timeseries",
    "GET /analytics/channels",
    "GET /me/channels",
    // Public, unauthenticated handset / CI paths — accidental removal
    // would break the sideloaded Android self-update path.
    "GET /app/android/version",
    "GET /app/android/apk",
    "POST /app/android/publish",
    // Inbound CAD webhook — silent removal would drop incident creation.
    "POST /webhooks/10-8",
    // Recordings list + transcript search — `q`/`search` cap is enforced
    // inside the handler; the smoke-level guarantee is that the verb is
    // GET (not POST) so the existing dispatcher console keeps working.
    "GET /transmissions",
    // Audio Lab presets (per-agency named AudioLabConfig snapshots) — four
    // additive routes that must stay wired through any future refactor of
    // the audio-config block. Losing any one of them strands every saved
    // preset in the agency.
    "GET /admin/audio-lab-presets",
    "GET /admin/audio-lab-presets/:name",
    "PUT /admin/audio-lab-presets/:name",
    "DELETE /admin/audio-lab-presets/:name",
    // AI dispatch toggle — the pro-tier-gated entry point that drives the
    // `agencyAllowsAiDispatch` check. Silent deletion would mean an admin
    // could no longer turn AI dispatch on or off from the console.
    "POST /channels/ai-dispatch",
  ];
  for (const route of required) {
    assert.ok(
      registered.has(route),
      `expected ${route} to be registered (got ${registered.size} routes total)`,
    );
  }
});

test("GET /v1/audio/config: rejects unauthenticated requests with 401", async () => {
  // `requireAgencyMember` gates the handler; without a bearer token there
  // is no `req.authUser` and the route MUST refuse with 401. A regression
  // that accidentally drops the middleware would expose the handler to
  // anonymous callers and either leak agency config or crash.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/audio/config`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
  }
});

test("GET /v1/audio/config: rejects platform-owner tokens (no agencyId) with 403", async () => {
  // Platform owners manage tenants — they must not be able to read the
  // audio config of any specific agency. `requireAgencyMember` enforces
  // this by checking `agencyId != null`. Pin the contract so a future
  // "let owners read everything" change has to consciously update this
  // test rather than silently weakening the tenant boundary.
  //
  // We pre-seed the session cache so the router-level "is this account
  // still enabled?" middleware doesn't try to hit Postgres (which is
  // unavailable in this test process) before our route's `requireAgencyMember`
  // gate has a chance to run.
  clearAuthCache();
  const ownerUserId = 9_999_001;
  setCachedAuth(ownerUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: ownerUserId,
      role: "owner",
      agencyId: null,
      agencyName: null,
    });
    const res = await fetch(`${baseUrl}/v1/audio/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "forbidden");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/billing/status: superseded admin token is rejected before billing handlers", async () => {
  // Regression test for billing router ordering: billing endpoints must pass
  // through the same token-generation enforcement middleware as all other
  // authenticated routes. If this regresses, a stale admin token can still
  // open billing actions after a newer login supersedes it.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_010;
  // Cache says current generation is 1 while the token below carries gen=0.
  setCachedAuth(adminUserId, {
    tokenGeneration: 1,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "session_superseded");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("GET /v1/billing/status: disabled user account is rejected before billing handlers", async () => {
  // Companion regression test for billing router ordering. The fix that
  // motivated this test moved `router.use(createBillingRouter())` to AFTER
  // the disabled-account/superseded-session enforcement middleware. Before
  // the fix, an admin whose user row had been disabled (e.g. by an agency
  // admin in the console, or by the platform owner) could still hit
  // /v1/billing/* until their JWT expired — including `POST /billing/portal`
  // and `POST /billing/checkout`, which is precisely the surface a former
  // admin should NOT be able to drive.
  //
  // Pin the contract: cache says the user is disabled → all authenticated
  // billing endpoints must return 401 `account_disabled` before the
  // billing router's own handlers run. If billing ever gets re-mounted
  // above the disable middleware (or the cache check drops the
  // `userDisabled` branch), this test fails.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_011;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: true,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "account_disabled");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("GET /v1/billing/status: disabled agency is rejected before billing handlers", async () => {
  // Same ordering invariant, but for the agency-disabled branch. When an
  // agency is hard-disabled (deleted by the platform owner, or wound down
  // for non-billing reasons), every authenticated request from that
  // tenant — including /billing/* — must surface the 403 `agency_disabled`
  // signal so the console can show the right "agency offline" UI instead
  // of letting an admin keep hammering Stripe-backed endpoints with a
  // tenant that no longer exists.
  //
  // The cached agencyDisabled path is the hot path on the request flow
  // (Postgres unavailable in this test process), so we seed the cache
  // directly. A regression that re-mounted billing above this middleware
  // would let the request reach `requireAdmin` → handler and either crash
  // or 503, both of which would be observable here as a non-403 status.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_012;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: true,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/billing/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "agency_disabled");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/signup/verify-email: public signup endpoint stays reachable without auth", async () => {
  // The billing router is mounted AFTER the auth-enforcement middleware so
  // authenticated billing routes pass through the disabled/superseded
  // gates. The same router ALSO carries the unauthenticated public-signup
  // endpoints (POST /signup/verify-email and POST /signup) — these must
  // continue to work for callers without a JWT, otherwise no new agency
  // can self-serve onboarding through the marketing site.
  //
  // The router-level middleware short-circuits with `if (auth == null)
  // next();` so anonymous callers fall through to the billing router. A
  // regression that dropped that short-circuit (or mounted the billing
  // router above `authenticate`) would either return 401 here or never
  // even reach the handler. We assert the handler's own 400 contract for
  // an empty/invalid email to prove the public path is intact.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "" }),
    });
    // The critical signal is: NOT 401. A 401 would mean the billing
    // router got accidentally placed behind a `requireAuth`-style gate.
    assert.notEqual(res.status, 401, "public signup must not require auth");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_email");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/signup: public signup endpoint stays reachable without auth", async () => {
  // Sibling of the verify-email check above: the second of the two public
  // billing endpoints. Validates the unauthenticated path reaches the
  // handler (which returns 400 `terms_required` when accept_terms is
  // missing) rather than being intercepted by the auth-enforcement
  // middleware. Pinning both endpoints individually means a future
  // refactor that moves only one of them behind auth still trips a test.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agency_name: "Test Agency",
        admin_username: "admin",
        admin_password: "pw",
        email: "ops@example.com",
        verification_code: "123456",
        plan_tier: "basic",
        // accept_terms intentionally omitted to trigger the early
        // `terms_required` branch; this keeps the assertion deterministic
        // without a Stripe / DB / SMTP dependency.
      }),
    });
    assert.notEqual(res.status, 401, "public signup must not require auth");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "terms_required");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("GET /v1/audio/config: agency member with no DATABASE_URL → 503, not a crash", async () => {
  // The handler reads `getGlobalAudioConfig` which throws
  // `database_unavailable` when DATABASE_URL is unset (dev / CI default).
  // The `fail()` helper must translate that into a clean 503 so a handset
  // gets a recoverable error rather than the server logging a 500 stack
  // trace on every poll. A regression that returns 500 here would spam
  // logs and trigger health-check alerts in staging.
  //
  // Pre-seed the session cache for the same reason as above: we want the
  // request to reach the audio-config handler so we observe the handler's
  // 503 (not the auth middleware's 503).
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_002;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/audio/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("PUT /v1/admin/audio-lab-presets/:name: validates the URL name before any DB call", async () => {
  // Name validation runs BEFORE `requirePool()`, so a malformed name returns
  // 400 even when no Postgres is configured. This proves the validator is
  // wired ahead of the DB read — a future refactor that swapped the order
  // would let "../etc/passwd" or "" leak through to the store layer.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_003;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    // "default" is reserved (see audioLabPresets.ts) — must 400.
    const res = await fetch(`${baseUrl}/v1/admin/audio-lab-presets/default`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ preImbe: {}, postDecode: {}, vocoder: {} }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_name");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("PUT /v1/admin/audio-lab-presets/:name: validates the body shape before any DB call", async () => {
  // The body must be the same `{ preImbe, postDecode, vocoder }` shape the
  // existing PUT /v1/admin/audio-config expects. A malformed body returns
  // 400, regardless of DB availability, so a partial JSON push can never
  // sneak into the agency preset catalog.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_004;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const res = await fetch(`${baseUrl}/v1/admin/audio-lab-presets/Patrol`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // Missing `postDecode` + `vocoder`.
      body: JSON.stringify({ preImbe: {} }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_fields");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("GET /v1/admin/audio-lab-presets: requires admin role (dispatcher gets 403)", async () => {
  // The /admin/* surface is admin-only — a dispatcher token is an agency
  // member but lacks admin, so the route must refuse with 403 BEFORE
  // touching Postgres. Catches a future "let dispatchers list things too"
  // tweak from accidentally widening write access along with read.
  clearAuthCache();
  const dispatcherUserId = 9_999_005;
  setCachedAuth(dispatcherUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: dispatcherUserId,
      agencyId: 42,
      role: "dispatcher",
    });
    const res = await fetch(`${baseUrl}/v1/admin/audio-lab-presets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("authenticated requests under a cached `agencyDisabled` row carry the billing_suspend flag", async () => {
  // Regression test for the billing-suspension signal added alongside the
  // self-service Stripe flow. When an agency lapses (trial expired, payment
  // failed, subscription canceled) the auth middleware caches
  // `{ agencyDisabled: true, billingSuspend: true }` for 15s. EVERY
  // subsequent authenticated request from that tenant must surface the
  // `billing_suspend: true` hint in its 403 body so the console can render
  // the "fix billing" banner instead of a generic "agency offline" UI.
  //
  // If a future refactor drops the `billing_suspend` field from the
  // cached-arm response (e.g. by switching back to a plain
  // `res.json({ error: "agency_disabled" })`), the dashboard UX silently
  // degrades from "actionable banner" to "you're locked out, call support".
  // Pin the field so that regression cannot ship.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_020;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: true,
    billingSuspend: true,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/me/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string; billing_suspend?: boolean };
    assert.equal(body.error, "agency_disabled");
    assert.equal(
      body.billing_suspend,
      true,
      "billing_suspend must propagate from the cached middleware arm",
    );
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("authenticated requests under a non-billing `agencyDisabled` row do NOT claim billing_suspend", async () => {
  // Sibling of the above — an agency hard-disabled by the platform owner
  // (not by a billing event) must NOT flag `billing_suspend: true`. If the
  // field ever defaulted to `true`, the console would render a "fix
  // billing" banner for tenants whose admins literally cannot fix the
  // problem (because their agency was wound down by the operator). Pin
  // the discrimination so the two states stay distinct end-to-end.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_021;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: true,
    // billingSuspend intentionally omitted — represents the legacy
    // "operator wound down the agency" case.
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/me/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string; billing_suspend?: boolean };
    assert.equal(body.error, "agency_disabled");
    assert.notEqual(
      body.billing_suspend,
      true,
      "non-billing-disabled agencies must not claim billing_suspend",
    );
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/channels/ai-dispatch: rejects requests with no channel name (input gate fires before DB)", async () => {
  // The AI-dispatch toggle reads `channel` from the body and 400s on a
  // blank/missing value before any store-layer call. Pin this so a future
  // refactor that swapped the order (DB call first, then validation)
  // doesn't 503 on a malformed request — and so a future addition of a
  // pro-tier gate can't accidentally short-circuit the input check.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_022;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/channels/ai-dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_channel");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/channels/ai-dispatch: refuses non-operator (radio) accounts with 403", async () => {
  // The route is gated by `requireAgencyOperator` — only `admin` and
  // `dispatcher` roles may toggle AI dispatch. A `radio` user (a regular
  // handset operator) must NOT be able to flip an entire channel into AI
  // dispatch mode for the agency. Pin the role gate so a future "let
  // anyone enable AI" tweak has to update this test.
  //
  // Send a fully valid body — the failure must come from the role check,
  // not the input validation.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const radioUserId = 9_999_023;
  setCachedAuth(radioUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: radioUserId, agencyId: 42, role: "radio", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/channels/ai-dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "Patrol", enabled: true }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "forbidden");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("radio handset token is exempt from session supersession", async () => {
  // Radio handsets are persistent shared devices ("stay signed in until manual
  // sign-out", no token expiry) and must NOT be kicked by "newest sign-in
  // wins" — otherwise the radio silently 401s on "SYNC FAILED" until a manual
  // re-login. The cache says the current generation is 1 while the radio token
  // carries gen=0; a non-radio token would 401 session_superseded here, but the
  // radio must pass auth and reach the route's role gate (403 forbidden).
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const radioUserId = 9_999_024;
  setCachedAuth(radioUserId, {
    tokenGeneration: 1,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: radioUserId, agencyId: 42, role: "radio", gen: 0 });
    const res = await fetch(`${baseUrl}/v1/channels/ai-dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "Patrol", mode: "off" }),
    });
    // Not superseded: auth passed and we hit the role gate instead.
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "forbidden");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("GET /v1/transmissions: tolerates an oversized search query without crashing", async () => {
  // The route slices the `search` param at 200 chars BEFORE handing it to
  // the store layer (which already escapes %, _, \ and parameterises the
  // ILIKE binding). With no Postgres we can't observe the query body, but
  // we can confirm the route doesn't 500 on a 5,000-char `search`: the
  // expected response is the same 503 `database_unavailable` agency
  // members see for the empty-q path. A future regression that forgot to
  // cap could blow the JSON parser before the 503 handler ran.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminUserId = 9_999_006;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin" });
    const giant = "x".repeat(5_000);
    const res = await fetch(
      `${baseUrl}/v1/transmissions?search=${encodeURIComponent(giant)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});
