/**
 * Tests for `server/src/loginRateLimit.ts`.
 *
 * This limiter is the only thing standing between the public `/v1/auth/login`
 * endpoint and an automated password grinder. The properties that matter:
 *
 *  1. **Lockout trips at the threshold** — the Nth consecutive failure (and not
 *     the (N-1)th) starts a lockout, and a locked key reports a positive
 *     `retryAfterMs` so the route can answer 429.
 *
 *  2. **Exponential backoff, capped** — each successive lockout doubles the
 *     wait, but never exceeds `maxLockoutMs`, so a key is throttled harder the
 *     longer it's abused without being bricked forever.
 *
 *  3. **Window reset** — failures spaced further apart than `windowMs` don't
 *     accumulate, so an honest user's occasional typo never locks them out.
 *
 *  4. **Success clears state** — a valid login wipes the counter, so a user who
 *     fumbled a couple of passwords starts fresh next time.
 *
 *  5. **Idle eviction** — keys that go quiet are dropped, so a wide IP sweep
 *     can't grow the Map without bound.
 *
 * A fake clock is injected so the time-based behaviour is deterministic and the
 * suite runs instantly (no real waiting).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { LoginRateLimiter, loginRateLimitKeys } = await import("../src/loginRateLimit.js");

type Clock = { now: number };

function makeLimiter(clock: Clock, overrides = {}) {
  return new LoginRateLimiter({
    maxFailures: 5,
    windowMs: 15 * 60 * 1000,
    baseLockoutMs: 60 * 1000,
    maxLockoutMs: 15 * 60 * 1000,
    idleEvictionMs: 60 * 60 * 1000,
    now: () => clock.now,
    ...overrides,
  });
}

test("a fresh key is not locked", () => {
  const clock = { now: 1_000 };
  const rl = makeLimiter(clock);
  assert.equal(rl.retryAfterMs("ip:1.2.3.4"), 0);
  assert.equal(rl.isLocked(["ip:1.2.3.4"]), false);
});

test("lockout trips exactly on the Nth consecutive failure", () => {
  const clock = { now: 1_000 };
  const rl = makeLimiter(clock);
  const key = "user:alice";
  // 4 failures: still allowed.
  for (let i = 0; i < 4; i++) rl.recordFailure(key);
  assert.equal(rl.retryAfterMs(key), 0, "4 failures must not lock");
  // 5th failure: locked for baseLockoutMs.
  rl.recordFailure(key);
  assert.equal(rl.retryAfterMs(key), 60 * 1000, "5th failure locks for base duration");
});

test("retryAfterMs counts down as time passes and clears when expired", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  const key = "ip:9.9.9.9";
  for (let i = 0; i < 5; i++) rl.recordFailure(key);
  assert.equal(rl.retryAfterMs(key), 60_000);
  clock.now = 20_000;
  assert.equal(rl.retryAfterMs(key), 40_000);
  clock.now = 60_000;
  assert.equal(rl.retryAfterMs(key), 0, "lock clears once the deadline passes");
});

test("lockout backs off exponentially and caps at maxLockoutMs", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  const key = "user:bob";
  const expectedLocks = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
  for (const expected of expectedLocks) {
    for (let i = 0; i < 5; i++) rl.recordFailure(key);
    assert.equal(rl.retryAfterMs(key), expected);
    // Wait out the lock so the next batch of failures can trip a fresh one.
    clock.now += expected + 1;
  }
});

test("failures spaced beyond the window do not accumulate into a lockout", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  const key = "user:carol";
  // Four failures, then a long gap, then more — none should ever lock because
  // the counter resets whenever the gap exceeds windowMs.
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 0; i < 4; i++) {
      rl.recordFailure(key);
      clock.now += 1_000;
    }
    clock.now += 15 * 60 * 1000 + 1; // jump past the window
  }
  assert.equal(rl.retryAfterMs(key), 0, "spread-out typos must never lock");
});

test("a successful login clears accumulated failures", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  const key = "user:dave";
  for (let i = 0; i < 4; i++) rl.recordFailure(key);
  rl.recordSuccess(key);
  assert.equal(rl.size(), 0, "success drops the key entirely");
  // One more failure after success must not immediately lock (counter reset).
  rl.recordFailure(key);
  assert.equal(rl.retryAfterMs(key), 0);
});

test("isLocked / retryAfterMsFor consider the worst of several keys", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  // Lock the user key but not the ip key.
  for (let i = 0; i < 5; i++) rl.recordFailure("user:eve");
  const keys = ["ip:5.5.5.5", "user:eve"];
  assert.equal(rl.isLocked(keys), true);
  assert.equal(rl.retryAfterMsFor(keys), 60_000);
});

test("idle unlocked keys are evicted on read and via sweep", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  rl.recordFailure("ip:1.1.1.1"); // single failure, never locked
  assert.equal(rl.size(), 1);
  // Past the idle horizon, a read evicts the stale entry.
  clock.now = 60 * 60 * 1000 + 1;
  assert.equal(rl.retryAfterMs("ip:1.1.1.1"), 0);
  assert.equal(rl.size(), 0, "stale entry dropped on read");

  // sweep() drops idle entries in bulk.
  rl.recordFailure("ip:2.2.2.2");
  clock.now += 60 * 60 * 1000 + 1;
  rl.sweep();
  assert.equal(rl.size(), 0, "sweep clears idle entries");
});

test("a locked key is not evicted by sweep while the lock is live", () => {
  const clock = { now: 0 };
  const rl = makeLimiter(clock);
  for (let i = 0; i < 5; i++) rl.recordFailure("user:frank");
  clock.now += 60 * 60 * 1000 + 1; // past idle horizon, but still locked? lock was 60s
  // Lock (60s) has long expired by now, so it IS evictable — assert it goes.
  rl.sweep();
  assert.equal(rl.size(), 0);

  // Now a key whose lock is still live must survive sweep.
  for (let i = 0; i < 5; i++) rl.recordFailure("user:grace");
  rl.sweep();
  assert.equal(rl.retryAfterMs("user:grace") > 0, true);
  assert.equal(rl.size(), 1, "live lock must not be swept");
});

test("loginRateLimitKeys builds normalised ip + user keys, skipping blanks", () => {
  assert.deepEqual(loginRateLimitKeys("1.2.3.4", "Alice"), ["ip:1.2.3.4", "user:alice"]);
  assert.deepEqual(loginRateLimitKeys("", "Bob"), ["user:bob"]);
  assert.deepEqual(loginRateLimitKeys("1.2.3.4", "  "), ["ip:1.2.3.4"]);
  assert.deepEqual(loginRateLimitKeys("", ""), []);
});
