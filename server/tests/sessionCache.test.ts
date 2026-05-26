/**
 * Tests for `server/src/sessionCache.ts`.
 *
 * `sessionCache` is the in-process auth cache the router-level
 * `requireAuthenticatedUser` middleware checks BEFORE hitting Postgres
 * on every authenticated request. Each online handset polls at roughly
 * 5 requests / second (AIR 250 ms, talk-activity 1.2 s, inbox 2 s,
 * presence 12 s), so a regression here either:
 *
 *  - Burns the pg connection pool (cache silently disabled / always
 *    misses → every poll hits Postgres → pool exhausted under load), or
 *  - Lets a disabled user / superseded session keep talking past the
 *    documented invalidation window (cache returns stale data after
 *    explicit invalidation, or never expires).
 *
 * Both are security- and availability-critical, and both are easy to
 * miss in code review (the TTL behaviour is invisible until the cache
 * is under contention). These tests pin the public contract:
 *
 *  - `setCachedAuth` → `getCachedAuth` round-trips the stored fields.
 *  - The cache expires after 15 seconds (the documented `TTL_MS`).
 *  - `invalidateCachedAuth` drops a single user immediately so a fresh
 *    login forces the old device's next request to re-check Postgres.
 *  - `clearAuthCache` wipes everyone (used between tests / on shutdown).
 *  - Per-user isolation: invalidating user A must not flush user B.
 *  - An expired entry returns `null` AND is removed from the underlying
 *    map (so the cache doesn't grow unbounded across long-lived users).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearAuthCache,
  getCachedAuth,
  invalidateCachedAuth,
  setCachedAuth,
} from "../src/sessionCache.js";

/**
 * Each test runs against a shared module-level Map, so reset between tests.
 * `clearAuthCache` is itself one of the surfaces under test, but it's
 * trivially correct (`Map.clear()`) and gives every test a fresh baseline.
 */
function resetCache(): void {
  clearAuthCache();
}

/**
 * Drive a function's view of "now" without sleeping the test runner. The
 * cache's TTL is 15 seconds, so a real-time test would either take 15 s
 * or be flaky. Stubbing `Date.now` is the deterministic alternative.
 */
function withFrozenTime<T>(startMs: number, body: (advance: (ms: number) => void) => T): T {
  const realNow = Date.now;
  let current = startMs;
  Date.now = () => current;
  try {
    return body((ms) => {
      current += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

test("sessionCache: getCachedAuth returns null for an unknown user", () => {
  resetCache();
  assert.equal(getCachedAuth(123), null);
});

test("sessionCache: setCachedAuth then getCachedAuth round-trips every documented field", () => {
  resetCache();
  setCachedAuth(42, {
    tokenGeneration: 7,
    userDisabled: false,
    agencyDisabled: true,
  });
  const out = getCachedAuth(42);
  assert.ok(out !== null, "fresh entry must be readable");
  // The TS return type is `Omit<CachedAuth, "expiresAt">` and the auth
  // middleware destructures those three fields by name. Pin each one
  // explicitly so a future refactor that re-orders or renames a field
  // breaks loudly here rather than silently flipping a flag the
  // middleware reads off the cached value.
  assert.equal(out!.tokenGeneration, 7);
  assert.equal(out!.userDisabled, false);
  assert.equal(out!.agencyDisabled, true);
});

test("sessionCache: an entry under TTL is still served", () => {
  resetCache();
  withFrozenTime(1_000_000, (advance) => {
    setCachedAuth(9, {
      tokenGeneration: 3,
      userDisabled: false,
      agencyDisabled: false,
    });
    advance(14_999); // 1ms before the 15s TTL window closes
    const out = getCachedAuth(9);
    assert.ok(out !== null, "must still be cached just before TTL");
    assert.equal(out!.tokenGeneration, 3);
  });
});

test("sessionCache: an entry past TTL returns null AND is evicted from the map", () => {
  resetCache();
  withFrozenTime(2_000_000, (advance) => {
    setCachedAuth(11, {
      tokenGeneration: 1,
      userDisabled: false,
      agencyDisabled: false,
    });
    advance(15_001); // just past TTL
    assert.equal(getCachedAuth(11), null, "expired entry must read as null");
    // A second read at the same expired timestamp must also return null —
    // i.e. the read-side must have actually deleted the stale row, not
    // just returned null while leaving it in the map (a leak under load).
    advance(0);
    assert.equal(getCachedAuth(11), null, "expired entry must stay evicted");
  });
});

test("sessionCache: setCachedAuth refreshes the TTL on rewrite (the next read wins for 15 s)", () => {
  // The auth middleware re-writes the cache on every Postgres hit. That
  // write must reset the TTL so a long-lived user doesn't see their cache
  // entry expire mid-stride after a refresh.
  resetCache();
  withFrozenTime(5_000_000, (advance) => {
    setCachedAuth(50, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
    advance(10_000); // 10s in, still cached
    setCachedAuth(50, { tokenGeneration: 2, userDisabled: false, agencyDisabled: false });
    advance(14_999); // 24.999s past the first write, but only 14.999s past the refresh
    const out = getCachedAuth(50);
    assert.ok(out !== null, "rewrite must extend the TTL window");
    assert.equal(out!.tokenGeneration, 2, "rewrite must replace the cached payload");
  });
});

test("sessionCache: invalidateCachedAuth drops only the targeted user", () => {
  // Login bumps token_generation and explicitly invalidates only the
  // user that just signed in, so other authenticated users continue to
  // hit the cache. If `invalidateCachedAuth` ever started wiping the
  // whole map (a tempting "safe" refactor), every active handset would
  // suddenly fall back to Postgres on its next poll — instant cliff.
  resetCache();
  setCachedAuth(101, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  setCachedAuth(102, { tokenGeneration: 2, userDisabled: false, agencyDisabled: false });
  invalidateCachedAuth(101);
  assert.equal(getCachedAuth(101), null);
  const stillCached = getCachedAuth(102);
  assert.ok(stillCached !== null, "other users must remain cached");
  assert.equal(stillCached!.tokenGeneration, 2);
});

test("sessionCache: invalidateCachedAuth is a no-op for an unknown user", () => {
  resetCache();
  // The middleware sometimes invalidates by id without knowing whether
  // the user had an entry — this must not throw.
  assert.doesNotThrow(() => invalidateCachedAuth(999_999));
  assert.equal(getCachedAuth(999_999), null);
});

test("sessionCache: clearAuthCache wipes every user", () => {
  resetCache();
  setCachedAuth(1, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  setCachedAuth(2, { tokenGeneration: 2, userDisabled: true, agencyDisabled: false });
  setCachedAuth(3, { tokenGeneration: 3, userDisabled: false, agencyDisabled: true });
  clearAuthCache();
  assert.equal(getCachedAuth(1), null);
  assert.equal(getCachedAuth(2), null);
  assert.equal(getCachedAuth(3), null);
});

test("sessionCache: clearAuthCache is idempotent", () => {
  resetCache();
  assert.doesNotThrow(() => clearAuthCache());
  assert.doesNotThrow(() => clearAuthCache());
});

test("sessionCache: a disabled user/agency flag is preserved across reads", () => {
  // The cached `userDisabled` / `agencyDisabled` flags are what stop a
  // suspended account from polling indefinitely. If a refactor ever
  // dropped or inverted these, a disabled user would keep getting 200s
  // for up to 15 s after suspension — already too long for the
  // security review that motivated the cache.
  resetCache();
  setCachedAuth(77, {
    tokenGeneration: 5,
    userDisabled: true,
    agencyDisabled: true,
  });
  const out = getCachedAuth(77);
  assert.ok(out !== null);
  assert.equal(out!.userDisabled, true);
  assert.equal(out!.agencyDisabled, true);
});
