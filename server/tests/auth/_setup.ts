// Test-only setup: pin JWT_SECRET BEFORE the auth module is first imported
// so the closure-captured secret is deterministic and known to the tests.
//
// auth.ts captures `process.env.JWT_SECRET` at module-evaluation time. Tests
// that need to forge a token with a specific claim shape (e.g. simulate a
// pre-`gen` legacy token, or assert role-allowlist defense-in-depth) need
// access to the same secret the production verifier will use. Importing
// this module before `../../src/auth.js` guarantees the secret is set.
//
// Importing this file is a no-op if some earlier import already set the
// secret — the test deliberately keeps that already-configured value to
// stay compatible with future CI that may bake one in.

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length === 0) {
  process.env.JWT_SECRET = "deterministic-test-secret-not-for-production-use";
}
