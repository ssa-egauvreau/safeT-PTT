/**
 * Tests for `server/src/billing/signup.ts`.
 *
 * The self-service signup endpoints in `routes.ts` are PUBLIC (no auth
 * required — that's the whole point of self-service). Anything that
 * accepts a request body straight from the open internet must validate
 * input BEFORE doing any DB or Stripe work; otherwise:
 *
 *  - A blank / malformed email would write garbage rows into
 *    `signup_verifications` and `agencies`.
 *  - A signup without `accept_terms=true` would create a paying tenant
 *    that never agreed to the Terms of Service — a real legal exposure.
 *
 * The two functions exported from `signup.ts` both fail their pure
 * validation checks BEFORE the first `requirePool()` call. Those are
 * the boundaries this test file pins; the DB-dependent happy path is
 * covered separately by the routes-level test plus production smoke.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  completeSignup,
  requestSignupVerification,
} from "../../src/billing/signup.js";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  // No DB available — every test in this file is meant to fail BEFORE
  // any DB call. If a refactor moves a DB call ahead of the validation,
  // the test will fail with `database_unavailable` and we'll see it.
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (ORIGINAL_DB_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DB_URL;
  }
});

// ---------------------------------------------------------------------------
// requestSignupVerification — public POST /v1/signup/verify-email
// ---------------------------------------------------------------------------

test("requestSignupVerification: rejects an empty email with 'invalid_email' (no DB call)", async () => {
  // A regression that called `emailAlreadyUsedTrial("")` first would
  // throw `database_unavailable` here. The fact that we get
  // `invalid_email` back proves the validator runs first.
  const result = await requestSignupVerification("");
  assert.deepEqual(result, { error: "invalid_email" });
});

test("requestSignupVerification: rejects a whitespace-only email", async () => {
  // The handler trims before validating, so "   " collapses to "" and
  // must also be rejected.
  const result = await requestSignupVerification("   ");
  assert.deepEqual(result, { error: "invalid_email" });
});

test("requestSignupVerification: rejects an email with no @ sign", async () => {
  // The validator is intentionally minimal — Stripe + Resend do their
  // own RFC validation — but it MUST at least reject input without an
  // @. Otherwise the verification email never sends and the row sits
  // in `signup_verifications` forever, blocking future legitimate
  // signups from the same key.
  const result = await requestSignupVerification("not-an-email");
  assert.deepEqual(result, { error: "invalid_email" });
});

test("requestSignupVerification: an email with @ progresses past validation (DB unavailable surfaces as a throw)", async () => {
  // Pin the boundary: as soon as the email is well-formed, the handler
  // tries to hit Postgres (`emailAlreadyUsedTrial`). With no DB this
  // throws `database_unavailable`, which is exactly what the route
  // wraps into a 503. A regression that returned `invalid_email` for a
  // valid-shaped address would make signup impossible.
  await assert.rejects(
    requestSignupVerification("admin@example.com"),
    /database_unavailable/,
  );
});

// ---------------------------------------------------------------------------
// completeSignup — public POST /v1/signup
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  agencyName: "Test Agency",
  adminUsername: "admin",
  adminDisplayName: "Test Admin",
  adminPassword: "hunter2hunter2",
  email: "admin@example.com",
  verificationCode: "123456",
  planTier: "basic" as const,
  acceptTerms: true,
};

test("completeSignup: rejects when acceptTerms is false (terms_required), before any DB call", async () => {
  // The Terms of Service checkbox on the signup form. Without an
  // explicit `true`, the server must refuse — the platform records
  // billing email + admin password, both of which require ToS consent.
  const result = await completeSignup({ ...VALID_INPUT, acceptTerms: false });
  assert.deepEqual(result, { error: "terms_required" });
});

test("completeSignup: rejects when acceptTerms is missing (undefined treated as false)", async () => {
  // A regression that used `!!input.acceptTerms` would still catch
  // missing, but a refactor to `input.acceptTerms !== false` would
  // silently flip undefined → allowed. Pin the strict-`!input` contract.
  const { acceptTerms: _drop, ...rest } = VALID_INPUT;
  const result = await completeSignup({
    ...rest,
    acceptTerms: undefined as unknown as boolean,
  });
  assert.deepEqual(result, { error: "terms_required" });
});

test("completeSignup: a non-boolean truthy 'acceptTerms' is NOT rejected at the terms gate (route layer is the strict-true enforcer)", async () => {
  // The route layer in `routes.ts` coerces `req.body.accept_terms === true`
  // before calling `completeSignup`, so the signup-layer check is just a
  // belt-and-suspenders `!input.acceptTerms`. Truthy strings slip past
  // this gate and the handler proceeds to `verifyCode` → DB. This test
  // pins WHICH layer enforces strict equality:
  //   - routes.ts MUST do `accept_terms === true` (covered in routes test)
  //   - signup.ts MUST NOT silently strengthen it to !== true (that
  //     would break any internal caller that legitimately wants to pass
  //     a coerced flag).
  // The reachable next step is `verifyCode()`, which throws
  // `database_unavailable` when no DB is configured. Pinning that here
  // proves the terms gate did NOT swallow a truthy string.
  await assert.rejects(
    completeSignup({
      ...VALID_INPUT,
      acceptTerms: "true" as unknown as boolean,
    }),
    /database_unavailable/,
  );
});

test("completeSignup: with acceptTerms=true, proceeds past validation (DB unavailable surfaces as a throw)", async () => {
  // Boundary check — the next step after the terms gate is
  // `verifyCode()`, which hits Postgres. Pin that the gate doesn't
  // also gate on DB availability.
  await assert.rejects(
    completeSignup(VALID_INPUT),
    /database_unavailable/,
  );
});
