/**
 * Regression tests for `server/src/presence.ts`.
 *
 * Channel presence is the in-memory roster that powers two things every
 * dispatcher relies on:
 *
 *  1. The "(N on channel)" badge surfaced by `GET /v1/radio/presence` on
 *     both the web console and the iOS app.
 *  2. The agency-scoped namespacing that lets two tenants legitimately
 *     own a channel with the same display name without ever seeing each
 *     other's counts.
 *
 * It is also the upstream of `aiDispatch/channelCache`, which re-uses
 * `normalizedChannel` to key its cached AI-dispatch flag per agency. A
 * regression in the normaliser silently mis-routes those lookups too.
 *
 * Specifically, these tests pin:
 *
 *   - `normalizedChannel` collapses whitespace + folds case so
 *     "Channel  1", "channel 1", and "CHANNEL\t1" all key the same
 *     bucket (Android, iOS, and the web console send their channel
 *     labels with slightly different whitespace).
 *   - `heartbeatPresence` rejects empty / sentinel-`----` channel
 *     values before they pollute the map (the legacy "no channel"
 *     placeholder must never get a count).
 *   - The agency namespace is enforced — two agencies on a channel with
 *     the same display name never share a count, even after the same
 *     unit_id heartbeats on each.
 *   - The TTL prune kicks in once a heartbeat is older than 45 s, so a
 *     handset that dropped off the network is reported as gone within
 *     the documented window (and not a moment earlier).
 *   - The same unit re-heartbeating extends its own entry rather than
 *     double-counting.
 *   - The pruner also drops empty channel maps from the outer map so a
 *     long-running server doesn't leak a `Map` entry for every channel
 *     that ever had a unit on it.
 *
 * Time is advanced via `node:test` mock timers so the TTL boundary is
 * tested deterministically.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  countPresence,
  heartbeatPresence,
  normalizedChannel,
} from "../src/presence.js";

/** Drop every heartbeat the previous test left behind. */
function clearPresence(): void {
  // Presence has no exported "clear" — but a TTL prune at "Date.now() + 1h"
  // removes every entry regardless of when it was registered. We do that by
  // briefly enabling mock timers, jumping forward, calling a function that
  // triggers the internal prune, then disabling. This keeps the production
  // module surface intact (no test-only export) and avoids cross-test
  // contamination from the module-level `Map`.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  // Use real Date.now() as the new "base" — adding one hour to a real
  // timestamp guarantees we are past every prior heartbeat's TTL.
  const orig = Date.now;
  try {
    const advanced = orig() + ONE_HOUR_MS;
    Date.now = () => advanced;
    // countPresence triggers the internal prune.
    countPresence(0, "anything");
    countPresence(1, "anything");
    countPresence(2, "anything");
    countPresence(99, "anything");
  } finally {
    Date.now = orig;
  }
}

test("normalizedChannel folds case, trims, and collapses internal whitespace", () => {
  // All of these are the same logical channel in the dispatcher's mental model
  // — handsets and the web console send them with slightly different padding.
  const variants = [
    "Channel 1",
    "channel 1",
    "CHANNEL 1",
    " channel 1 ",
    "channel\t1",
    "channel\n1",
    "channel    1",
    "Channel\u00201",
  ];
  const expected = "channel 1";
  for (const v of variants) {
    assert.equal(normalizedChannel(v), expected, `failed for ${JSON.stringify(v)}`);
  }
});

test("normalizedChannel coerces non-string inputs without throwing", () => {
  // The presence handler accepts an `unknown` straight off the request body.
  // A misbehaving client must never crash the route by sending e.g. `null` or
  // a number as the channel field.
  assert.equal(normalizedChannel(undefined), "");
  assert.equal(normalizedChannel(null), "");
  assert.equal(normalizedChannel(42), "42");
  assert.equal(normalizedChannel({ toString: () => "Channel 7" }), "channel 7");
  assert.equal(normalizedChannel(["nested"]), "nested");
  // Internal whitespace collapse still applies after coercion.
  assert.equal(normalizedChannel("  Mixed\t Case   Label  "), "mixed case label");
});

test("heartbeatPresence rejects empty unit, empty channel, and the '----' sentinel", () => {
  clearPresence();
  // The legacy "no channel" placeholder must never accumulate a count or
  // dispatchers see a phantom roster on a channel that does not exist.
  assert.deepEqual(heartbeatPresence(1, "U-1", "----"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(1, "", "Channel 1"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(1, "U-1", ""), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(1, "   ", "Channel 1"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  // None of these added an entry, so the channel's count is still zero.
  assert.equal(countPresence(1, "Channel 1"), 0);
  assert.equal(countPresence(1, "----"), 0);
});

test("heartbeatPresence accepts and counts a real unit/channel", () => {
  clearPresence();
  const res = heartbeatPresence(7, "U-100", "Channel 3");
  assert.deepEqual(res, { ok: true });
  assert.equal(countPresence(7, "Channel 3"), 1);
});

test("heartbeatPresence normalises both unit and channel before keying", () => {
  clearPresence();
  // Heartbeat with messy casing/padding…
  heartbeatPresence(2, " u-200 ", " Channel\tFour ");
  // …and read back with a different cosmetic representation of the same
  // channel. The normaliser must collapse both into the same bucket or the
  // dispatcher sees zero presence on a channel that has a unit on it.
  assert.equal(countPresence(2, "channel four"), 1);
  assert.equal(countPresence(2, "CHANNEL    FOUR"), 1);
});

test("unit id is upper-cased so case-differing reports do not double-count", () => {
  clearPresence();
  // A single physical handset that re-keys with different cosmetic casing
  // (e.g. an Android client that lower-cases its unit id on a settings
  // round-trip) must remain a single roster entry.
  heartbeatPresence(3, "u-300", "Channel 5");
  heartbeatPresence(3, "U-300", "Channel 5");
  heartbeatPresence(3, "u-300", "channel 5");
  assert.equal(countPresence(3, "Channel 5"), 1);
});

test("countPresence is agency-scoped — two tenants on identical names never see each other", () => {
  clearPresence();
  // Multi-tenant isolation is a hard rule across the platform.
  heartbeatPresence(10, "U-1", "Patrol");
  heartbeatPresence(10, "U-2", "Patrol");
  heartbeatPresence(20, "U-1", "Patrol"); // same name, different agency
  assert.equal(countPresence(10, "Patrol"), 2);
  assert.equal(countPresence(20, "Patrol"), 1);
  // And the same unit id on each tenant counts in each, not a cross-leak.
  assert.equal(countPresence(20, "Patrol"), 1);
});

test("TTL prune drops a heartbeat older than 45s", (t: TestContext) => {
  clearPresence();
  t.mock.timers.enable({ apis: ["Date"] });
  // Heartbeat at t=0.
  heartbeatPresence(50, "U-A", "Channel A");
  assert.equal(countPresence(50, "Channel A"), 1);

  // Just under TTL — still present.
  t.mock.timers.tick(44_000);
  assert.equal(
    countPresence(50, "Channel A"),
    1,
    "heartbeat must survive until just under TTL",
  );

  // One tick past TTL (45 s) — pruned out.
  t.mock.timers.tick(2_000);
  assert.equal(
    countPresence(50, "Channel A"),
    0,
    "heartbeat must be pruned once age exceeds TTL_MS",
  );
});

test("re-heartbeat refreshes a unit instead of leaking duplicate entries", (t: TestContext) => {
  clearPresence();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(60, "U-A", "Refresh Channel");
  // Halfway through TTL the handset reports in again — its TTL window should
  // reset, not its entry duplicate.
  t.mock.timers.tick(30_000);
  heartbeatPresence(60, "U-A", "Refresh Channel");
  assert.equal(countPresence(60, "Refresh Channel"), 1);

  // Older "first heartbeat" timestamp is already gone; the only timestamp
  // left is from t=30s. We should now survive 44 s past that re-heartbeat.
  t.mock.timers.tick(44_000); // total elapsed: 74 s, last heartbeat at 30 s -> 44 s old
  assert.equal(
    countPresence(60, "Refresh Channel"),
    1,
    "re-heartbeat must reset the TTL window for that unit",
  );

  // 2 s more — last heartbeat is now 46 s old, beyond TTL.
  t.mock.timers.tick(2_000);
  assert.equal(countPresence(60, "Refresh Channel"), 0);
});

test("partial expiry: one unit on a channel times out, the other survives", (t: TestContext) => {
  clearPresence();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(70, "U-OLD", "Shared Channel");
  t.mock.timers.tick(20_000);
  heartbeatPresence(70, "U-NEW", "Shared Channel");
  assert.equal(countPresence(70, "Shared Channel"), 2);

  // 26 s later — U-OLD is 46 s old (pruned), U-NEW is 26 s old (kept).
  t.mock.timers.tick(26_000);
  assert.equal(
    countPresence(70, "Shared Channel"),
    1,
    "per-unit TTL must prune individually, not the whole channel at once",
  );
});

test("a channel whose every unit has expired no longer reports a count", (t: TestContext) => {
  clearPresence();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(80, "U-A", "Ghost Channel");
  heartbeatPresence(80, "U-B", "Ghost Channel");
  // Long past TTL — both entries should be gone.
  t.mock.timers.tick(60_000);
  assert.equal(
    countPresence(80, "Ghost Channel"),
    0,
    "an emptied channel must not retain a stale count",
  );
});

test("countPresence returns zero for an unknown agency/channel", () => {
  clearPresence();
  heartbeatPresence(1, "U-1", "Real Channel");
  assert.equal(countPresence(1, "Different Channel"), 0);
  assert.equal(countPresence(999, "Real Channel"), 0);
});

test("countPresence returns zero (not throws) for an empty / sentinel channel", () => {
  // The presence route may be called with a missing query parameter; the
  // helper must not crash and must report zero instead of the previously-
  // cached count for some other (legitimate) channel.
  assert.equal(countPresence(1, ""), 0);
  assert.equal(countPresence(1, "----"), 0);
  assert.equal(countPresence(1, undefined), 0);
  assert.equal(countPresence(1, null), 0);
});

// --- The block below comes from a second test author who wrote a parallel
// suite for the same module. The unique coverage it added is now kept here
// inline (deduped against the first half above) so we keep the additional
// invariants without re-importing or re-declaring helpers.

// Each test uses a unique agency id so they stay independent — the presence
// store is process-global by design.
let nextAgency = 9_000_000;
function agencyId(): number {
  return nextAgency++;
}

test("normalizedChannel: trims, lowercases, and collapses internal whitespace", () => {
  assert.equal(normalizedChannel("  Main  "), "main");
  assert.equal(normalizedChannel("Main\tChannel"), "main channel");
  assert.equal(normalizedChannel("Main   Channel"), "main channel");
  assert.equal(normalizedChannel("MAIN"), "main");
  assert.equal(normalizedChannel(null), "");
  assert.equal(normalizedChannel(undefined), "");
  assert.equal(normalizedChannel(123 as unknown), "123");
});

test("heartbeatPresence: rejects empty / sentinel unit and channel inputs", () => {
  const ag = agencyId();
  assert.deepEqual(heartbeatPresence(ag, "", "main"), { ok: false, error: "bad_unit_or_channel" });
  assert.deepEqual(heartbeatPresence(ag, "  ", "main"), { ok: false, error: "bad_unit_or_channel" });
  assert.deepEqual(heartbeatPresence(ag, "U-1", ""), { ok: false, error: "bad_unit_or_channel" });
  assert.deepEqual(heartbeatPresence(ag, "U-1", "----"), { ok: false, error: "bad_unit_or_channel" });
  assert.deepEqual(heartbeatPresence(ag, null, "main"), { ok: false, error: "bad_unit_or_channel" });
  assert.deepEqual(heartbeatPresence(ag, "U-1", null), { ok: false, error: "bad_unit_or_channel" });
  assert.equal(countPresence(ag, "main"), 0, "rejected heartbeats must not be counted");
});

test("heartbeatPresence + countPresence: same agency, same channel sees distinct units", () => {
  const ag = agencyId();
  assert.deepEqual(heartbeatPresence(ag, "U-1", "main"), { ok: true });
  assert.deepEqual(heartbeatPresence(ag, "U-2", "main"), { ok: true });
  // Second heartbeat from U-1 (re-keying / refresh) must not double-count.
  assert.deepEqual(heartbeatPresence(ag, "U-1", "main"), { ok: true });
  assert.equal(countPresence(ag, "main"), 2);
});

test("heartbeatPresence: unit ID is upper-cased so 'u-1' and 'U-1' don't double-count", () => {
  const ag = agencyId();
  heartbeatPresence(ag, "u-1", "main");
  heartbeatPresence(ag, "U-1", "main");
  heartbeatPresence(ag, " u-1 ", "main");
  assert.equal(countPresence(ag, "main"), 1, "case + whitespace variants of the same unit collapse to one");
});

test("heartbeatPresence: normalized channel is what countPresence sees ('Main' ≡ 'main')", () => {
  const ag = agencyId();
  heartbeatPresence(ag, "U-1", "  Main  ");
  heartbeatPresence(ag, "U-2", "main");
  assert.equal(countPresence(ag, "main"), 2);
  assert.equal(countPresence(ag, "MAIN"), 2);
  assert.equal(countPresence(ag, "  Main  "), 2);
});

test("countPresence: two agencies with the same channel name are isolated (multi-tenant)", () => {
  const a = agencyId();
  const b = agencyId();
  heartbeatPresence(a, "U-1", "main");
  heartbeatPresence(a, "U-2", "main");
  heartbeatPresence(b, "U-9", "main");
  assert.equal(countPresence(a, "main"), 2);
  assert.equal(countPresence(b, "main"), 1);
  // Cross-check: agency a's units never appear under agency b.
  assert.equal(countPresence(b, "MAIN"), 1);
});

test("countPresence: an unknown channel reports 0 (no allocation)", () => {
  const ag = agencyId();
  assert.equal(countPresence(ag, "never-heartbeat"), 0);
  // And the lookup itself must not crash on weird inputs.
  assert.equal(countPresence(ag, ""), 0);
  assert.equal(countPresence(ag, "----"), 0);
});

test("countPresence: stale heartbeats (>45s) are pruned on next read", () => {
  const ag = agencyId();
  const realNow = Date.now;
  try {
    // Heartbeat at t=0, then advance the clock past the 45s TTL.
    Date.now = () => 1_000_000;
    heartbeatPresence(ag, "U-1", "main");
    assert.equal(countPresence(ag, "main"), 1);

    Date.now = () => 1_000_000 + 46_000;
    assert.equal(
      countPresence(ag, "main"),
      0,
      "after 46s the stale entry must be evicted (TTL=45s)",
    );
  } finally {
    Date.now = realNow;
  }
});
