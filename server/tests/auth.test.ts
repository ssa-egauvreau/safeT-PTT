/**
 * Tests for `server/src/auth.ts`.
 *
 * Why this module needs tight regression coverage
 * -----------------------------------------------
 * `auth.ts` is the single trust boundary for every authenticated request the
 * server services — REST handlers, the WebSocket voice relay (which calls
 * `verifyToken` directly on the handset's bearer token at upgrade time), and
 * the platform owner portal. A silent regression here doesn't just degrade a
 * UX path; it either:
 *
 *   - lets a previously-signed-out radio token continue to relay voice
 *     (token_generation check uses the `gen` claim that {@link verifyToken}
 *     extracts), or
 *   - grants tenant-admin-shaped requests to a `radio`-role token (the
 *     `requireAdmin` / `requireOwner` guards are the only thing standing
 *     between `/v1/admin/*` and the public internet), or
 *   - silently signs every active session out on every redeploy (the
 *     production-mode JWT_SECRET guard prevents the random-secret fallback
 *     from booting at all).
 *
 * The tests below pin:
 *   1. `signToken`/`verifyToken` round-trip for every documented role and for
 *      a full set of optional claim shapes (null / missing / numeric coercion).
 *   2. `verifyToken` returns null (never throws) on every adversarial token
 *      shape we expect to see in the wild: bad signature, wrong-key signature,
 *      garbage, empty, expired non-radio token.
 *   3. Radio tokens are issued *without* an `exp` claim; admin/owner/dispatch
 *      tokens carry the 12h TTL.
 *   4. `hashPassword` / `verifyPassword` round-trip + the
 *      "garbage hash returns false instead of throwing" property.
 *   5. The four middlewares (`authenticate`, `requireAuth`, `requireAdmin`,
 *      `requireOwner`) for the full status-code matrix the API depends on,
 *      including the admin-must-have-an-agency rule that the agency-scoped
 *      admin routes silently assume.
 *
 * JWT_SECRET notes
 * ----------------
 * `auth.ts` reads `JWT_SECRET` at *module import time* — we set a deterministic
 * one here before the dynamic import so the signature is reproducible across
 * runs and we can verify cross-secret tokens are rejected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "auth-test-secret-do-not-use-in-prod";
process.env.NODE_ENV = "test";

const auth = await import("../src/auth.js");
const {
  TOKEN_TTL_SECONDS,
  authenticate,
  hashPassword,
  requireAdmin,
  requireAuth,
  requireOwner,
  signToken,
  verifyPassword,
  verifyToken,
} = auth;
type AuthUser = import("../src/auth.js").AuthUser;

const baseAdmin: AuthUser = {
  id: 42,
  username: "alice",
  displayName: "Alice Admin",
  role: "admin",
  unitId: null,
  agencyId: 7,
  agencyName: "City PD",
  gen: 3,
};

const baseRadio: AuthUser = {
  id: 99,
  username: "27-040",
  displayName: "Unit 27-040",
  role: "radio",
  unitId: "27-040",
  agencyId: 7,
  agencyName: "City PD",
  gen: 1,
};

const baseOwner: AuthUser = {
  id: 1,
  username: "root",
  displayName: "Platform Owner",
  role: "owner",
  unitId: null,
  // Platform owners cross tenants — agencyId stays null. The middleware tests
  // below pin that this is fine for requireOwner but blocks requireAdmin.
  agencyId: null,
  agencyName: null,
  gen: 0,
};

const baseDispatcher: AuthUser = {
  id: 12,
  username: "dispatch1",
  displayName: "Dispatcher 1",
  role: "dispatcher",
  unitId: null,
  agencyId: 7,
  agencyName: "City PD",
  gen: 2,
};

// ===== signToken / verifyToken round-trip ===============================

test("signToken/verifyToken: round-trips an admin token with every field intact", () => {
  const token = signToken(baseAdmin);
  const decoded = verifyToken(token);
  assert.deepEqual(decoded, baseAdmin);
});

test("signToken/verifyToken: round-trips a dispatcher token", () => {
  const decoded = verifyToken(signToken(baseDispatcher));
  assert.deepEqual(decoded, baseDispatcher);
});

test("signToken/verifyToken: round-trips a radio token (no exp claim)", () => {
  const token = signToken(baseRadio);
  const decoded = verifyToken(token);
  assert.deepEqual(decoded, baseRadio);
  // Decode without verifying so we can inspect raw claims.
  const raw = jwt.decode(token) as Record<string, unknown>;
  assert.equal(
    raw.exp,
    undefined,
    "radio tokens must never carry an exp — handsets stay signed in until manual sign-out",
  );
});

test("signToken/verifyToken: round-trips an owner token (agencyId null)", () => {
  const decoded = verifyToken(signToken(baseOwner));
  assert.deepEqual(decoded, baseOwner);
});

test("signToken: non-radio tokens carry a 12h exp", () => {
  const token = signToken(baseAdmin);
  const raw = jwt.decode(token) as { exp?: number; iat?: number };
  assert.ok(typeof raw.exp === "number", "non-radio tokens must have an exp");
  assert.ok(typeof raw.iat === "number");
  // jwt.sign rounds iat/exp to whole seconds; allow ±2s for the test runner
  // clock so this stays deterministic.
  const ttl = raw.exp! - raw.iat!;
  assert.ok(
    Math.abs(ttl - TOKEN_TTL_SECONDS) <= 2,
    `expected ~${TOKEN_TTL_SECONDS}s TTL, got ${ttl}s`,
  );
});

// ===== verifyToken: defensive parsing ===================================

test("verifyToken: returns null on a token signed with a different secret", () => {
  const foreign = jwt.sign({ uid: 1, role: "admin" }, "some-other-secret");
  assert.equal(verifyToken(foreign), null);
});

test("verifyToken: returns null on a malformed token", () => {
  assert.equal(verifyToken("not.a.jwt"), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("Bearer "), null);
});

test("verifyToken: returns null on an expired non-radio token (does NOT throw)", () => {
  const token = jwt.sign(
    { uid: 1, un: "x", dn: "X", role: "admin", unit: null, aid: 1, an: "A", gen: 0 },
    process.env.JWT_SECRET!,
    { expiresIn: -10 },
  );
  assert.equal(verifyToken(token), null);
});

test("verifyToken: an unknown role downgrades to 'radio' instead of throwing", () => {
  // Defensive: a forged or future-version token must never crash the request
  // pipeline. Downgrading to 'radio' is the safest fallback because the
  // require* middlewares all explicitly reject anything that isn't the role
  // they expect.
  const token = jwt.sign(
    { uid: 5, un: "x", dn: "X", role: "superadmin", unit: null, aid: null, an: null, gen: 0 },
    process.env.JWT_SECRET!,
  );
  const decoded = verifyToken(token);
  assert.equal(decoded?.role, "radio");
});

test("verifyToken: missing role defaults to 'radio' (least-privileged)", () => {
  const token = jwt.sign(
    { uid: 5, un: "x", dn: "X", unit: null, aid: null, an: null, gen: 0 },
    process.env.JWT_SECRET!,
  );
  const decoded = verifyToken(token);
  assert.equal(decoded?.role, "radio");
});

test("verifyToken: missing `gen` claim parses as 0 (back-compat with pre-token_generation tokens)", () => {
  // The comment in auth.ts is explicit: tokens issued before the gen claim
  // existed parse as 0, matching the column default at deploy time. If this
  // regresses to NaN or undefined, every pre-existing token bricks at the
  // session-superseded check.
  const token = jwt.sign(
    { uid: 5, un: "x", dn: "X", role: "admin", unit: null, aid: 7, an: "A" },
    process.env.JWT_SECRET!,
  );
  const decoded = verifyToken(token);
  assert.equal(decoded?.gen, 0);
});

test("verifyToken: numerically coerces string uid / aid / gen (back-compat with stringy claims)", () => {
  const token = jwt.sign(
    {
      uid: "42",
      un: "alice",
      dn: "Alice",
      role: "admin",
      unit: null,
      aid: "7",
      an: "City PD",
      gen: "3",
    },
    process.env.JWT_SECRET!,
  );
  const decoded = verifyToken(token);
  assert.equal(decoded?.id, 42);
  assert.equal(decoded?.agencyId, 7);
  assert.equal(decoded?.gen, 3);
});

test("verifyToken: keeps unitId/agencyId/agencyName null when the claim is null", () => {
  // Owner tokens have unitId=null and agencyId=null — make sure null is
  // preserved verbatim instead of being coerced to the string "null" or 0.
  const decoded = verifyToken(signToken(baseOwner));
  assert.equal(decoded?.unitId, null);
  assert.equal(decoded?.agencyId, null);
  assert.equal(decoded?.agencyName, null);
});

test("verifyToken: omitted optional claims also parse as null", () => {
  // jwt.sign drops undefined fields silently, so the verify side must treat
  // "missing" the same as "explicitly null".
  const token = jwt.sign(
    { uid: 5, un: "x", dn: "X", role: "admin", gen: 1 },
    process.env.JWT_SECRET!,
  );
  const decoded = verifyToken(token);
  assert.equal(decoded?.unitId, null);
  assert.equal(decoded?.agencyId, null);
  assert.equal(decoded?.agencyName, null);
});

// ===== hashPassword / verifyPassword ====================================

test("hashPassword/verifyPassword: round-trips an arbitrary password", async () => {
  const hash = await hashPassword("hunter2");
  assert.ok(hash.startsWith("$2"), "hash should be a bcrypt-prefixed string");
  assert.equal(await verifyPassword("hunter2", hash), true);
});

test("verifyPassword: rejects the wrong password", async () => {
  const hash = await hashPassword("hunter2");
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("verifyPassword: returns false (does not throw) on a garbage hash", async () => {
  // The login handler does `await verifyPassword(password, user.password_hash)`
  // and treats `false` as wrong-password. If a malformed hash row (from a
  // partial migration or a hand-edited DB) ever bubbled up an exception, the
  // login route would 500 instead of returning the generic "invalid
  // credentials" error.
  assert.equal(await verifyPassword("anything", "not-a-bcrypt-hash"), false);
  assert.equal(await verifyPassword("anything", ""), false);
});

// ===== middlewares ======================================================

interface CapturedRes {
  status?: number;
  body?: unknown;
}

function makeReq(headerValue?: string): import("express").Request {
  return {
    header(name: string) {
      return name.toLowerCase() === "authorization" ? headerValue : undefined;
    },
  } as unknown as import("express").Request;
}

function makeRes(): { res: import("express").Response; captured: CapturedRes } {
  const captured: CapturedRes = {};
  const res = {
    status(n: number) {
      captured.status = n;
      return this;
    },
    json(obj: unknown) {
      captured.body = obj;
      if (captured.status === undefined) captured.status = 200;
      return this;
    },
  } as unknown as import("express").Response;
  return { res, captured };
}

function makeNext(): {
  fn: import("express").NextFunction;
  state: { called: boolean };
} {
  const state = { called: false };
  const fn = (() => {
    state.called = true;
  }) as import("express").NextFunction;
  return { fn, state };
}

// ----- authenticate -----------------------------------------------------

test("authenticate: leaves req.authUser unset when no Authorization header is present", () => {
  const req = makeReq();
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  authenticate(req, res, fn);
  assert.equal(req.authUser, undefined);
  assert.equal(state.called, true);
  assert.equal(captured.status, undefined, "authenticate must NEVER send a response");
});

test("authenticate: leaves req.authUser unset when token is invalid; never rejects", () => {
  const req = makeReq("Bearer garbage.value.here");
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  authenticate(req, res, fn);
  assert.equal(req.authUser, undefined);
  assert.equal(state.called, true);
  assert.equal(captured.status, undefined);
});

test("authenticate: populates req.authUser on a valid Bearer token", () => {
  const token = signToken(baseAdmin);
  const req = makeReq(`Bearer ${token}`);
  const { res } = makeRes();
  const { fn, state } = makeNext();
  authenticate(req, res, fn);
  assert.equal(state.called, true);
  assert.deepEqual(req.authUser, baseAdmin);
});

test("authenticate: case-insensitive on the 'Bearer' scheme + trims surrounding whitespace", () => {
  // RFC 7235 requires the scheme to be case-insensitive; the handset clients
  // happen to send 'Bearer ' but the implementation must not break if a future
  // SDK sends 'bearer ' or 'BEARER  '.
  const token = signToken(baseAdmin);
  for (const header of [`bearer ${token}`, `BEARER ${token}`, `Bearer   ${token}   `]) {
    const req = makeReq(header);
    const { res } = makeRes();
    const { fn } = makeNext();
    authenticate(req, res, fn);
    assert.equal(
      req.authUser?.id,
      baseAdmin.id,
      `header "${header}" should still authenticate`,
    );
  }
});

test("authenticate: ignores a non-Bearer scheme (Basic, etc.)", () => {
  const req = makeReq("Basic dXNlcjpwYXNz");
  const { res } = makeRes();
  const { fn, state } = makeNext();
  authenticate(req, res, fn);
  assert.equal(req.authUser, undefined);
  assert.equal(state.called, true);
});

// ----- requireAuth ------------------------------------------------------

test("requireAuth: 401 when req.authUser is missing", () => {
  const req = makeReq();
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireAuth(req, res, fn);
  assert.equal(state.called, false, "next() must not be called on rejection");
  assert.equal(captured.status, 401);
  assert.deepEqual(captured.body, { error: "unauthorized" });
});

test("requireAuth: calls next() when req.authUser is present (any role)", () => {
  for (const user of [baseAdmin, baseRadio, baseDispatcher, baseOwner]) {
    const req = makeReq();
    req.authUser = user;
    const { res, captured } = makeRes();
    const { fn, state } = makeNext();
    requireAuth(req, res, fn);
    assert.equal(state.called, true, `role=${user.role} should pass requireAuth`);
    assert.equal(captured.status, undefined);
  }
});

// ----- requireAdmin -----------------------------------------------------

test("requireAdmin: 401 when no authUser is present", () => {
  const req = makeReq();
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireAdmin(req, res, fn);
  assert.equal(state.called, false);
  assert.equal(captured.status, 401);
});

test("requireAdmin: 403 for non-admin roles even when authenticated", () => {
  for (const role of ["radio", "dispatcher", "owner"] as const) {
    const req = makeReq();
    req.authUser = { ...baseAdmin, role };
    const { res, captured } = makeRes();
    const { fn, state } = makeNext();
    requireAdmin(req, res, fn);
    assert.equal(state.called, false, `role=${role} must not reach the handler`);
    assert.equal(captured.status, 403, `role=${role} → 403`);
    assert.deepEqual(captured.body, { error: "forbidden" });
  }
});

test("requireAdmin: 403 for an admin token with no agencyId (defensive — admin routes assume an agency)", () => {
  // Every admin handler in apiRoutes.ts dereferences req.authUser.agencyId
  // without re-checking it. If this guard regresses, those handlers either
  // crash on the null OR read another tenant's rows.
  const req = makeReq();
  req.authUser = { ...baseAdmin, agencyId: null };
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireAdmin(req, res, fn);
  assert.equal(state.called, false);
  assert.equal(captured.status, 403);
});

test("requireAdmin: passes for an admin token bound to an agency", () => {
  const req = makeReq();
  req.authUser = baseAdmin;
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireAdmin(req, res, fn);
  assert.equal(state.called, true);
  assert.equal(captured.status, undefined);
});

// ----- requireOwner -----------------------------------------------------

test("requireOwner: 401 when no authUser is present", () => {
  const req = makeReq();
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireOwner(req, res, fn);
  assert.equal(state.called, false);
  assert.equal(captured.status, 401);
});

test("requireOwner: 403 for every non-owner role, including admin", () => {
  // The owner portal can provision agencies across tenants — an agency admin
  // must not be able to call those endpoints even with a valid admin token.
  for (const role of ["radio", "dispatcher", "admin"] as const) {
    const req = makeReq();
    req.authUser = { ...baseOwner, role };
    const { res, captured } = makeRes();
    const { fn, state } = makeNext();
    requireOwner(req, res, fn);
    assert.equal(state.called, false, `role=${role} must not reach owner handler`);
    assert.equal(captured.status, 403);
  }
});

test("requireOwner: passes for an owner token even with no agencyId", () => {
  const req = makeReq();
  req.authUser = baseOwner;
  const { res, captured } = makeRes();
  const { fn, state } = makeNext();
  requireOwner(req, res, fn);
  assert.equal(state.called, true);
  assert.equal(captured.status, undefined);
});
