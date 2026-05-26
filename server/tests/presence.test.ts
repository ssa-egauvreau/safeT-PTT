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
 * Each test uses a unique agency id so they stay independent — the
 * presence store is process-global by design (no exported reset hook),
 * and a single shared id would cross-contaminate any test that ran
 * second under `--test-concurrency > 1`.
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

let nextAgency = 9_000_000;
function agencyId(): number {
  return nextAgency++;
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
  const ag = agencyId();
  // The legacy "no channel" placeholder must never accumulate a count or
  // dispatchers see a phantom roster on a channel that does not exist.
  assert.deepEqual(heartbeatPresence(ag, "U-1", "----"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(ag, "", "Channel 1"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(ag, "U-1", ""), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(ag, "   ", "Channel 1"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(ag, null, "Channel 1"), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  assert.deepEqual(heartbeatPresence(ag, "U-1", null), {
    ok: false,
    error: "bad_unit_or_channel",
  });
  // None of these added an entry, so the channel's count is still zero.
  assert.equal(countPresence(ag, "Channel 1"), 0);
  assert.equal(countPresence(ag, "----"), 0);
});

test("heartbeatPresence accepts and counts a real unit/channel", () => {
  const ag = agencyId();
  const res = heartbeatPresence(ag, "U-100", "Channel 3");
  assert.deepEqual(res, { ok: true });
  assert.equal(countPresence(ag, "Channel 3"), 1);
});

test("heartbeatPresence normalises both unit and channel before keying", () => {
  const ag = agencyId();
  // Heartbeat with messy casing/padding…
  heartbeatPresence(ag, " u-200 ", " Channel\tFour ");
  // …and read back with a different cosmetic representation of the same
  // channel. The normaliser must collapse both into the same bucket or the
  // dispatcher sees zero presence on a channel that has a unit on it.
  assert.equal(countPresence(ag, "channel four"), 1);
  assert.equal(countPresence(ag, "CHANNEL    FOUR"), 1);
});

test("unit id is upper-cased so case-differing reports do not double-count", () => {
  const ag = agencyId();
  // A single physical handset that re-keys with different cosmetic casing
  // (e.g. an Android client that lower-cases its unit id on a settings
  // round-trip) must remain a single roster entry.
  heartbeatPresence(ag, "u-300", "Channel 5");
  heartbeatPresence(ag, "U-300", "Channel 5");
  heartbeatPresence(ag, "u-300", "channel 5");
  assert.equal(countPresence(ag, "Channel 5"), 1);
});

test("countPresence is agency-scoped — two tenants on identical names never see each other", () => {
  // Multi-tenant isolation is a hard rule across the platform — a regression
  // here would leak unit counts (and unit ids, indirectly via tooling) across
  // agencies and would also corrupt the AI dispatch per-agency channel cache.
  const a = agencyId();
  const b = agencyId();
  heartbeatPresence(a, "U-1", "Patrol");
  heartbeatPresence(a, "U-2", "Patrol");
  heartbeatPresence(b, "U-1", "Patrol"); // same channel name, different tenant
  assert.equal(countPresence(a, "Patrol"), 2);
  assert.equal(countPresence(b, "Patrol"), 1);
  // Cross-check the normalised lookup so a regression that special-cased
  // exact-string lookups doesn't sneak past the agency check.
  assert.equal(countPresence(b, "PATROL"), 1);
});

test("TTL prune drops a heartbeat older than 45s", (t: TestContext) => {
  const ag = agencyId();
  t.mock.timers.enable({ apis: ["Date"] });
  // Heartbeat at t=0.
  heartbeatPresence(ag, "U-A", "Channel A");
  assert.equal(countPresence(ag, "Channel A"), 1);

  // Just under TTL — still present.
  t.mock.timers.tick(44_000);
  assert.equal(
    countPresence(ag, "Channel A"),
    1,
    "heartbeat must survive until just under TTL",
  );

  // One tick past TTL (45 s) — pruned out.
  t.mock.timers.tick(2_000);
  assert.equal(
    countPresence(ag, "Channel A"),
    0,
    "heartbeat must be pruned once age exceeds TTL_MS",
  );
});

test("re-heartbeat refreshes a unit instead of leaking duplicate entries", (t: TestContext) => {
  const ag = agencyId();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(ag, "U-A", "Refresh Channel");
  // Halfway through TTL the handset reports in again — its TTL window should
  // reset, not its entry duplicate.
  t.mock.timers.tick(30_000);
  heartbeatPresence(ag, "U-A", "Refresh Channel");
  assert.equal(countPresence(ag, "Refresh Channel"), 1);

  // Older "first heartbeat" timestamp is already gone; the only timestamp
  // left is from t=30s. We should now survive 44 s past that re-heartbeat.
  t.mock.timers.tick(44_000); // total elapsed: 74 s, last heartbeat at 30 s -> 44 s old
  assert.equal(
    countPresence(ag, "Refresh Channel"),
    1,
    "re-heartbeat must reset the TTL window for that unit",
  );

  // 2 s more — last heartbeat is now 46 s old, beyond TTL.
  t.mock.timers.tick(2_000);
  assert.equal(countPresence(ag, "Refresh Channel"), 0);
});

test("partial expiry: one unit on a channel times out, the other survives", (t: TestContext) => {
  const ag = agencyId();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(ag, "U-OLD", "Shared Channel");
  t.mock.timers.tick(20_000);
  heartbeatPresence(ag, "U-NEW", "Shared Channel");
  assert.equal(countPresence(ag, "Shared Channel"), 2);

  // 26 s later — U-OLD is 46 s old (pruned), U-NEW is 26 s old (kept).
  t.mock.timers.tick(26_000);
  assert.equal(
    countPresence(ag, "Shared Channel"),
    1,
    "per-unit TTL must prune individually, not the whole channel at once",
  );
});

test("a channel whose every unit has expired no longer reports a count", (t: TestContext) => {
  const ag = agencyId();
  t.mock.timers.enable({ apis: ["Date"] });
  heartbeatPresence(ag, "U-A", "Ghost Channel");
  heartbeatPresence(ag, "U-B", "Ghost Channel");
  // Long past TTL — both entries should be gone.
  t.mock.timers.tick(60_000);
  assert.equal(
    countPresence(ag, "Ghost Channel"),
    0,
    "an emptied channel must not retain a stale count",
  );
});

test("countPresence returns zero for an unknown agency/channel", () => {
  const ag = agencyId();
  heartbeatPresence(ag, "U-1", "Real Channel");
  assert.equal(countPresence(ag, "Different Channel"), 0);
  assert.equal(countPresence(agencyId(), "Real Channel"), 0);
});

test("countPresence returns zero (not throws) for an empty / sentinel channel", () => {
  // The presence route may be called with a missing query parameter; the
  // helper must not crash and must report zero instead of the previously-
  // cached count for some other (legitimate) channel.
  const ag = agencyId();
  heartbeatPresence(ag, "U-1", "Some Channel");
  assert.equal(countPresence(ag, ""), 0);
  assert.equal(countPresence(ag, "----"), 0);
  assert.equal(countPresence(ag, undefined), 0);
  assert.equal(countPresence(ag, null), 0);
});
