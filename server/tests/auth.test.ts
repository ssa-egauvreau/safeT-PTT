/**
 * Tests for `server/src/auth.ts`.
 *
 * Auth is the trust boundary for every console / admin / owner endpoint.
 * Three regression classes have direct security impact:
 *
 *  1. **JWT round-trip integrity.** A claim that drops, gets coerced to
 *     the wrong type, or silently changes role on the way out gives a
 *     compromised or stale token more authority than it was issued.
 *  2. **Role guards.** `requireAuth` / `requireAdmin` / `requireOwner`
 *     decide whether a request reaches a privileged handler. Loosening
 *     them by even one branch (e.g. accepting an admin without an
 *     `agencyId`) breaks multi-tenant isolation.
 *  3. **Password hashing.** `hashPassword` / `verifyPassword` must
 *     cleanly handle the two common error paths (wrong password,
 *     malformed hash) without throwing — anything that bubbles up out
 *     of bcrypt becomes a 500 on /login or /provision.
 *
 * `JWT_SECRET` is read once at module load, so this file sets it BEFORE
 * the import — that way every signed token in the test uses a known,
 * deterministic key.
 */

// `auth.ts` reads JWT_SECRET once at module-evaluation time, so it must be
// set BEFORE the auth module is imported. ES `import` statements are hoisted
// above any top-level code, so we can't set the env var "above" the import
// the way the source ordering suggests — a dynamic import is the reliable
// fix.
process.env.JWT_SECRET =
  "test-secret-deterministic-do-not-use-in-production-0123456789abcdef";

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

const {
  authenticate,
  hashPassword,
  requireAdmin,
  requireAuth,
  requireOwner,
  signToken,
  verifyPassword,
  verifyToken,
  TOKEN_TTL_SECONDS,
} = await import("../src/auth.js");

import type { AuthUser, Role } from "../src/auth.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function userFor(role: Role, overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 42,
    username: "carol",
    displayName: "Carol Dispatcher",
    role,
    unitId: role === "radio" ? "27-040" : null,
    agencyId: role === "owner" ? null : 7,
    agencyName: role === "owner" ? null : "Test Agency",
    gen: 1,
    ...overrides,
  };
}

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function mockReq(headers: Record<string, string> = {}): {
  authUser?: AuthUser;
  header(name: string): string | undefined;
} {
  return {
    header(name: string) {
      const lc = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lc) return v;
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test("hashPassword + verifyPassword: round-trip on a typical password", async () => {
  const hash = await hashPassword("hunter2");
  assert.match(hash, /^\$2[aby]\$/, "must be a bcrypt-formatted hash");
  assert.notEqual(hash, "hunter2", "hash must never equal cleartext");
  assert.equal(await verifyPassword("hunter2", hash), true);
});

test("verifyPassword: rejects the wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("incorrect horse battery staple", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("verifyPassword: returns false on a malformed hash (does NOT throw)", async () => {
  // bcrypt.compare throws on garbage; the wrapper catches that so a corrupt
  // DB row can never crash the /login route. Without this, a single bad row
  // takes down the whole sign-in flow with a 500.
  assert.equal(await verifyPassword("anything", "not-a-bcrypt-hash"), false);
  assert.equal(await verifyPassword("anything", ""), false);
});

test("hashPassword: same input produces a different hash each time (salted)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b, "bcrypt salts must make repeated hashes unique");
  // Both still verify against the same cleartext.
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

// ---------------------------------------------------------------------------
// signToken / verifyToken
// ---------------------------------------------------------------------------

test("signToken / verifyToken: round-trips every claim for a console user", () => {
  const user = userFor("dispatcher");
  const token = signToken(user);
  const decoded = verifyToken(token);
  assert.ok(decoded, "verifyToken must return a user");
  assert.deepEqual(decoded, user);
});

test("signToken / verifyToken: round-trips a radio handset (unit id, agency, gen)", () => {
  const user = userFor("radio", {
    unitId: "27-040",
    gen: 7,
  });
  const token = signToken(user);
  const decoded = verifyToken(token);
  assert.ok(decoded);
  assert.equal(decoded.role, "radio");
  assert.equal(decoded.unitId, "27-040");
  assert.equal(decoded.agencyId, 7);
  assert.equal(decoded.gen, 7);
});

test("signToken / verifyToken: round-trips a platform owner with null agency", () => {
  // Owners are agency-less by design — the token must preserve null
  // (NOT coerce to 0 or undefined) so requireOwner / requireAdmin can
  // make the right decision on the next request.
  const owner = userFor("owner");
  const token = signToken(owner);
  const decoded = verifyToken(token);
  assert.ok(decoded);
  assert.equal(decoded.role, "owner");
  assert.equal(decoded.agencyId, null);
  assert.equal(decoded.agencyName, null);
});

test("verifyToken: console / admin / owner tokens carry an `exp` claim (TOKEN_TTL_SECONDS)", () => {
  // Console-style tokens must expire so a stolen / lost session can't
  // live forever.
  for (const role of ["dispatcher", "admin", "owner"] as const) {
    const token = signToken(userFor(role));
    const claims = jwt.decode(token) as Record<string, number> | null;
    assert.ok(claims, `${role} token must decode`);
    assert.ok(claims.exp != null, `${role} token must carry an exp claim`);
    assert.ok(claims.iat != null, `${role} token must carry an iat claim`);
    const lifetime = claims.exp - claims.iat;
    assert.equal(
      lifetime,
      TOKEN_TTL_SECONDS,
      `${role} lifetime must equal TOKEN_TTL_SECONDS (${TOKEN_TTL_SECONDS})`,
    );
  }
});

test("verifyToken: radio tokens are issued WITHOUT an exp claim (handsets stay signed in)", () => {
  // Radios sign in once and stay signed in until the user explicitly
  // signs out — a regression that adds an `expiresIn` here boots every
  // active handset off the network on the TTL boundary, which is a
  // safety-of-life issue in the field.
  const token = signToken(userFor("radio"));
  const claims = jwt.decode(token) as Record<string, unknown> | null;
  assert.ok(claims);
  assert.equal(claims.exp, undefined, "radio token must not have an exp claim");
});

test("verifyToken: rejects a token signed with the wrong secret", () => {
  const user = userFor("dispatcher");
  const goodToken = signToken(user);
  // Re-sign the same claims with a different secret — must fail.
  const decoded = jwt.decode(goodToken) as Record<string, unknown> | null;
  assert.ok(decoded);
  delete decoded.iat;
  delete decoded.exp;
  const evilToken = jwt.sign(decoded, "different-secret-that-is-not-the-server-secret");
  assert.equal(verifyToken(evilToken), null);
});

test("verifyToken: rejects a structurally invalid / garbage token", () => {
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("not.a.jwt"), null);
  assert.equal(verifyToken("totally garbage"), null);
});

test("verifyToken: an unknown role string narrows to 'radio' (least-privileged default)", () => {
  // A token whose `role` claim is neither owner / admin / dispatcher /
  // radio (e.g. forged, or written by an older signer) must NOT short-
  // circuit any of the role guards. Silently treating "superuser" as a
  // valid role would be a privilege-escalation vector.
  const forged = jwt.sign(
    { uid: 1, un: "x", dn: "x", role: "superuser", aid: 1, gen: 0 },
    process.env.JWT_SECRET,
  );
  const decoded = verifyToken(forged);
  assert.ok(decoded);
  assert.equal(decoded.role, "radio");
});

test("verifyToken: a missing `gen` claim defaults to 0 (legacy-token compatibility)", () => {
  // PR adding token_generation backfilled all DB rows with 0; any token
  // issued before the field existed must continue to work without
  // booting the user out.
  const legacyToken = jwt.sign(
    { uid: 1, un: "x", dn: "x", role: "dispatcher", aid: 1 },
    process.env.JWT_SECRET,
  );
  const decoded = verifyToken(legacyToken);
  assert.ok(decoded);
  assert.equal(decoded.gen, 0);
});

test("verifyToken: missing optional claims default to null (not undefined / 'undefined')", () => {
  // The bare-minimum claim set — verify that downstream callers see
  // sensible nulls instead of the JS coercion fallout of `String(undefined)`.
  const minimal = jwt.sign(
    { uid: 5, role: "owner" },
    process.env.JWT_SECRET,
  );
  const decoded = verifyToken(minimal);
  assert.ok(decoded);
  assert.equal(decoded.id, 5);
  assert.equal(decoded.unitId, null);
  assert.equal(decoded.agencyId, null);
  assert.equal(decoded.agencyName, null);
  assert.equal(decoded.username, "");
  assert.equal(decoded.displayName, "");
});

// ---------------------------------------------------------------------------
// authenticate middleware
// ---------------------------------------------------------------------------

test("authenticate: a valid bearer token populates req.authUser", () => {
  const user = userFor("admin");
  const token = signToken(user);
  const req = mockReq({ authorization: `Bearer ${token}` });
  let calledNext = false;
  authenticate(req as never, mockRes() as never, () => {
    calledNext = true;
  });
  assert.equal(calledNext, true);
  assert.ok(req.authUser, "req.authUser must be set");
  assert.equal(req.authUser!.id, user.id);
  assert.equal(req.authUser!.role, "admin");
});

test("authenticate: case-insensitive scheme (BEARER / bearer / Bearer) all work", () => {
  // Some older browsers / fetch shims send lower-case scheme names.
  const token = signToken(userFor("dispatcher"));
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    const req = mockReq({ authorization: `${scheme} ${token}` });
    authenticate(req as never, mockRes() as never, () => undefined);
    assert.ok(req.authUser, `scheme ${scheme} must populate authUser`);
  }
});

test("authenticate: missing / non-Bearer / invalid token leaves authUser undefined and still calls next", () => {
  // The middleware never short-circuits — it just enriches the request.
  // The actual gating is requireAuth / requireAdmin / requireOwner.
  const cases = [
    {},
    { authorization: "" },
    { authorization: "Basic Y2Fyb2w6aHVudGVyMg==" },
    { authorization: "Bearer not.a.real.jwt" },
    { authorization: "Bearer " }, // empty token after the scheme
  ];
  for (const headers of cases) {
    const req = mockReq(headers);
    let calledNext = false;
    authenticate(req as never, mockRes() as never, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true, "next must always be called");
    assert.equal(req.authUser, undefined, "authUser must not be set");
  }
});

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

test("requireAuth: no authUser → 401 and next is NOT called", () => {
  const req = { authUser: undefined } as never;
  const res = mockRes();
  let calledNext = false;
  requireAuth(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
  assert.equal(calledNext, false);
});

test("requireAuth: any role passes when authUser is present", () => {
  for (const role of ["owner", "admin", "dispatcher", "radio"] as const) {
    const req = { authUser: userFor(role) } as never;
    const res = mockRes();
    let calledNext = false;
    requireAuth(req, res as never, () => {
      calledNext = true;
    });
    assert.equal(res.statusCode, null, `role ${role} must not have status set`);
    assert.equal(calledNext, true, `role ${role} must reach next`);
  }
});

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

test("requireAdmin: no authUser → 401", () => {
  const req = { authUser: undefined } as never;
  const res = mockRes();
  let calledNext = false;
  requireAdmin(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
  assert.equal(calledNext, false);
});

test("requireAdmin: non-admin roles are rejected with 403", () => {
  for (const role of ["owner", "dispatcher", "radio"] as const) {
    const req = { authUser: userFor(role) } as never;
    const res = mockRes();
    let calledNext = false;
    requireAdmin(req, res as never, () => {
      calledNext = true;
    });
    assert.equal(res.statusCode, 403, `role ${role} must be 403`);
    assert.deepEqual(res.body, { error: "forbidden" });
    assert.equal(calledNext, false);
  }
});

test("requireAdmin: an admin without an agencyId is rejected with 403 (agency scoping is mandatory)", () => {
  // An agency admin must always be tied to an agency — without one,
  // there's no tenant to scope the admin endpoints to. The route must
  // refuse rather than fall through to a "global admin" path.
  const req = { authUser: userFor("admin", { agencyId: null }) } as never;
  const res = mockRes();
  let calledNext = false;
  requireAdmin(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(calledNext, false);
});

test("requireAdmin: an admin scoped to an agency reaches next()", () => {
  const req = { authUser: userFor("admin", { agencyId: 7 }) } as never;
  const res = mockRes();
  let calledNext = false;
  requireAdmin(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, null);
  assert.equal(calledNext, true);
});

// ---------------------------------------------------------------------------
// requireOwner
// ---------------------------------------------------------------------------

test("requireOwner: no authUser → 401", () => {
  const req = { authUser: undefined } as never;
  const res = mockRes();
  let calledNext = false;
  requireOwner(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, 401);
  assert.equal(calledNext, false);
});

test("requireOwner: every non-owner role is rejected with 403 (incl. agency admin)", () => {
  // Crucial: an agency admin must NOT be able to hit owner-only routes
  // (agency provisioning across all tenants).
  for (const role of ["admin", "dispatcher", "radio"] as const) {
    const req = { authUser: userFor(role) } as never;
    const res = mockRes();
    let calledNext = false;
    requireOwner(req, res as never, () => {
      calledNext = true;
    });
    assert.equal(res.statusCode, 403, `role ${role} must be 403 on owner route`);
    assert.equal(calledNext, false);
  }
});

test("requireOwner: an owner reaches next()", () => {
  const req = { authUser: userFor("owner") } as never;
  const res = mockRes();
  let calledNext = false;
  requireOwner(req, res as never, () => {
    calledNext = true;
  });
  assert.equal(res.statusCode, null);
  assert.equal(calledNext, true);
});
