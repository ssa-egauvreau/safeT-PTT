/**
 * Tests for `server/src/presence.ts`.
 *
 * Channel presence drives the "X units on this channel" badges that
 * dispatchers rely on to know who's listening — a multi-tenant isolation
 * bug here would leak unit counts (and unit IDs, indirectly via tooling)
 * across agencies. Both correctness rules are non-obvious and worth pinning:
 *
 *   1. The bucket key namespaces the channel under its agency_id, so two
 *      tenants with a channel literally called "main" do NOT share a count.
 *
 *   2. `normalizedChannel` collapses whitespace + casing the same way both
 *      heartbeat and count paths do — otherwise a unit could heartbeat
 *      " Main " and the count for "main" would still be zero.
 *
 *   3. Heartbeats older than the TTL window are pruned before each read, so
 *      a unit that stopped sending updates eventually disappears from the
 *      roster (this is also the only path that frees memory for old
 *      channels — a leak there would grow unbounded under churn).
 *
 *   4. Empty / sentinel inputs ("", "----", null, undefined) are rejected
 *      so the upstream HTTP handler can rely on the validation here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countPresence,
  heartbeatPresence,
  normalizedChannel,
} from "../src/presence.js";

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
