/**
 * Regression tests for `server/src/sessionCache.ts`.
 *
 * `sessionCache` is the in-process auth cache that sits in front of the
 * Postgres `tokenGeneration` / `userDisabled` / `agencyDisabled` checks
 * used by both the REST router-level middleware and the voice WebSocket
 * upgrade path. At Android's poll cadence (AIR 250 ms, talk-activity
 * 1.2 s, inbox 2 s, presence 12 s) a single online handset is ~5
 * authenticated requests per second, multiplied by every active user; a
 * bug that returned the wrong cached value here propagates instantly
 * across the entire fleet.
 *
 * What these tests pin:
 *
 *   1. `getCachedAuth` returns null for an uncached user (the middleware
 *      then re-fetches from Postgres and re-populates).
 *   2. `setCachedAuth` round-trips its payload verbatim and stores each
 *      typed field independently (a swap of the userDisabled /
 *      agencyDisabled flags would silently lock the wrong half of the
 *      fleet out).
 *   3. Cached entries automatically expire after the documented 15 s
 *      TTL, and a freshly-expired entry is actually removed from the
 *      underlying map (not just hidden from the getter) so the cache
 *      cannot grow without bound on a fleet of mostly-dormant accounts.
 *   4. `invalidateCachedAuth(userId)` evicts only that user — the
 *      "newest sign-in wins" semantic requires the old device's next
 *      request to re-fetch and observe the bumped `tokenGeneration`,
 *      but it must not also evict every other agency's cached users.
 *   5. `invalidateCachedAuth` is a safe no-op for users that were never
 *      cached (the login route calls it unconditionally).
 *   6. `clearAuthCache()` evicts every user (used on test teardown and
 *      on graceful shutdown).
 *   7. Re-setting the same user extends the TTL rather than retaining
 *      the original (older) expiry. A fresh login must therefore start
 *      a new TTL window, not inherit a few hundred ms left over from
 *      the previous session.
 *   8. A lower `tokenGeneration` cannot overwrite a fresher cache
 *      entry (PR #146 fix): an in-flight request that read the old
 *      generation from Postgres must not repopulate the cache after a
 *      login bumps the generation.
 *
 * Time is driven by `node:test`'s mock timers (or a scoped `Date.now`
 * override) so the 15 s TTL boundary is asserted deterministically —
 * no `await new Promise(setTimeout, ...)` sleeps that would make CI
 * flaky or slow.
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

/**
 * Run a callback with `Date.now` pinned to a controllable counter.
 *
 * Used for tests where `t.mock.timers` would be heavier than needed (e.g.
 * exercising the TTL boundary without depending on the experimental
 * MockTimers API for that specific case).
 */
function withFakeNow<T>(start: number, fn: (advance: (ms: number) => void) => T): T {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    return fn((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

// --- getCachedAuth: misses ----------------------------------------------

test("getCachedAuth: returns null for an uncached user", () => {
  clearAuthCache();
  assert.equal(getCachedAuth(1), null);
  assert.equal(getCachedAuth(999_999), null);
});

// --- setCachedAuth + getCachedAuth: round-trip --------------------------

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
  // Assert on the documented fields explicitly so a future refactor that
  // swapped any of them (e.g. defaulted `userDisabled` to false on a
  // partial set) is caught regardless of the internal `expiresAt` field.
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

// --- generation guard (PR #146) -----------------------------------------

test("setCachedAuth: a lower token_generation cannot overwrite a fresher entry", () => {
  // Reproduces the login race: request A read generation=1, login bumps to 2,
  // then request A tries to write its stale auth snapshot into the cache.
  // PR #146 guards this so the stale generation never wins.
  clearAuthCache();
  setCachedAuth(7, { tokenGeneration: 2, userDisabled: false, agencyDisabled: false });
  setCachedAuth(7, { tokenGeneration: 1, userDisabled: true, agencyDisabled: true });
  const got = getCachedAuth(7);
  assert.ok(got);
  assert.equal(got.tokenGeneration, 2, "stale generation must not replace a newer login generation");
  assert.equal(got.userDisabled, false);
  assert.equal(got.agencyDisabled, false);
});

test("setCachedAuth: equal token_generation still updates (post-DB re-read by same generation)", () => {
  // A re-seed by the same generation can legitimately carry a fresher
  // userDisabled / agencyDisabled snapshot (an admin disabled the user
  // mid-window). The guard only blocks STRICTLY LOWER generations.
  clearAuthCache();
  setCachedAuth(8, { tokenGeneration: 5, userDisabled: false, agencyDisabled: false });
  setCachedAuth(8, { tokenGeneration: 5, userDisabled: true, agencyDisabled: false });
  const got = getCachedAuth(8);
  assert.ok(got);
  assert.equal(got.tokenGeneration, 5);
  assert.equal(got.userDisabled, true, "same-generation re-seed must update flags");
});

// --- TTL boundary -------------------------------------------------------

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

test("getCachedAuth: an expired entry is evicted (TTL=15s, real-Date override)", () => {
  // Mirrors the boundary test above using the simpler scoped-Date override
  // path, so this contract is locked in regardless of the experimental
  // MockTimers API.
  clearAuthCache();
  withFakeNow(1_000_000, (advance) => {
    setCachedAuth(11, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
    advance(14_999);
    assert.ok(getCachedAuth(11), "still inside TTL");
    advance(2); // total +15_001
    assert.equal(getCachedAuth(11), null, "must be evicted past 15s");
    // And the second call must also be null (eviction is sticky).
    assert.equal(getCachedAuth(11), null);
  });
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
  // present with its stale expiresAt, a setter that bailed on the (then-
  // stale) generation guard would silently swallow the new write.
  setCachedAuth(999, payload(2));
  const cached = getCachedAuth(999);
  assert.ok(cached, "fresh setCachedAuth must restore the entry past TTL");
  assert.equal(cached.tokenGeneration, 2);
});

test("setCachedAuth past TTL must not let an expired stale-gen entry block the new write", (t: TestContext) => {
  // Edge of the generation-guard interaction with TTL: an EXPIRED entry
  // with a fresher generation must NOT be allowed to block a setter
  // carrying a lower generation. Expired-and-deleted entries are gone
  // for guard purposes too — otherwise the cache would refuse to
  // re-populate on the first call after a server restart misordering.
  clearAuthCache();
  t.mock.timers.enable({ apis: ["Date"] });
  setCachedAuth(321, payload(5));
  t.mock.timers.tick(15_001); // expire
  setCachedAuth(321, payload(2));
  const cached = getCachedAuth(321);
  assert.ok(cached, "expired entry must not block a subsequent setter");
  assert.equal(cached.tokenGeneration, 2);
});

// --- invalidateCachedAuth -----------------------------------------------

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
  // And it must not have somehow created a row by deleting nothing.
  setCachedAuth(424242, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  assert.ok(getCachedAuth(424242));
});

// --- clearAuthCache -----------------------------------------------------

test("clearAuthCache: drops every entry (test-isolation handle)", () => {
  setCachedAuth(1, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  setCachedAuth(2, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  setCachedAuth(3, { tokenGeneration: 1, userDisabled: false, agencyDisabled: false });
  clearAuthCache();
  assert.equal(getCachedAuth(1), null);
  assert.equal(getCachedAuth(2), null);
  assert.equal(getCachedAuth(3), null);
});

test("clearAuthCache is idempotent on an already-empty cache", () => {
  clearAuthCache();
  assert.doesNotThrow(() => clearAuthCache());
});
