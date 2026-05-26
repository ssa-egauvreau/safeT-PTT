/**
 * Regression tests for `server/src/aiDispatch/channelCache.ts`.
 *
 * The channel cache is consulted on every voice-relay packet and every
 * recorder transcript to decide whether to invoke the AI dispatch engine.
 * It is a process-global Map keyed on `${agencyId}:${normalizedChannel}`, so
 * three invariants must hold or the engine either runs against the wrong
 * agency's traffic (multi-tenant data leak) or silently stops running at
 * all on a cosmetically renamed channel:
 *
 *   1. Multi-tenant isolation: two agencies whose channels happen to share
 *      a display name MUST NOT cross-pollute. Agency A enabling AI on
 *      "Main" must not enable it for agency B's "Main".
 *
 *   2. Channel-name normalisation: the cache must collapse the same
 *      cosmetic variants `normalizedChannel()` does — trimming, lowercase,
 *      and internal-whitespace folding — so handsets that send "Channel  1"
 *      and the admin UI that wrote "channel 1" hit the same entry.
 *
 *   3. `warmAiDispatchChannelCache(rows)` is a full replace: any prior
 *      entry must be cleared before the new rows are seeded. Otherwise a
 *      channel an admin just disabled would stay "enabled" in cache until
 *      the next restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAiDispatchChannelCached,
  setAiDispatchChannelCached,
  warmAiDispatchChannelCache,
} from "../../src/aiDispatch/channelCache.js";

test("isAiDispatchChannelCached returns false for an un-seeded channel", () => {
  // Fresh agency id keeps the assertion independent of any prior test.
  assert.equal(isAiDispatchChannelCached(900_001, "Patrol"), false);
});

test("setAiDispatchChannelCached(true) then isAiDispatchChannelCached returns true", () => {
  setAiDispatchChannelCached(900_002, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(900_002, "Patrol"), true);
});

test("setAiDispatchChannelCached(false) explicitly disables a channel (not just absence)", () => {
  // Two paths can make a channel "not enabled": never-set (Map miss) and
  // explicitly set to false. The getter must report false for both — a
  // regression that returned `enabledByAgencyChannel.get(...) !== false`
  // would silently leave previously-enabled channels firing AI dispatch.
  setAiDispatchChannelCached(900_003, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(900_003, "Patrol"), true);
  setAiDispatchChannelCached(900_003, "Patrol", false);
  assert.equal(isAiDispatchChannelCached(900_003, "Patrol"), false);
});

test("multi-tenant isolation: two agencies on identically-named channels do not share state", () => {
  // The exact regression class this cache protects against: agency A
  // turning AI on for "Main" must not enable it for agency B.
  const A = 900_010;
  const B = 900_011;
  setAiDispatchChannelCached(A, "Main", true);
  assert.equal(isAiDispatchChannelCached(A, "Main"), true);
  assert.equal(
    isAiDispatchChannelCached(B, "Main"),
    false,
    "agency B must not inherit agency A's AI-enabled flag",
  );
});

test("channel name normalisation: case, padding, and internal whitespace fold to the same entry", () => {
  // The admin UI writes "Channel 1", Android sends "channel 1", iOS sends
  // " CHANNEL 1 ", and the bridge worker normalises to "channel\t1". All
  // four must hit the same cache row — otherwise an admin enabling AI on
  // "Channel 1" in the dashboard would not enable it for any actual
  // client traffic on the wire.
  const ag = 900_020;
  setAiDispatchChannelCached(ag, "Channel 1", true);
  for (const variant of ["channel 1", "CHANNEL 1", " Channel 1 ", "channel\t1", "channel   1"]) {
    assert.equal(
      isAiDispatchChannelCached(ag, variant),
      true,
      `variant ${JSON.stringify(variant)} must match the seeded entry`,
    );
  }
});

test("warmAiDispatchChannelCache replaces existing state (channel removed from DB → cache clears)", () => {
  // The startup warm path is a full snapshot: any channel that was enabled
  // before but is no longer in the DB rows must NOT remain enabled in
  // cache. The current contract is `enabledByAgencyChannel.clear()` first,
  // then seed — so a "stale TRUE leftover" regression here would fire AI
  // dispatch on a channel an admin just disabled.
  const ag = 900_030;
  setAiDispatchChannelCached(ag, "ToBeRemoved", true);
  assert.equal(isAiDispatchChannelCached(ag, "ToBeRemoved"), true);

  warmAiDispatchChannelCache([
    { agency_id: ag, channel_name: "FreshlyEnabled" },
  ]);

  assert.equal(
    isAiDispatchChannelCached(ag, "ToBeRemoved"),
    false,
    "warm must clear entries that the new snapshot does not include",
  );
  assert.equal(
    isAiDispatchChannelCached(ag, "FreshlyEnabled"),
    true,
    "warm must seed entries that ARE in the new snapshot",
  );
});

test("warmAiDispatchChannelCache seeds across agencies with the same channel name", () => {
  // Cache key includes `agency_id`, so the same channel name in two
  // agencies must produce two independent enabled rows.
  warmAiDispatchChannelCache([
    { agency_id: 900_040, channel_name: "Common" },
    { agency_id: 900_041, channel_name: "Common" },
  ]);
  assert.equal(isAiDispatchChannelCached(900_040, "Common"), true);
  assert.equal(isAiDispatchChannelCached(900_041, "Common"), true);
});

test("warmAiDispatchChannelCache: empty rows produces an empty cache (no false positives)", () => {
  setAiDispatchChannelCached(900_050, "Used", true);
  warmAiDispatchChannelCache([]);
  assert.equal(
    isAiDispatchChannelCached(900_050, "Used"),
    false,
    "an empty snapshot must disable every previously-enabled channel",
  );
});
