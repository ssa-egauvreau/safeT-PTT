/**
 * Tests for `server/src/auth.ts`.
 *
 * `auth.ts` is the trust boundary every authenticated console + handset
 * request crosses. A regression here is hard to spot until the day a
 * dispatcher or platform-owner session is silently broken — or worse,
 * silently expanded.
 *
 * Properties pinned by this file:
 *
 *  1. **Token round-trip**: `signToken(u)` followed by `verifyToken` must
 *     return all of the user fields that downstream middleware reads
 *     (`role`, `agencyId`, `unitId`, `displayName`, `gen`, …).
 *
 *  2. **Tamper rejection**: A bit-flipped JWT, a JWT signed with the wrong
 *     secret, malformed input, or empty input must return `null` (NOT a
 *     half-populated user) — `requireAuth` keys off `req.authUser` truthiness,
 *     so a fabricated `{}` would let an unsigned request through.
 *
 *  3. **Role allow-listing**: A token whose `role` claim isn't one of the
 *     four documented roles must be downgraded to `radio` (the lowest
 *     privilege), not flow through verbatim. This is the only thing
 *     stopping a forged claim like `role:"superuser"` from being accepted
 *     by `requireOwner` after a future hypothetical secret leak.
 *
 *  4. **Legacy `gen` claim**: Tokens signed before the session-supersede
 *     feature shipped have no `gen` claim; verifyToken must surface them
 *     as `gen=0` so the DB-side `token_generation` check (default 0)
 *     doesn't silently invalidate every existing handset.
 *
 *  5. **Radio tokens never expire**: Console / admin / owner tokens carry
 *     `TOKEN_TTL_SECONDS`; radio handset tokens are signed without `exp`
 *     (a sign-out is the only revocation path). Both invariants matter
 *     because reversing them either kicks every handset off after 12 h
 *     or leaves a lost dispatcher login authenticated forever.
 *
 *  6. **Bearer parsing**: `authenticate` accepts `Bearer <token>` case-
 *     insensitively but rejects anything else (no `Basic`, no naked token,
 *     no token after a different scheme). Trims a trailing space so a
 *     copy-pasted header still works.
 *
 *  7. **Middleware authority**: `requireAuth` / `requireAdmin` /
 *     `requireOwner` enforce 401 vs 403 in the right order, demand an
 *     agency for `admin`, and never call `next()` on a denied request.
 *
 *  8. **Password hashing**: `verifyPassword` returns `false` (never throws)
 *     on a corrupt/garbage hash so the login route can keep timing-equal
 *     "invalid credentials" semantics without a 500 leaking which
 *     usernames exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

// auth.ts memoises a JWT secret at module load. Force a deterministic value so
// tokens we sign in one test can be verified in another test in the same
// process, and so the production-mode FATAL guard isn't exercised under tests.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-do-not-use-in-prod";

const {
  TOKEN_TTL_SECONDS,
  authenticate,
  hashPassword,
  isSessionSuperseded,
  requireAdmin,
  requireAuth,
  requireOwner,
  signToken,
  verifyPassword,
  verifyToken,
} = await import("../src/auth.js");
type AuthUser = Awaited<ReturnType<typeof verifyToken>>;

function baseUser(overrides: Partial<NonNullable<AuthUser>> = {}): NonNullable<AuthUser> {
  return {
    id: 17,
    username: "alice",
    displayName: "Alice Tester",
    role: "dispatcher",
    unitId: null,
    agencyId: 5,
    agencyName: "Demo PD",
    gen: 3,
    ...overrides,
  };
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return r;
}

function mockReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header(name: string) {
      return lower[name.toLowerCase()];
    },
    headers: lower,
  } as unknown as Request;
}

function spyNext(): NextFunction & { called: boolean; calledWith: unknown } {
  const fn: NextFunction & { called: boolean; calledWith: unknown } = ((arg?: unknown) => {
    fn.called = true;
    fn.calledWith = arg;
  }) as NextFunction & { called: boolean; calledWith: unknown };
  fn.called = false;
  fn.calledWith = undefined;
  return fn;
}

// ---------------------------------------------------------------------------
// signToken / verifyToken
// ---------------------------------------------------------------------------

test("signToken → verifyToken: round-trips every AuthUser field for a dispatcher", () => {
  const user = baseUser({
    role: "dispatcher",
    unitId: "D-12",
    agencyId: 99,
    agencyName: "Anytown FD",
    gen: 42,
  });
  const token = signToken(user);
  const got = verifyToken(token);
  assert.ok(got, "valid token must verify");
  assert.equal(got.id, user.id);
  assert.equal(got.username, user.username);
  assert.equal(got.displayName, user.displayName);
  assert.equal(got.role, user.role);
  assert.equal(got.unitId, user.unitId);
  assert.equal(got.agencyId, user.agencyId);
  assert.equal(got.agencyName, user.agencyName);
  assert.equal(got.gen, user.gen);
});

test("signToken → verifyToken: preserves null unitId / agencyId / agencyName for owner accounts", () => {
  // Platform owners are not scoped to an agency — verifyToken must surface
  // the absent claims as `null`, not coerce them to "" / 0.
  const owner = baseUser({
    role: "owner",
    unitId: null,
    agencyId: null,
    agencyName: null,
  });
  const got = verifyToken(signToken(owner));
  assert.ok(got);
  assert.equal(got.unitId, null);
  assert.equal(got.agencyId, null);
  assert.equal(got.agencyName, null);
  assert.equal(got.role, "owner");
});

test("verifyToken: rejects an empty / garbage / truncated token", () => {
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("not-a-jwt"), null);
  assert.equal(verifyToken("a.b.c"), null);
  // Last-segment tampering invalidates the signature.
  const good = signToken(baseUser());
  const tampered = good.slice(0, -2) + (good.endsWith("A") ? "B" : "A");
  assert.equal(verifyToken(tampered), null);
});

test("verifyToken: rejects a token signed with a different secret", () => {
  // Critical: the auth module memoised its secret on import; an attacker
  // who knows the JWT shape but not the secret must not produce a usable
  // token even if they replay a believable claim set.
  const forged = jwt.sign(
    { uid: 1, un: "intruder", role: "owner", aid: null, gen: 0 },
    "different-secret",
  );
  assert.equal(verifyToken(forged), null);
});

test("verifyToken: rejects an expired non-radio token", () => {
  // Sign with `exp` already in the past so jsonwebtoken throws TokenExpiredError.
  const expired = jwt.sign(
    { uid: 1, un: "alice", dn: "A", role: "dispatcher", aid: 1, an: "X", gen: 1, exp: 0 },
    process.env.JWT_SECRET as string,
  );
  assert.equal(verifyToken(expired), null);
});

test("verifyToken: an unknown role claim is downgraded to 'radio' (allow-list)", () => {
  // If a forged or future token shows up with an unrecognised role,
  // the verifier MUST fall back to the lowest-privilege role rather than
  // pass the claim through verbatim — `requireAdmin` and `requireOwner`
  // both compare role to a fixed string.
  const weird = jwt.sign(
    { uid: 1, un: "x", role: "superuser", aid: 1, gen: 0 },
    process.env.JWT_SECRET as string,
  );
  const got = verifyToken(weird);
  assert.ok(got);
  assert.equal(got.role, "radio", "unknown roles must collapse to radio");
});

test("verifyToken: missing `gen` claim parses as 0 (legacy-token compatibility)", () => {
  // Tokens signed before the session-supersede feature shipped have no
  // `gen` claim. The DB-side comparison is against the user row's
  // `token_generation`, which defaults to 0; surfacing missing-as-0 is
  // what keeps existing handsets logged in across the upgrade.
  const legacy = jwt.sign(
    { uid: 1, un: "x", dn: "X", role: "radio", unit: "U-1", aid: 1, an: "X" },
    process.env.JWT_SECRET as string,
  );
  const got = verifyToken(legacy);
  assert.ok(got);
  assert.equal(got.gen, 0);
});

test("verifyToken: missing optional claims surface as documented defaults", () => {
  const minimal = jwt.sign(
    { uid: 7, role: "radio" },
    process.env.JWT_SECRET as string,
  );
  const got = verifyToken(minimal);
  assert.ok(got);
  assert.equal(got.id, 7);
  assert.equal(got.username, "");
  assert.equal(got.displayName, "");
  assert.equal(got.role, "radio");
  assert.equal(got.unitId, null);
  assert.equal(got.agencyId, null);
  assert.equal(got.agencyName, null);
  assert.equal(got.gen, 0);
});

test("signToken: radio tokens are issued WITHOUT an exp claim (handsets stay logged in)", () => {
  const radio = baseUser({ role: "radio", unitId: "U-9" });
  const token = signToken(radio);
  const decoded = jwt.decode(token) as Record<string, unknown> | null;
  assert.ok(decoded);
  assert.equal(decoded.exp, undefined, "radio tokens must not include exp");
  assert.equal(decoded.role, "radio");
});

test("signToken: console roles get a 12 h expiry (TOKEN_TTL_SECONDS)", () => {
  for (const role of ["owner", "admin", "dispatcher"] as const) {
    const u = baseUser({ role });
    const decoded = jwt.decode(signToken(u)) as Record<string, unknown>;
    const iat = Number(decoded.iat);
    const exp = Number(decoded.exp);
    assert.ok(Number.isFinite(iat) && Number.isFinite(exp), `${role}: iat/exp present`);
    assert.equal(exp - iat, TOKEN_TTL_SECONDS, `${role}: exp-iat must equal TOKEN_TTL_SECONDS`);
  }
  assert.equal(TOKEN_TTL_SECONDS, 12 * 60 * 60, "12h is the documented console session length");
});

// ---------------------------------------------------------------------------
// authenticate() bearer parsing
// ---------------------------------------------------------------------------

test("authenticate: populates req.authUser when a valid Bearer token is present", () => {
  const user = baseUser({ id: 555, role: "admin" });
  const token = signToken(user);
  const req = mockReq({ authorization: `Bearer ${token}` });
  const next = spyNext();
  authenticate(req, mockRes() as unknown as Response, next);
  assert.equal(next.called, true);
  assert.equal(next.calledWith, undefined, "authenticate must pass next() with no error");
  assert.ok(req.authUser, "valid bearer must populate authUser");
  assert.equal(req.authUser.id, 555);
  assert.equal(req.authUser.role, "admin");
});

test("authenticate: parsing is case-insensitive on the scheme name ('bearer ', 'BEARER ', etc.)", () => {
  const token = signToken(baseUser());
  for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
    const req = mockReq({ authorization: `${scheme} ${token}` });
    const next = spyNext();
    authenticate(req, mockRes() as unknown as Response, next);
    assert.ok(req.authUser, `scheme "${scheme}" should be accepted`);
  }
});

test("authenticate: leaves req.authUser unset when header is missing or malformed", () => {
  const cases: Record<string, string> = {
    "no header": "",
    "wrong scheme": `Basic ${Buffer.from("u:p").toString("base64")}`,
    "no scheme": `${signToken(baseUser())}`,
    "empty bearer": "Bearer ",
    "bearer + invalid token": "Bearer not-a-jwt",
  };
  for (const [label, value] of Object.entries(cases)) {
    const req = mockReq(value ? { authorization: value } : {});
    const next = spyNext();
    authenticate(req, mockRes() as unknown as Response, next);
    assert.equal(next.called, true, `${label}: next() must always be called`);
    assert.equal(req.authUser, undefined, `${label}: must not authenticate`);
  }
});

test("authenticate: never throws even when header is wildly malformed", () => {
  // A handset sending corrupt bytes must not 500 the API; the middleware
  // is documented as "never rejects" and just leaves authUser unset.
  const req = mockReq({ authorization: "Bearer \u0000\u0001 \u00ff" });
  const next = spyNext();
  assert.doesNotThrow(() =>
    authenticate(req, mockRes() as unknown as Response, next),
  );
  assert.equal(req.authUser, undefined);
  assert.equal(next.called, true);
});

// ---------------------------------------------------------------------------
// isSessionSuperseded — "newest sign-in wins", with the radio exemption
// ---------------------------------------------------------------------------

test("isSessionSuperseded: console roles are superseded when the token generation is stale", () => {
  // A dispatcher/admin/owner token whose `gen` is older than the user row's
  // current generation has been replaced by a newer sign-in and must be
  // rejected (REST → 401 session_superseded, voice WS → 401 Unauthorized).
  for (const role of ["owner", "admin", "dispatcher"] as const) {
    assert.equal(isSessionSuperseded(role, 1, 2), true, `${role}: stale gen → superseded`);
    assert.equal(isSessionSuperseded(role, 5, 5), false, `${role}: matching gen → not superseded`);
  }
});

test("isSessionSuperseded: radio handsets are NEVER superseded, even with a stale generation", () => {
  // The bug this pins: a handset whose generation went stale (the same radio
  // account signed in on the console or another handset) must keep BOTH its
  // REST session AND its voice WebSocket. Before the fix the REST path exempted
  // radio but the voice upgrade handler did not, so audio died after every
  // re-sign-in elsewhere until a manual log-out/log-in.
  assert.equal(isSessionSuperseded("radio", 1, 2), false, "stale gen must not supersede a handset");
  assert.equal(isSessionSuperseded("radio", 0, 999), false, "any gap must not supersede a handset");
  assert.equal(isSessionSuperseded("radio", 7, 7), false, "matching gen is obviously fine");
  // A legacy radio token (gen 0) against a bumped row must still hold.
  assert.equal(isSessionSuperseded("radio", 0, 3), false, "legacy gen-0 handset stays signed in");
});

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

test("requireAuth: returns 401 when no authUser is set", () => {
  const req = mockReq();
  const res = mockRes();
  const next = spyNext();
  requireAuth(req, res as unknown as Response, next);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
  assert.equal(next.called, false, "must not call next() on rejection");
});

test("requireAuth: calls next() exactly once when authUser is present", () => {
  const req = mockReq();
  req.authUser = baseUser({ role: "dispatcher" });
  const res = mockRes();
  const next = spyNext();
  requireAuth(req, res as unknown as Response, next);
  assert.equal(next.called, true);
  assert.equal(res.statusCode, 200, "must not have written a status");
});

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

test("requireAdmin: 401 with no authUser, 403 with wrong role, 200/next on admin+agencyId", () => {
  // 401 unauth.
  {
    const req = mockReq();
    const res = mockRes();
    const next = spyNext();
    requireAdmin(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 401);
    assert.equal(next.called, false);
  }
  // 403 dispatcher.
  {
    const req = mockReq();
    req.authUser = baseUser({ role: "dispatcher" });
    const res = mockRes();
    const next = spyNext();
    requireAdmin(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "forbidden" });
    assert.equal(next.called, false);
  }
  // 403 admin without an agency (a misconfigured admin row must not
  // be allowed to manage "anything" globally).
  {
    const req = mockReq();
    req.authUser = baseUser({ role: "admin", agencyId: null });
    const res = mockRes();
    const next = spyNext();
    requireAdmin(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 403);
    assert.equal(next.called, false);
  }
  // 403 owner (owner is a SEPARATE privilege, not a superset of admin —
  // the platform-owner portal is the only thing that should accept owner
  // tokens; agency-admin endpoints must not).
  {
    const req = mockReq();
    req.authUser = baseUser({ role: "owner", agencyId: null });
    const res = mockRes();
    const next = spyNext();
    requireAdmin(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 403);
    assert.equal(next.called, false);
  }
  // 200 admin + agency.
  {
    const req = mockReq();
    req.authUser = baseUser({ role: "admin", agencyId: 7 });
    const res = mockRes();
    const next = spyNext();
    requireAdmin(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 200);
    assert.equal(next.called, true);
  }
});

// ---------------------------------------------------------------------------
// requireOwner
// ---------------------------------------------------------------------------

test("requireOwner: 401 unauth, 403 for any non-owner role, next() only for owner", () => {
  // 401 unauth.
  {
    const req = mockReq();
    const res = mockRes();
    const next = spyNext();
    requireOwner(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 401);
    assert.equal(next.called, false);
  }
  // 403 every non-owner role (admin must NOT pass — agency admins are
  // intentionally walled off from cross-tenant provisioning).
  for (const role of ["admin", "dispatcher", "radio"] as const) {
    const req = mockReq();
    req.authUser = baseUser({ role, agencyId: 1 });
    const res = mockRes();
    const next = spyNext();
    requireOwner(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 403, `${role}: must be 403`);
    assert.equal(next.called, false);
  }
  // 200 owner.
  {
    const req = mockReq();
    req.authUser = baseUser({ role: "owner", agencyId: null });
    const res = mockRes();
    const next = spyNext();
    requireOwner(req, res as unknown as Response, next);
    assert.equal(res.statusCode, 200);
    assert.equal(next.called, true);
  }
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword (bcrypt)
// ---------------------------------------------------------------------------

test("hashPassword + verifyPassword: round-trip a correct password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.notEqual(hash, "correct-horse-battery-staple", "must not store plaintext");
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
});

test("verifyPassword: returns false (does NOT throw) when the hash is malformed", async () => {
  // bcrypt throws on a non-bcrypt string. The login route relies on this
  // returning `false` so it can keep its 401 timing-equal between
  // "no such user" and "wrong password" without needing a try/catch
  // around every call site.
  for (const bad of ["", "plaintext", "not-a-bcrypt-hash", "$2a$10$tooShort"]) {
    assert.equal(
      await verifyPassword("anything", bad),
      false,
      `bad hash "${bad}" must return false, not throw`,
    );
  }
});

test("verifyPassword: rejects a wrong password against a real hash", async () => {
  const hash = await hashPassword("right");
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});
