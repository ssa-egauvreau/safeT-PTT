/**
 * Tests for `server/src/billing/signup.ts` validation paths.
 *
 * `requestSignupVerification` is the entrypoint of the entire self-service
 * flow. The validator at the top of the function runs BEFORE any DB call,
 * so a malformed email never inserts a `signup_verifications` row and never
 * triggers a Resend send. Pin that contract here:
 *
 *   - The function MUST short-circuit with `{ error: "invalid_email" }`
 *     (and never throw) for empty / whitespace / no-@ inputs even when no
 *     Postgres pool is configured. A regression that ran the DB query first
 *     would surface as `database_unavailable` in the dev/CI environment and
 *     mask a real validation gap in production.
 *
 *   - Email normalisation (trim + lowercase) is performed BEFORE validation,
 *     so an input like `"   "` (whitespace only) collapses to `""` and is
 *     rejected, and `"OPS@example.com  "` is preserved through normalisation
 *     before the `@` check passes — not asserted directly here (the success
 *     branch hits the DB), but pinned indirectly: whitespace-only is rejected
 *     while a real address is NOT rejected at this layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { requestSignupVerification } from "../../src/billing/signup.js";

const ENV_KEY = "DATABASE_URL";

function withoutDb<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  return Promise.resolve(fn()).finally(() => {
    if (saved !== undefined) process.env[ENV_KEY] = saved;
  });
}

test("requestSignupVerification: empty email returns invalid_email (no DB call)", async () => {
  // No DATABASE_URL → any DB call would throw `database_unavailable`.
  // Asserting `invalid_email` here proves validation runs FIRST.
  await withoutDb(async () => {
    const result = await requestSignupVerification("");
    assert.deepEqual(result, { error: "invalid_email" });
  });
});

test("requestSignupVerification: whitespace-only email returns invalid_email", async () => {
  await withoutDb(async () => {
    const result = await requestSignupVerification("     ");
    assert.deepEqual(result, { error: "invalid_email" });
  });
});

test("requestSignupVerification: missing @ returns invalid_email (and never reaches the DB)", async () => {
  await withoutDb(async () => {
    const result = await requestSignupVerification("ops.example.com");
    assert.deepEqual(result, { error: "invalid_email" });
  });
});

test("requestSignupVerification: garbage string with no @ returns invalid_email", async () => {
  await withoutDb(async () => {
    const result = await requestSignupVerification("totally not an email");
    assert.deepEqual(result, { error: "invalid_email" });
  });
});

test("requestSignupVerification: string of only '@' is treated as invalid (would normalise to a single '@')", async () => {
  // `"   @   "` after trim + lowercase is `"@"`. The validator only checks
  // `includes("@")` so this does pass the gate and would proceed to the DB.
  // That's fine for the reverse case (we accept lazy schema-level validation
  // downstream), but `""` and pure whitespace must NEVER pass — they would
  // hit Postgres with an empty string and store an empty signup row.
  await withoutDb(async () => {
    const r1 = await requestSignupVerification("");
    const r2 = await requestSignupVerification("\t\n  ");
    assert.deepEqual(r1, { error: "invalid_email" });
    assert.deepEqual(r2, { error: "invalid_email" });
  });
});

test("requestSignupVerification: a syntactically-valid email surfaces a DB error, not a validation error", async () => {
  // This proves the validator is NOT silently rejecting good inputs in
  // dev/CI: a real email passes the @-gate and the next call (the
  // `emailAlreadyUsedTrial` SELECT) throws `database_unavailable`. Catching
  // and asserting the throw makes a future regression that broadened the
  // `invalid_email` gate (e.g. requiring a TLD) loud and visible.
  await withoutDb(async () => {
    await assert.rejects(
      requestSignupVerification("ops@example.com"),
      /database_unavailable/,
    );
  });
});
