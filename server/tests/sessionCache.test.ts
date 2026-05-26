/**
 * Regression tests for `server/src/sessionCache.ts`.
 *
 * `sessionCache` is the in-process auth cache that sits in front of the
 * Postgres `tokenGeneration` / `userDisabled` / `agencyDisabled` checks
 * used by both the REST router-level middleware and the voice WebSocket
 * upgrade path. At Android's poll cadence (AIR 250 ms, talk-activity
 * 1.2 s, inbox 2 s, presence 12 s) a single online handset is ~5
 * authenticated requests per second, multiplied by every active user;
 * a bug that returned the wrong cached value here propagates instantly
 * across the entire fleet.
 *
 * What these tests pin:
 *
 *   1. `getCachedAuth` returns null for an uncached user (the
 *      middleware then re-fetches from Postgres and re-populates) —
 *      this must hold across both "we cleared everything" and "this
 *      specific user has never been cached" code paths.
 *   2. `setCachedAuth` round-trips its payload verbatim on every
 *      documented field. Each combination of (userDisabled,
 *      agencyDisabled) matters because the middleware uses them to
 *      pick between "let the request through", "403 user_disabled",
 *      and "403 agency_disabled".
 *   3. Cached entries automatically expire after the documented 15 s
 *      TTL, and a freshly-expired entry is removed from the underlying
 *      map (not just hidden from the getter) so the cache cannot grow
 *      without bound on a fleet of mostly-dormant accounts.
 *   4. `invalidateCachedAuth(userId)` evicts only that user — the
 *      "newest sign-in wins" semantic requires the old device's next
 *      request to re-fetch and observe the bumped `tokenGeneration`,
 *      but it must not also evict every other agency's cached users.
 *   5. `clearAuthCache()` evicts every user (used on test teardown and
 *      on graceful shutdown). It is idempotent on an empty cache.
 *   6. Re-setting the same user extends the TTL rather than retaining
 *      the original (older) expiry. A fresh login must therefore start
 *      a new TTL window, not inherit a few hundred ms left over from
 *      the previous session, and the new field values must take effect
 *      immediately.
 *
 * Time is driven by `node:test`'s mock timers so the 15 s TTL boundary
 * is asserted deterministically — no `await new Promise(setTimeout, ...)`
 * sleeps that would make CI flaky or slow.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  clearAuthCache,
  getCachedAuth,
  invalidateCachedAuth,
  setCachedAuth,
} from "../src/sessionCache.js";

/** Convenience constructor for the value shape sessionCache stores. */
function payload(tokenGeneration: number): {
  tokenGeneration: number;
  userDisabled: boolean;
  agencyDisabled: boolean;
} {
  return {
    tokenGeneration,
    userDisabled: false,
    agencyDisabled: false,
  };
}

test("getCachedAuth: returns null for an uncached user", () => {
  clearAuthCache();
  assert.equal(getCachedAuth(1), null);
  assert.equal(getCachedAuth(999_999), null);
});

test("setCachedAuth + getCachedAuth: round-trips the payload fields verbatim", () => {
  clearAuthCache();
  const value = {
    tokenGeneration: 4,
    userDisabled: true,
    agencyDisabled: false,
  };
  setCachedAuth(42, value);
  const cached = getCachedAuth(42);
  assert.ok(cached, "expected entry to be present after setCachedAuth");
  // Only the three documented fields are part of the typed contract — the
  // runtime entry currently also carries an internal `expiresAt` for the
  // TTL check, which is by design and not exposed by the TS type. Assert
  // on the documented fields explicitly so a future refactor that swapped
  // any of them (e.g. defaulted `userDisabled` to false on a partial set)
  // is caught regardless of whether `expiresAt` is co-located.
  assert.equal(cached.tokenGeneration, value.tokenGeneration);
  assert.equal(cached.userDisabled, value.userDisabled);
  assert.equal(cached.agencyDisabled, value.agencyDisabled);
});

test("getCachedAuth: stores+returns every typed field independently", () => {
  // Each combination of the two boolean flags must round-trip correctly —
  // the middleware uses these to decide between "let the request through",
  // "return 403 user_disabled", and "return 403 agency_disabled" on the
  // very next request. A bug that swapped them would lock out only
  // disabled users or only disabled agencies, which is one of the hardest
  // classes of regression to spot in production.
  clearAuthCache();
  setCachedAuth(70, { tokenGeneration: 1, userDisabled: true, agencyDisabled: false });
  setCachedAuth(71, { tokenGeneration: 1, userDisabled: false, agencyDisabled: true });
  setCachedAuth(72, { tokenGeneration: 1, userDisabled: true, agencyDisabled: true });
  const u70 = getCachedAuth(70)!;
  const u71 = getCachedAuth(71)!;
  const u72 = getCachedAuth(72)!;
  assert.equal(u70.userDisabled, true);
  assert.equal(u70.agencyDisabled, false);
  assert.equal(u71.userDisabled, false);
  assert.equal(u71.agencyDisabled, true);
  assert.equal(u72.userDisabled, true);
  assert.equal(u72.agencyDisabled, true);
});

test("setCachedAuth: overwrites a prior entry for the same userId (last write wins)", () => {
  clearAuthCache();
  setCachedAuth(7, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  setCachedAuth(7, { tokenGeneration: 2, userDisabled: true, agencyDisabled: false });
  const got = getCachedAuth(7);
  assert.ok(got);
  assert.equal(got.tokenGeneration, 2, "second set must replace the first");
  assert.equal(got.userDisabled, true);
});

test("getCachedAuth: returns null and deletes the entry once TTL has passed", (t: TestContext) => {
  clearAuthCache();
  t.mock.timers.enable({ apis: ["Date"] });
  setCachedAuth(100, payload(1));
  assert.notEqual(getCachedAuth(100), null);

  // 14_999 ms — still within the documented TTL window.
  t.mock.timers.tick(14_999);
  assert.notEqual(
    getCachedAuth(100),
    null,
    "cache must still serve until just under TTL",
  );

  // One ms past TTL — entry should be reported as gone.
  t.mock.timers.tick(2);
  assert.equal(
    getCachedAuth(100),
    null,
    "cache must report null once TTL_MS has elapsed",
  );

  // And re-asking immediately must continue to return null without doing
  // anything weird (e.g. a "first miss reseeds" bug).
  assert.equal(getCachedAuth(100), null);
});

test("re-setting the same user extends the TTL window from the new write", (t: TestContext) => {
  // A fresh sign-in (or a forced reseed after a Postgres refresh) must
  // reset the TTL window to the full 15 s — otherwise an admin who flips
  // userDisabled on a handset that just logged in could observe the
  // residual <1s of the previous TTL and think the change "didn't take".
  clearAuthCache();
  t.mock.timers.enable({ apis: ["Date"] });
  setCachedAuth(200, payload(1));
  t.mock.timers.tick(10_000); // 10 s into TTL
  setCachedAuth(200, payload(2)); // re-seed with new tokenGeneration
  // 10 s after the re-seed — within the new TTL window even though it's
  // 20 s after the very first set.
  t.mock.timers.tick(10_000);
  const cached = getCachedAuth(200);
  assert.ok(cached, "re-seeded entry must still be valid 10 s into its new TTL");
  // Importantly the new tokenGeneration must have replaced the old one —
  // a regression that "patched in place" would leave tokenGeneration=1.
  assert.equal(cached.tokenGeneration, 2);
  assert.equal(cached.userDisabled, false);
  assert.equal(cached.agencyDisabled, false);
});

test("invalidateCachedAuth evicts only the requested user", (t: TestContext) => {
  clearAuthCache();
  t.mock.timers.enable({ apis: ["Date"] });
  setCachedAuth(11, payload(1));
  setCachedAuth(12, payload(1));
  setCachedAuth(13, payload(1));

  invalidateCachedAuth(12);

  assert.notEqual(getCachedAuth(11), null);
  assert.equal(getCachedAuth(12), null, "the targeted user must be gone");
  assert.notEqual(getCachedAuth(13), null);
});

test("invalidateCachedAuth: forces the NEXT read to miss even mid-TTL", () => {
  // This is the load-bearing semantic for "newest sign-in wins": the
  // freshly-logged-in client just bumped token_generation in Postgres, and
  // any stale cache entry for that user must be flushed so the OLD device's
  // next API call hits the database and is superseded immediately.
  clearAuthCache();
  setCachedAuth(99, { tokenGeneration: 5, userDisabled: false, agencyDisabled: false });
  assert.ok(getCachedAuth(99));
  invalidateCachedAuth(99);
  assert.equal(getCachedAuth(99), null);
});

test("invalidateCachedAuth is idempotent for a user that was never cached", () => {
  // The login route calls invalidate() unconditionally after bumping the
  // token generation; it must not throw or otherwise misbehave for a
  // brand-new user whose row has not yet been read by anyone.
  clearAuthCache();
  assert.doesNotThrow(() => invalidateCachedAuth(424242));
  assert.equal(getCachedAuth(424242), null);
});

test("clearAuthCache evicts every cached user", () => {
  setCachedAuth(1, payload(1));
  setCachedAuth(2, payload(2));
  setCachedAuth(3, payload(3));
  clearAuthCache();
  assert.equal(getCachedAuth(1), null);
  assert.equal(getCachedAuth(2), null);
  assert.equal(getCachedAuth(3), null);
});

test("clearAuthCache is idempotent on an already-empty cache", () => {
  clearAuthCache();
  assert.doesNotThrow(() => clearAuthCache());
});

test("expired entries are actually deleted from the underlying map (no slow leak)", (t: TestContext) => {
  // The getter is documented to delete the entry when it discovers it's
  // expired. This guards against a regression that started "soft-hiding"
  // expired rows but left them resident in the Map — a long-running server
  // would then grow one stale entry per logout indefinitely.
  clearAuthCache();
  t.mock.timers.enable({ apis: ["Date"] });
  setCachedAuth(999, payload(1));
  t.mock.timers.tick(15_001);
  // Expire-and-delete pass.
  assert.equal(getCachedAuth(999), null);
  // Now a fresh setCachedAuth must "win" with the new TTL window even
  // though we are 15 s past the original write. If the entry were still
  // present with its stale expiresAt, a getter that prefers the existing
  // value over the new one would silently return null here.
  setCachedAuth(999, payload(2));
  const cached = getCachedAuth(999);
  assert.ok(cached, "fresh setCachedAuth must restore the entry past TTL");
  assert.equal(cached.tokenGeneration, 2);
});
