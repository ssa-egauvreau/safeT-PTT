/**
 * Regression tests for the JWT signing / verification path in
 * `server/src/auth.ts`.
 *
 * These tokens are the primary trust gate for every authenticated request
 * on the platform — a console operator's drag-drop, an admin's user list,
 * an owner's per-agency provisioning, and the radio handsets that talk
 * over the relay all flow through `verifyToken(bearerToken(req))`. The
 * sign/verify pair is therefore a single-byte-of-blast-radius surface;
 * a regression that silently drops a claim, miscoerces a type, or relaxes
 * the role allow-list does NOT throw — it just hands the next request
 * the wrong identity.
 *
 * The properties pinned here are non-obvious enough to be easy to break:
 *
 *   1. Round-trip — every documented AuthUser field survives sign → verify
 *      with the right type, including `null` for unitId / agencyId /
 *      agencyName (those nulls are load-bearing — the API uses them to
 *      decide owner-vs-tenant routing).
 *
 *   2. Newest-sign-in-wins — the `gen` claim is part of the token. A bug
 *      that strips it would silently let every old session keep working
 *      after a password change / forced sign-out.
 *
 *   3. Backwards-compatibility — pre-existing tokens issued before the
 *      `gen` claim was added must parse as `gen: 0` (matching the default
 *      value on the `users.token_generation` column at deploy time).
 *      Without this, a rolling deploy would sign every active console
 *      session out the moment the new server picked up the request.
 *
 *   4. Radio handsets have NO expiry; console / admin / owner sessions
 *      DO expire (12h). Inverting either of these is a real-world
 *      incident: handsets in patrol vehicles can't re-authenticate at
 *      4am on a county road, and indefinite admin sessions are exactly
 *      the lapse the 12h TTL was added to prevent.
 *
 *   5. Tampered / unsigned / wrong-secret tokens MUST return null, not
 *      throw — the auth middleware does not wrap verifyToken in a
 *      try/catch.
 *
 *   6. Unknown roles collapse to "radio" (the most-restricted role)
 *      rather than being passed through. Defense-in-depth: an attacker
 *      who forged a token with `role: "superuser"` and bypassed the
 *      signature check elsewhere should still land in the least-
 *      privileged bucket.
 */

// Side-effect import — must come before ../../src/auth.js so the JWT
// secret is pinned before the module captures it.
import "./_setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import {
  TOKEN_TTL_SECONDS,
  signToken,
  verifyToken,
  type AuthUser,
} from "../../src/auth.js";

const SECRET = process.env.JWT_SECRET!;

function userOf(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 42,
    username: "alice",
    displayName: "Alice Anderson",
    role: "admin",
    unitId: "U-1",
    agencyId: 7,
    agencyName: "Sunset Safety",
    gen: 3,
    ...over,
  };
}

test("signToken → verifyToken round-trips every documented AuthUser field", () => {
  const original = userOf();
  const out = verifyToken(signToken(original));
  assert.deepEqual(out, original);
});

test("verifyToken preserves null on unitId, agencyId, and agencyName", () => {
  // Platform `owner` accounts have agencyId / agencyName / unitId = null;
  // a regression that string-coerced them would land "null" in headers /
  // logs and break the owner-vs-tenant branch in the API layer.
  const owner = userOf({
    role: "owner",
    unitId: null,
    agencyId: null,
    agencyName: null,
  });
  const out = verifyToken(signToken(owner));
  assert.equal(out!.unitId, null);
  assert.equal(out!.agencyId, null);
  assert.equal(out!.agencyName, null);
});

test("verifyToken preserves the `gen` claim (newest-sign-in-wins gate)", () => {
  // bumpTokenGeneration() increments users.token_generation on every login;
  // the middleware later compares it against this claim. Strip the claim
  // and every previously-logged-in device silently keeps working forever.
  const out = verifyToken(signToken(userOf({ gen: 17 })));
  assert.equal(out!.gen, 17);
});

test("verifyToken defaults missing `gen` to 0 (backwards-compat with pre-gen tokens)", () => {
  // Mint a token by hand without the gen claim — simulates a token issued
  // by the deployed server before the `gen` field existed. After the
  // rolling deploy that introduced gen, those tokens must keep verifying
  // as gen=0 (which is also the default DB column value), otherwise every
  // console operator gets bounced to the login page mid-deploy.

  const raw = jwt.sign(
    {
      uid: 1,
      un: "legacy",
      dn: "Legacy User",
      role: "admin",
      unit: null,
      aid: 1,
      an: "A",
      // no `gen` claim
    },
    SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  );
  const out = verifyToken(raw);
  assert.ok(out, "legacy token without gen must still verify");
  assert.equal(out!.gen, 0);
});

test("radio tokens are issued WITHOUT an expiry; console tokens DO expire", () => {
  // Decoding the token without verifying gives us access to the claims
  // (`exp` is set by jsonwebtoken at sign time). Handsets stay signed in
  // forever; console sessions get the 12h ceiling so a lost dispatch
  // login can't live forever.
  const radio = jwt.decode(signToken(userOf({ role: "radio" }))) as {
    exp?: number;
    iat?: number;
  };
  assert.equal(radio.exp, undefined, "radio token must have no expiry");

  const admin = jwt.decode(signToken(userOf({ role: "admin" }))) as {
    exp?: number;
    iat?: number;
  };
  assert.ok(admin.exp != null && admin.iat != null);
  assert.equal(
    admin.exp! - admin.iat!,
    TOKEN_TTL_SECONDS,
    "admin token must expire after exactly TOKEN_TTL_SECONDS",
  );

  for (const role of ["owner", "dispatcher"] as const) {
    const decoded = jwt.decode(signToken(userOf({ role }))) as { exp?: number; iat?: number };
    assert.ok(decoded.exp != null, `role ${role} must have an expiry`);
    assert.equal(decoded.exp! - decoded.iat!, TOKEN_TTL_SECONDS);
  }
});

test("verifyToken returns null on a tampered payload (does NOT throw)", () => {
  // The middleware path is: `const user = verifyToken(token); if (user) ...`
  // — a throw would 500 instead of silently rejecting, so verifyToken
  // MUST catch its own JWT errors.
  const tok = signToken(userOf());
  const parts = tok.split(".");
  // Flip a character in the signature so the verify fails. The token is
  // still well-formed shape-wise.
  const bad = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
  assert.equal(verifyToken(bad), null);
});

test("verifyToken returns null on garbage / wrong-secret / empty strings", () => {
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken("not.a.jwt"), null);
  assert.equal(verifyToken("garbage"), null);
  // A token signed with a different secret must not verify.
  const foreign = jwt.sign({ uid: 1 }, "some-other-secret", { expiresIn: 600 });
  assert.equal(verifyToken(foreign), null);
});

test("verifyToken collapses an unknown role to 'radio' (defense-in-depth)", () => {
  // Even if some future code path landed a bogus role string in a
  // token (or an attacker bypassed the signature check), the verifier
  // must hand the rest of the system the most-restricted role so the
  // role gates downstream still hold.

  const raw = jwt.sign(
    {
      uid: 1,
      un: "x",
      dn: "X",
      role: "superuser", // not in ROLE_VALUES
      unit: null,
      aid: 1,
      an: "A",
      gen: 0,
    },
    SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  );
  const out = verifyToken(raw);
  assert.ok(out);
  assert.equal(out!.role, "radio");
});

test("verifyToken returns null on an expired admin token", () => {
  // Pin the 12h TTL behaviour explicitly — a regression that signed
  // admins with no expiry (the radio path) is exactly the kind of
  // copy-paste mistake the test should catch.

  const expired = jwt.sign(
    {
      uid: 1,
      un: "admin",
      dn: "Admin",
      role: "admin",
      unit: null,
      aid: 1,
      an: "A",
      gen: 0,
    },
    SECRET,
    { expiresIn: -10 }, // already expired
  );
  assert.equal(verifyToken(expired), null);
});

test("signToken uses the compact claim names (wire format pinning)", () => {
  // The compact claim names (uid, un, dn, role, unit, aid, an, gen) are
  // load-bearing because tokens are persisted in localStorage across
  // deploys — renaming `uid` to `userId` would break every existing
  // session on the next deploy.
  const decoded = jwt.decode(signToken(userOf())) as Record<string, unknown>;
  for (const key of ["uid", "un", "dn", "role", "unit", "aid", "an", "gen"]) {
    assert.ok(key in decoded, `claim "${key}" must be present in the wire token`);
  }
});

test("verifyToken coerces stringified numeric ids back to numbers", () => {
  // Some jsonwebtoken middleware in front of us has historically rewritten
  // numeric claims as strings. The verifier compensates by coercing —
  // assert that "7" survives as 7 (not "7"), since `agencyId === 7`
  // checks downstream are strict.

  const stringy = jwt.sign(
    {
      uid: "9",
      un: "x",
      dn: "X",
      role: "admin",
      unit: "U-1",
      aid: "7",
      an: "A",
      gen: "2",
    },
    SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  );
  const out = verifyToken(stringy);
  assert.ok(out);
  assert.equal(out!.id, 9);
  assert.equal(out!.agencyId, 7);
  assert.equal(out!.gen, 2);
});
