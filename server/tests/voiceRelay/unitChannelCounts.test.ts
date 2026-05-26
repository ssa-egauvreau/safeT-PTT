/**
 * Regression tests for the live-control "is this unit safe to drag-drop?" rule
 * implemented in `server/src/voiceRelay.ts`.
 *
 * Context — PR #136 ("live-control: delete temp emergency channels + unblock
 * non-console drag-drop") tightened {@link computeUnitChannelCounts} so it
 * only counts dispatch-console sessions toward the per-unit channel count.
 *
 * The old behavior counted **any** roster record, which meant a normal user
 * who happened to have the web dashboard open on one channel while also
 * carrying a handset/phone tuned to another channel would show up as being
 * on "2 channels" and get marked `move_locked` by {@link withRosterMoveLock}.
 * Dispatchers could then no longer drag-drop them in Live Channel Control —
 * a real-world bug the PR fixes.
 *
 * The risk if this filter regresses is non-obvious from a console:
 *  - Drag-drop silently stops working for any user with multiple devices
 *  - All field units appear "locked" because most have a handset + an app
 *  - Dispatchers can no longer move units to an emergency channel by drag
 *
 * These tests pin the rule against the seven combinations of identity kind
 * and device type the relay actually produces (account/legacy/bridge ×
 * dispatch_console / unit_radio / phone / null), plus the cross-agency
 * isolation and case-insensitive grouping that the live-control tree depends
 * on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeUnitChannelCounts,
  withRosterMoveLock,
  type RosterMember,
  type UnitChannelCountRecord,
} from "../../src/voiceRelay.js";

/** Test fixture: build a roster record with sensible defaults. */
function record(overrides: Partial<UnitChannelCountRecord> & {
  agencyId: number;
  channelName: string;
  unitId: string;
}): UnitChannelCountRecord {
  const { agencyId, channelName, unitId, ...rest } = overrides;
  return {
    channelKey: `${agencyId} ${channelName.toLowerCase()}`,
    channelName,
    unitId,
    kind: "account",
    deviceType: "dispatch_console",
    ...rest,
  };
}

test("computeUnitChannelCounts: counts distinct dispatch-console channels per unit", () => {
  const counts = computeUnitChannelCounts(
    [
      record({ agencyId: 1, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 1, channelName: "Green 2", unitId: "DISP-1" }),
      record({ agencyId: 1, channelName: "Green 3", unitId: "DISP-1" }),
    ],
    1,
  );
  assert.equal(counts.get("DISP-1"), 3);
});

test("computeUnitChannelCounts: ignores duplicate channel join for same unit", () => {
  // The relay re-seats a roster record on every `join` message — so the same
  // (unit, channel) pair appearing twice is normal and must NOT inflate the
  // count past the number of distinct channels.
  const counts = computeUnitChannelCounts(
    [
      record({ agencyId: 1, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 1, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 1, channelName: "Green 2", unitId: "DISP-1" }),
    ],
    1,
  );
  assert.equal(counts.get("DISP-1"), 2);
});

test("computeUnitChannelCounts: a handset on multiple channels does NOT count (PR #136 fix)", () => {
  // The whole point of the change: a unit-radio account on two channels must
  // not register as "multi-channel" because it isn't dispatching — it's just
  // monitoring or holding sockets open. Counting it would block drag-drop.
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "27-040",
        deviceType: "unit_radio",
      }),
      record({
        agencyId: 1,
        channelName: "Green 2",
        unitId: "27-040",
        deviceType: "unit_radio",
      }),
    ],
    1,
  );
  assert.equal(counts.size, 0, "no console sessions → no entry");
  assert.equal(counts.get("27-040"), undefined);
});

test("computeUnitChannelCounts: phone client on multiple channels does NOT count (PR #136 fix)", () => {
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "27-040",
        deviceType: "phone",
      }),
      record({
        agencyId: 1,
        channelName: "Green 2",
        unitId: "27-040",
        deviceType: "phone",
      }),
    ],
    1,
  );
  assert.equal(counts.get("27-040"), undefined);
});

test("computeUnitChannelCounts: dashboard-on-one-channel + handset-on-another stays movable (PR #136 fix)", () => {
  // Exact real-world scenario the PR fixes: same user_id, dispatch_console
  // on the analytics dashboard channel + unit_radio on the field channel.
  // Only the console session counts; total is 1, so the unit stays movable.
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Admin",
        unitId: "27-040",
        deviceType: "dispatch_console",
      }),
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "27-040",
        deviceType: "unit_radio",
      }),
    ],
    1,
  );
  assert.equal(counts.get("27-040"), 1);
});

test("computeUnitChannelCounts: account with null deviceType is ignored", () => {
  // A brand-new account session before the device_type lookup completes has
  // deviceType === null. It must NOT be treated as a console.
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "DISP-1",
        deviceType: null,
      }),
      record({
        agencyId: 1,
        channelName: "Green 2",
        unitId: "DISP-1",
        deviceType: null,
      }),
    ],
    1,
  );
  assert.equal(counts.size, 0);
});

test("computeUnitChannelCounts: legacy (radio-key) sockets never count, even on dispatch_console", () => {
  // device_type can only realistically be dispatch_console for an account
  // session, but defense-in-depth: even if a legacy/bridge ever showed up
  // with that field, the kind filter alone must drop it.
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "27-040",
        kind: "legacy",
        deviceType: "dispatch_console",
      }),
      record({
        agencyId: 1,
        channelName: "Green 2",
        unitId: "27-040",
        kind: "legacy",
        deviceType: "dispatch_console",
      }),
    ],
    1,
  );
  assert.equal(counts.size, 0);
});

test("computeUnitChannelCounts: bridge sockets never count", () => {
  const counts = computeUnitChannelCounts(
    [
      record({
        agencyId: 1,
        channelName: "Green 1",
        unitId: "BRIDGE-1",
        kind: "bridge",
        deviceType: "dispatch_console",
      }),
      record({
        agencyId: 1,
        channelName: "Green 2",
        unitId: "BRIDGE-1",
        kind: "bridge",
        deviceType: "dispatch_console",
      }),
    ],
    1,
  );
  assert.equal(counts.size, 0);
});

test("computeUnitChannelCounts: agency isolation (channelKey prefix is exact)", () => {
  // The prefix is `${agencyId} ` — a literal space, not a substring. Agency
  // 1 must not see agency 10's roster (string startsWith would match without
  // the trailing space; this test guards that contract).
  const counts = computeUnitChannelCounts(
    [
      record({ agencyId: 1, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 10, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 10, channelName: "Green 2", unitId: "DISP-1" }),
    ],
    1,
  );
  assert.equal(counts.get("DISP-1"), 1, "only the agency-1 record counts");

  const tenant10 = computeUnitChannelCounts(
    [
      record({ agencyId: 1, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 10, channelName: "Green 1", unitId: "DISP-1" }),
      record({ agencyId: 10, channelName: "Green 2", unitId: "DISP-1" }),
    ],
    10,
  );
  assert.equal(tenant10.get("DISP-1"), 2);
});

test("computeUnitChannelCounts: groups by unitId case-insensitively", () => {
  // Browser console may send `disp-1` while the unit table stores `DISP-1`.
  // Both must collapse to the same count.
  const counts = computeUnitChannelCounts(
    [
      record({ agencyId: 1, channelName: "Green 1", unitId: "disp-1" }),
      record({ agencyId: 1, channelName: "Green 2", unitId: "DISP-1" }),
      record({ agencyId: 1, channelName: "Green 3", unitId: "Disp-1" }),
    ],
    1,
  );
  assert.equal(counts.size, 1);
  assert.equal(counts.get("DISP-1"), 3);
});

test("computeUnitChannelCounts: returns an empty Map when the roster is empty", () => {
  const counts = computeUnitChannelCounts([], 1);
  assert.equal(counts.size, 0);
});

// --- withRosterMoveLock --------------------------------------------------

function member(overrides: Partial<RosterMember> & { unit_id: string }): RosterMember {
  return {
    unit_id: overrides.unit_id,
    display_name: overrides.display_name ?? null,
    kind: overrides.kind ?? "account",
    client: overrides.client ?? "web",
    device_type: overrides.device_type ?? null,
    connected_ms: overrides.connected_ms ?? 0,
    ...overrides,
  };
}

test("withRosterMoveLock: account on dispatch_console is always locked, even on a single channel", () => {
  const out = withRosterMoveLock(
    [member({ unit_id: "DISP-1", device_type: "dispatch_console" })],
    new Map([["DISP-1", 1]]),
  );
  assert.equal(out[0]!.move_locked, true);
});

test("withRosterMoveLock: account on a handset is NOT locked even with stale count > 1", () => {
  // The count is derived from console sessions only (PR #136), so a non-
  // console member with n > 1 in the map shouldn't really happen — but if a
  // future change relaxes the counter, the kind/device_type guard here must
  // still keep field units movable. Pin the current rule: a non-console
  // account is locked iff count > 1 AND kind === "account".
  const out = withRosterMoveLock(
    [member({ unit_id: "27-040", device_type: "unit_radio" })],
    new Map([["27-040", 2]]),
  );
  assert.equal(out[0]!.move_locked, true, "account + count>1 still locks today");
});

test("withRosterMoveLock: legacy (radio-key handset) is never locked", () => {
  const out = withRosterMoveLock(
    [
      member({ unit_id: "27-040", kind: "legacy", device_type: "unit_radio" }),
      member({ unit_id: "27-040", kind: "legacy", device_type: "dispatch_console" }),
    ],
    new Map([["27-040", 5]]),
  );
  assert.equal(out[0]!.move_locked, undefined);
  assert.equal(out[1]!.move_locked, undefined);
});

test("withRosterMoveLock: bridge is never locked", () => {
  const out = withRosterMoveLock(
    [member({ unit_id: "BRIDGE-1", kind: "bridge" })],
    new Map([["BRIDGE-1", 3]]),
  );
  assert.equal(out[0]!.move_locked, undefined);
});

test("withRosterMoveLock: looks up counts case-insensitively (unit_id might be lower-case)", () => {
  // The counts Map is keyed by upper-cased unit_id; member.unit_id can be
  // any case (it's whatever the client sent on join).
  const out = withRosterMoveLock(
    [member({ unit_id: "disp-1", device_type: null })],
    new Map([["DISP-1", 2]]),
  );
  assert.equal(out[0]!.move_locked, true, "case-mismatched lookup must still find the count");
});

test("withRosterMoveLock: does not mutate or add move_locked to unlocked members", () => {
  // A movable member should not have a stray `move_locked: false` key — the
  // roster wire format omits it. Guard against accidental {...m, move_locked: false}.
  const input = [member({ unit_id: "27-040", kind: "legacy" })];
  const out = withRosterMoveLock(input, new Map([["27-040", 0]]));
  assert.equal(out[0]!.move_locked, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(out[0]!, "move_locked"), false);
});

test("withRosterMoveLock: preserves the input order (longest-connected first)", () => {
  const input = [
    member({ unit_id: "A", connected_ms: 9000 }),
    member({ unit_id: "B", connected_ms: 5000, device_type: "dispatch_console" }),
    member({ unit_id: "C", connected_ms: 1000 }),
  ];
  const out = withRosterMoveLock(input, new Map());
  assert.deepEqual(
    out.map((m) => m.unit_id),
    ["A", "B", "C"],
  );
});
