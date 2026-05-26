/**
 * Regression tests for `server/src/aiDispatch/channelCache.ts`.
 *
 * `channelCache` is the in-process mirror of the `channel_ai_dispatch`
 * Postgres table that two hot paths consult on every voice frame:
 *
 *   - `server/src/recorder.ts` — calls `isAiDispatchChannelCached` to
 *     decide whether to record clear PCM (for AI dispatch ingestion) or
 *     IMBE frames (normal radio recording). A regression that flipped
 *     this for the wrong channel would either silently disable AI
 *     dispatch for an entire fleet or, worse, feed live operational
 *     audio into the AI pipeline on a channel the agency explicitly
 *     opted out of.
 *
 *   - `server/src/voiceRelay.ts` (via the recorder hook) decides
 *     whether to play the AI dispatcher's reply back on the channel.
 *
 * The cache is keyed by `${agencyId}:${normalizedChannel(name)}`, which
 * means two correctness properties have to hold and have to keep
 * holding through every refactor:
 *
 *   1. Multi-tenant isolation — agency A enabling AI dispatch on
 *      "Patrol" must never affect agency B's identically-named channel.
 *      A bug here would either leak transcripts across agencies or
 *      silently turn on AI on a tenant that hasn't licensed it.
 *   2. The same `normalizedChannel` semantics presence.ts uses — so a
 *      handset that heartbeats " Patrol " sees presence on the same
 *      bucket the recorder uses to look up the AI flag. Any drift in
 *      either direction creates a class of "AI works for some
 *      typographic variants of a channel name but not others" bug
 *      that is extremely hard to reproduce on a console.
 *   3. `warmAiDispatchChannelCache` rebuilds from scratch — calling it
 *      with rows that drop a previously-enabled channel must NOT leave
 *      the dropped channel still reading as enabled.
 *
 * These tests pin all three by exercising the public API only (no
 * production-only test hook is introduced).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAiDispatchChannelCached,
  setAiDispatchChannelCached,
  warmAiDispatchChannelCache,
} from "../../src/aiDispatch/channelCache.js";

/**
 * Reset the cache to a known-empty state. `warmAiDispatchChannelCache`
 * explicitly `clear()`s the underlying map, so passing an empty row set
 * is the documented way to drop every entry — no test-only export needed.
 */
function resetCache(): void {
  warmAiDispatchChannelCache([]);
}

test("setAiDispatchChannelCached + isAiDispatchChannelCached: round-trips an enabled flag", () => {
  resetCache();
  setAiDispatchChannelCached(1, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
});

test("isAiDispatchChannelCached: defaults to false for a never-set channel", () => {
  // The recorder/relay treat 'AI off' as the safe default — if the DB
  // doesn't say AI is on for this (agency, channel), it must be off.
  // A false-positive here would route private radio traffic into the AI
  // pipeline without admin opt-in.
  resetCache();
  assert.equal(isAiDispatchChannelCached(1, "NeverConfigured"), false);
  // And a numerically-different agency must also default to false even
  // after another agency enabled it on the same channel name.
  setAiDispatchChannelCached(1, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(2, "Patrol"), false);
});

test("setAiDispatchChannelCached with false explicitly disables the channel", () => {
  // The admin UI lets an operator turn AI off after turning it on; the
  // cache must follow, not just stick at the most-recent `true`.
  resetCache();
  setAiDispatchChannelCached(1, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  setAiDispatchChannelCached(1, "Patrol", false);
  assert.equal(
    isAiDispatchChannelCached(1, "Patrol"),
    false,
    "explicit false must override a prior true within the same agency",
  );
});

test("isAiDispatchChannelCached: agency isolation — agency A's flag never leaks to agency B", () => {
  // The most consequential regression risk: two tenants with a channel
  // literally called "Patrol" must not share an AI-dispatch enable bit.
  // Otherwise enabling AI on agency 1 silently turns it on for every
  // other agency that happens to have the same channel label.
  resetCache();
  setAiDispatchChannelCached(1, "Patrol", true);
  setAiDispatchChannelCached(2, "Patrol", false);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  assert.equal(isAiDispatchChannelCached(2, "Patrol"), false);
  assert.equal(isAiDispatchChannelCached(3, "Patrol"), false, "uninvolved agency must default to false");
});

test("isAiDispatchChannelCached: channel name normalisation matches presence.ts", () => {
  // The cache key uses presence.ts's `normalizedChannel`, so all of the
  // following cosmetic variants must resolve to the same bucket. A
  // regression that diverged from presence's whitespace/casing rules
  // would create the worst class of bug here — AI works on the variant
  // the admin saved but not on the variant a handset reports.
  resetCache();
  setAiDispatchChannelCached(7, "Patrol Alpha", true);
  const equivalentLabels = [
    "Patrol Alpha",
    "patrol alpha",
    "PATROL ALPHA",
    "  patrol  alpha  ",
    "patrol\talpha",
    "patrol\nalpha",
    "patrol    alpha",
  ];
  for (const label of equivalentLabels) {
    assert.equal(
      isAiDispatchChannelCached(7, label),
      true,
      `lookup for ${JSON.stringify(label)} must hit the same bucket as the canonical write`,
    );
  }
  // And a channel that differs by more than whitespace/casing must NOT hit.
  assert.equal(isAiDispatchChannelCached(7, "Patrol Bravo"), false);
});

test("setAiDispatchChannelCached: writes via a typographic variant overwrite the canonical key", () => {
  // The setter normalises before writing, so " patrol " and "Patrol"
  // share storage. This is what makes admin UPDATEs from any cosmetic
  // form land on the same row the recorder/relay reads from. A
  // regression where the setter skipped normalisation would let two
  // entries co-exist and the first reader to lose the race would see
  // stale data forever.
  resetCache();
  setAiDispatchChannelCached(5, " Channel One ", true);
  setAiDispatchChannelCached(5, "channel\tone", false); // disable via a different cosmetic form
  assert.equal(
    isAiDispatchChannelCached(5, "Channel One"),
    false,
    "the second (false) write must overwrite the first regardless of whitespace differences",
  );
});

test("warmAiDispatchChannelCache: rebuilds from scratch — dropped rows clear their cached enable", () => {
  // Startup path. The DB row set is the source of truth; the cache must
  // exactly mirror it. A regression that merged-on-top instead of
  // replacing would leave a channel reading as enabled after an admin
  // disabled it (the row would just disappear from the warm input).
  resetCache();
  warmAiDispatchChannelCache([
    { agency_id: 1, channel_name: "Patrol" },
    { agency_id: 1, channel_name: "Tactical" },
    { agency_id: 2, channel_name: "Patrol" },
  ]);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  assert.equal(isAiDispatchChannelCached(1, "Tactical"), true);
  assert.equal(isAiDispatchChannelCached(2, "Patrol"), true);

  // Now re-warm WITHOUT agency 1's Tactical row — that channel must
  // become disabled, not silently stay enabled.
  warmAiDispatchChannelCache([
    { agency_id: 1, channel_name: "Patrol" },
    { agency_id: 2, channel_name: "Patrol" },
  ]);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  assert.equal(
    isAiDispatchChannelCached(1, "Tactical"),
    false,
    "a row dropped between warms must flip the cache to disabled",
  );
  assert.equal(isAiDispatchChannelCached(2, "Patrol"), true);
});

test("warmAiDispatchChannelCache: an empty row set wipes every cached enable", () => {
  // The recovery path: an admin disabled every AI channel in the DB,
  // the warm gets an empty array. Every prior enable must be cleared.
  resetCache();
  setAiDispatchChannelCached(1, "A", true);
  setAiDispatchChannelCached(2, "B", true);
  setAiDispatchChannelCached(3, "C", true);
  warmAiDispatchChannelCache([]);
  assert.equal(isAiDispatchChannelCached(1, "A"), false);
  assert.equal(isAiDispatchChannelCached(2, "B"), false);
  assert.equal(isAiDispatchChannelCached(3, "C"), false);
});

test("warmAiDispatchChannelCache: normalises row.channel_name the same way runtime writes do", () => {
  // If the DB row stores "  Patrol  " (legacy data with stray
  // whitespace), warming must still land it on the same bucket the
  // recorder reads for "Patrol" — otherwise a fleet-wide AI rollout is
  // a no-op for every channel whose row predates the normalisation.
  resetCache();
  warmAiDispatchChannelCache([
    { agency_id: 1, channel_name: "  Patrol  " },
    { agency_id: 1, channel_name: "tactical\tone" },
  ]);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  assert.equal(isAiDispatchChannelCached(1, "PATROL"), true);
  assert.equal(isAiDispatchChannelCached(1, "Tactical One"), true);
});

test("isAiDispatchChannelCached: only an exact-true cache hit returns true", () => {
  // Implementation detail worth pinning: the getter uses `=== true`,
  // not truthiness. If a future refactor stored anything other than a
  // literal boolean (e.g. a timestamp meaning "last enabled at...")
  // the strict-equality guard would correctly return false rather than
  // accidentally turning AI on. This test fails loudly if that contract
  // is widened.
  resetCache();
  setAiDispatchChannelCached(1, "Patrol", true);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), true);
  setAiDispatchChannelCached(1, "Patrol", false);
  assert.equal(isAiDispatchChannelCached(1, "Patrol"), false);
});
