/**
 * Tests for `server/src/presence.ts`.
 *
 * The presence map is the source of truth for the "RADIOS ONLINE ON
 * CHANNEL" count rendered on every handset and console. It is:
 *
 *  - Multi-tenant: every entry is namespaced by `agencyId` so two
 *    agencies that happen to use the same channel name ("OPS-1")
 *    never share a presence bucket. A regression here is a tenant
 *    isolation bug — operator A sees operator B's unit on their
 *    channel list.
 *
 *  - TTL-pruned (45 s): a handset that goes offline must drop out of
 *    the count within ~45 s without explicit unregister. A regression
 *    that breaks pruning keeps phantom units visible indefinitely.
 *
 *  - Whitespace / case insensitive on the channel label: handsets are
 *    historically inconsistent about whether they send "Ops-1" or
 *    "OPS-1" or "ops 1"; the normaliser must collapse these. A
 *    regression that re-tightens the comparison splits a single
 *    channel into multiple presence buckets and the count craters.
 *
 *  - Strict on unit / channel: empty unit, missing channel, and the
 *    "----" placeholder the iOS UI emits before catalog sync must all
 *    be rejected without polluting the map.
 *
 * Tests here pin those contracts. Time is stubbed (`Date.now`) so the
 * 45 s TTL is exercised without sleeping the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countPresence,
  heartbeatPresence,
  normalizedChannel,
} from "../src/presence.js";

/**
 * Drive `Date.now()` deterministically without sleeping the runner.
 * `presence.ts` reads `Date.now()` exactly once per call, so swapping
 * the global is sufficient and the override is restored on exit.
 */
function withFrozenTime<T>(
  startMs: number,
  body: (advance: (ms: number) => void) => T,
): T {
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

/**
 * The presence map is module-level state, so every test must start from
 * a known-empty baseline. The cheapest "reset" is to advance time past
 * the TTL for every key the previous test could have written, then
 * touch every (agency, channel) pair the next test will inspect to
 * confirm a clean slate. Doing that for every test is fragile — instead
 * we use distinct (agency, channel) tuples per test so cross-test
 * contamination is impossible by construction.
 */

test("normalizedChannel: collapses case, surrounding whitespace, and inner runs", () => {
  assert.equal(normalizedChannel("OPS-1"), "ops-1");
  assert.equal(normalizedChannel(" ops-1 "), "ops-1");
  assert.equal(normalizedChannel("Ops 1"), "ops 1");
  // Multi-space runs collapse to a single space so "ops   1" doesn't
  // become its own presence bucket separate from "ops 1".
  assert.equal(normalizedChannel("ops   1"), "ops 1");
  // Tabs / newlines that sneak through a misconfigured client are
  // treated as whitespace by the \s collapse.
  assert.equal(normalizedChannel("ops\t1"), "ops 1");
  assert.equal(normalizedChannel("ops\n1"), "ops 1");
});

test("normalizedChannel: coerces nullish / non-string input to the empty string", () => {
  // The function takes `unknown` because it's called directly on
  // request bodies. None of these should throw, and all of them must
  // produce an empty string (which the heartbeat path treats as
  // bad_unit_or_channel).
  assert.equal(normalizedChannel(undefined), "");
  assert.equal(normalizedChannel(null), "");
  assert.equal(normalizedChannel(""), "");
  assert.equal(normalizedChannel("   "), "");
  assert.equal(normalizedChannel(123), "123"); // numbers are stringified — documents current behaviour
});

test("heartbeatPresence: registers a unit and the count reflects it", () => {
  const result = heartbeatPresence(1001, "alpha", "alpha-ops-1");
  assert.deepEqual(result, { ok: true });
  assert.equal(countPresence(1001, "alpha-ops-1"), 1);
});

test("heartbeatPresence: uppercases the unit id before storing", () => {
  // The handset-side normaliser uppercases; the server must do the same
  // so two heartbeats from the same unit (one with mixed case, one
  // upper) collapse into a single entry rather than double-counting.
  heartbeatPresence(1002, "abc123", "alpha-ops-2");
  heartbeatPresence(1002, "ABC123", "alpha-ops-2");
  heartbeatPresence(1002, " abc123 ", "alpha-ops-2");
  assert.equal(
    countPresence(1002, "alpha-ops-2"),
    1,
    "case / whitespace variants of one unit must collapse to a single entry",
  );
});

test("heartbeatPresence: rejects an empty unit id", () => {
  const result = heartbeatPresence(1003, "", "alpha-ops-3");
  assert.deepEqual(result, { ok: false, error: "bad_unit_or_channel" });
  assert.equal(countPresence(1003, "alpha-ops-3"), 0);
});

test("heartbeatPresence: rejects a whitespace-only unit id", () => {
  const result = heartbeatPresence(1004, "   ", "alpha-ops-4");
  assert.deepEqual(result, { ok: false, error: "bad_unit_or_channel" });
  assert.equal(countPresence(1004, "alpha-ops-4"), 0);
});

test("heartbeatPresence: rejects an empty / missing channel", () => {
  // The iOS UI keeps "----" as a placeholder until the channel catalog
  // syncs. A handset whose catalog fetch failed must not register
  // presence under that placeholder — otherwise every offline-catalog
  // unit gets bucketed into a phantom "----" channel.
  assert.deepEqual(
    heartbeatPresence(1005, "u1", ""),
    { ok: false, error: "bad_unit_or_channel" },
  );
  assert.deepEqual(
    heartbeatPresence(1005, "u1", null),
    { ok: false, error: "bad_unit_or_channel" },
  );
  assert.deepEqual(
    heartbeatPresence(1005, "u1", "----"),
    { ok: false, error: "bad_unit_or_channel" },
  );
  // Normalisation must be applied BEFORE the "----" check — a sneaky
  // " ---- " must still be rejected.
  assert.deepEqual(
    heartbeatPresence(1005, "u1", " ---- "),
    { ok: false, error: "bad_unit_or_channel" },
  );
});

test("heartbeatPresence: agency scoping isolates same-name channels across tenants", () => {
  // This is the tenant-isolation contract: two agencies that pick the
  // same channel name "ops-1" must never see each other's units. The
  // count for agency 2001 must report 1 even though agency 2002 also
  // wrote a unit under "ops-1".
  heartbeatPresence(2001, "u-a", "ops-1");
  heartbeatPresence(2002, "u-b", "ops-1");
  heartbeatPresence(2002, "u-c", "ops-1");

  assert.equal(countPresence(2001, "ops-1"), 1, "agency 2001 sees only its own unit");
  assert.equal(countPresence(2002, "ops-1"), 2, "agency 2002 sees only its two units");

  // Cross-agency reads must not leak either direction.
  assert.equal(countPresence(2003, "ops-1"), 0, "an unrelated agency sees zero");
});

test("heartbeatPresence: distinct units in the same agency/channel each count once", () => {
  heartbeatPresence(3001, "alpha", "north");
  heartbeatPresence(3001, "bravo", "north");
  heartbeatPresence(3001, "charlie", "north");
  assert.equal(countPresence(3001, "north"), 3);
});

test("heartbeatPresence: refreshing the same unit does not double-count", () => {
  heartbeatPresence(3002, "alpha", "south");
  heartbeatPresence(3002, "alpha", "south");
  heartbeatPresence(3002, "alpha", "south");
  assert.equal(countPresence(3002, "south"), 1);
});

test("heartbeatPresence: channel match honours the same normaliser as countPresence", () => {
  // Operator console sends "OPS-1", handset sends " ops-1 " — both must
  // collide on a single presence bucket so the operator's count
  // reflects everyone who is actually on the channel.
  heartbeatPresence(4001, "u1", "OPS-1");
  heartbeatPresence(4001, "u2", " ops-1 ");
  heartbeatPresence(4001, "u3", "ops 1"); // different channel — note the space
  assert.equal(
    countPresence(4001, "ops-1"),
    2,
    "case + whitespace variants of one channel must bucket together",
  );
  assert.equal(
    countPresence(4001, "ops 1"),
    1,
    "a structurally different channel must stay separate",
  );
});

test("countPresence: returns 0 for an empty channel input without throwing", () => {
  // The route can pass `req.query.channel` which is sometimes undefined.
  // The function must coerce that into "" and return 0 rather than
  // throwing or returning the global unit count.
  assert.equal(countPresence(5001, undefined), 0);
  assert.equal(countPresence(5001, null), 0);
  assert.equal(countPresence(5001, ""), 0);
});

test("heartbeatPresence: a unit older than 45 s is pruned and stops counting", () => {
  withFrozenTime(10_000_000, (advance) => {
    heartbeatPresence(6001, "stale-unit", "alpha");
    advance(45_001); // step just past the TTL
    // The next heartbeat (under a different unit) triggers prune via
    // its Date.now() read; the stale unit must have been dropped.
    heartbeatPresence(6001, "fresh-unit", "alpha");
    assert.equal(
      countPresence(6001, "alpha"),
      1,
      "stale unit must be pruned; only the fresh one remains",
    );
  });
});

test("heartbeatPresence: a unit just under 45 s is still counted", () => {
  withFrozenTime(11_000_000, (advance) => {
    heartbeatPresence(6002, "almost-stale", "bravo");
    advance(44_999); // 1ms before TTL
    heartbeatPresence(6002, "other", "bravo");
    assert.equal(
      countPresence(6002, "bravo"),
      2,
      "TTL must be inclusive of the last 45 s — no early eviction",
    );
  });
});

test("heartbeatPresence: refreshing a heartbeat resets the unit's TTL", () => {
  // A live handset re-heartbeats every 12 s. Each heartbeat must
  // refresh the unit's TTL so the unit doesn't drop out 45 s after
  // FIRST registration regardless of liveness.
  withFrozenTime(12_000_000, (advance) => {
    heartbeatPresence(6003, "live", "charlie");
    advance(40_000);
    heartbeatPresence(6003, "live", "charlie"); // refresh
    advance(40_000); // 80 s since the first heartbeat, 40 s since the refresh
    heartbeatPresence(6003, "other", "charlie");
    assert.equal(
      countPresence(6003, "charlie"),
      2,
      "refreshed unit must outlive the original 45 s window",
    );
  });
});

test("heartbeatPresence: countPresence itself prunes stale units even without a write", () => {
  // Important: the count side is often called without an intervening
  // heartbeat (the console polls /v1/presence/count on its own cadence).
  // If pruning only happened on writes, a channel that went quiet
  // would report its last known count forever.
  withFrozenTime(13_000_000, (advance) => {
    heartbeatPresence(6004, "u1", "delta");
    heartbeatPresence(6004, "u2", "delta");
    advance(45_001);
    assert.equal(
      countPresence(6004, "delta"),
      0,
      "count must prune stale units on read, not just on write",
    );
  });
});

test("heartbeatPresence: pruning empties the channel map entirely when the last unit ages out", () => {
  // Long-running servers accumulate (agency, channel) pairs as users
  // try out new channels. The implementation explicitly deletes the
  // channel bucket when its last unit is pruned to keep the map
  // bounded. Test the externally observable consequence: count is 0
  // and a fresh heartbeat correctly seeds the bucket again.
  withFrozenTime(14_000_000, (advance) => {
    heartbeatPresence(6005, "u1", "echo");
    advance(45_001);
    assert.equal(countPresence(6005, "echo"), 0);
    // Bucket should have been deleted — re-seeding works.
    heartbeatPresence(6005, "u2", "echo");
    assert.equal(countPresence(6005, "echo"), 1);
  });
});
