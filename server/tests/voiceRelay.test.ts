/**
 * Tests for the Live Channel Control "move lock" helpers in
 * `server/src/voiceRelay.ts`.
 *
 * Background — the production behavior under test:
 *
 *   Live Channel Control lets a dispatcher drag a unit between voice
 *   channels. We must not move a unit that is actively dispatching on a
 *   dispatch console (their open mic / monitored channel would yank out
 *   from under them mid-incident). But a regular user who happens to be
 *   on a handset on one channel and has the web dashboard open as a
 *   monitor on another channel is NOT a dispatcher — moving them on the
 *   handset should still be allowed.
 *
 *   Regression PR #140 fixed the previous behavior: `unitChannelCounts`
 *   was counting *every* voice socket, so any account with both a phone
 *   and an open web tab on different channels was permanently move-
 *   locked. The fix narrows the count to dispatch_console sessions only.
 *
 * If `unitChannelCounts` regresses, dispatchers lose the ability to move
 * normal users between channels — a silent, high-blast-radius bug that
 * blocks an emergency rerouting workflow. These tests pin the exact
 * filter (kind="account" AND deviceType="dispatch_console"), the agency
 * isolation, and the downstream `withRosterMoveLock` / `isUnitMoveLocked`
 * decisions that the API serves to the UI.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetVoiceRosterForTest,
  __setVoiceRosterRecordForTest,
  isUnitMoveLocked,
  unitChannelCounts,
  withRosterMoveLock,
  type RosterMember,
} from "../src/voiceRelay.js";

const AGENCY = 7;
const OTHER_AGENCY = 99;

function member(partial: Partial<RosterMember> & Pick<RosterMember, "unit_id" | "kind">): RosterMember {
  return {
    display_name: null,
    client: "web",
    device_type: null,
    connected_ms: 0,
    ...partial,
  };
}

beforeEach(() => {
  __resetVoiceRosterForTest();
});

afterEach(() => {
  __resetVoiceRosterForTest();
});

describe("unitChannelCounts", () => {
  test("counts only dispatch_console account sessions", () => {
    // The same dispatcher operating two console tabs/channels — should count as 2.
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });

    const counts = unitChannelCounts(AGENCY);
    assert.equal(counts.get("DISP1"), 2);
  });

  test("ignores handset/phone account sessions even on multiple channels", () => {
    // This is the regression PR #140 fixed: a user with a phone on Green 1
    // and the web console (no device_type) on Green 2 must NOT be counted
    // as multi-channel — otherwise they get move_locked permanently.
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "USER42",
      kind: "account",
      deviceType: "phone",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "USER42",
      kind: "account",
      deviceType: null,
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 3",
      unitId: "USER42",
      kind: "account",
      deviceType: "unit_radio",
    });

    const counts = unitChannelCounts(AGENCY);
    assert.equal(counts.get("USER42"), undefined);
    assert.equal(counts.size, 0);
  });

  test("ignores legacy handsets and bridges", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "U1",
      kind: "legacy",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "U1",
      kind: "legacy",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Bridge",
      unitId: "BRIDGE1",
      kind: "bridge",
      deviceType: "dispatch_console", // even with the dispatch device_type, kind!="account" must skip
    });

    const counts = unitChannelCounts(AGENCY);
    assert.equal(counts.size, 0);
  });

  test("dedupes a dispatch console rejoining the same channel", () => {
    // Two records for one unit on the same channel name (e.g. socket
    // resumed) is still ONE channel — Set dedupes by channelName.
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });

    assert.equal(unitChannelCounts(AGENCY).get("DISP1"), 1);
  });

  test("scopes counts per agency", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: OTHER_AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: OTHER_AGENCY,
      channelName: "Green 2",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });

    assert.equal(unitChannelCounts(AGENCY).get("DISP1"), 1);
    assert.equal(unitChannelCounts(OTHER_AGENCY).get("DISP1"), 2);
  });

  test("does not match agencies whose id is a prefix of another (key boundary)", () => {
    // channelKey is `${agencyId} ${chNorm}`. A naive startsWith without the
    // trailing space would let agency 7 match agency 77's records. The
    // space delimiter in the prefix prevents that.
    __setVoiceRosterRecordForTest({
      agencyId: 77,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: 77,
      channelName: "Green 2",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });

    assert.equal(unitChannelCounts(7).size, 0);
    assert.equal(unitChannelCounts(77).get("DISP1"), 2);
  });

  test("uppercases unit ids so case differences do not split the count", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "disp1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });

    const counts = unitChannelCounts(AGENCY);
    assert.equal(counts.get("DISP1"), 2);
    assert.equal(counts.get("disp1"), undefined);
  });
});

describe("withRosterMoveLock", () => {
  test("locks a dispatch_console account member regardless of count", () => {
    const out = withRosterMoveLock(
      [member({ unit_id: "DISP1", kind: "account", device_type: "dispatch_console" })],
      new Map(), // count is 0 here on purpose
    );
    assert.equal(out[0]!.move_locked, true);
  });

  test("locks an account member whose count exceeds 1 (multi-console dispatcher)", () => {
    const out = withRosterMoveLock(
      [member({ unit_id: "DISP1", kind: "account", device_type: null })],
      new Map([["DISP1", 2]]),
    );
    assert.equal(out[0]!.move_locked, true);
  });

  test("does NOT lock a non-dispatch account member when count is 0 or 1", () => {
    const out = withRosterMoveLock(
      [
        member({ unit_id: "U1", kind: "account", device_type: "phone" }),
        member({ unit_id: "U2", kind: "account", device_type: "unit_radio" }),
      ],
      new Map([["U2", 1]]),
    );
    assert.equal(out[0]!.move_locked, undefined);
    assert.equal(out[1]!.move_locked, undefined);
  });

  test("never locks legacy or bridge members even on many channels", () => {
    const out = withRosterMoveLock(
      [
        member({ unit_id: "LEG", kind: "legacy", device_type: null }),
        member({ unit_id: "BR", kind: "bridge", device_type: "dispatch_console" }),
      ],
      new Map([
        ["LEG", 5],
        ["BR", 5],
      ]),
    );
    assert.equal(out[0]!.move_locked, undefined);
    assert.equal(out[1]!.move_locked, undefined);
  });

  test("matches the count key case-insensitively via uppercase unit_id", () => {
    const out = withRosterMoveLock(
      [member({ unit_id: "disp1", kind: "account", device_type: null })],
      new Map([["DISP1", 3]]),
    );
    assert.equal(out[0]!.move_locked, true);
  });

  test("returns a new array with new objects only when a member becomes locked", () => {
    const original: RosterMember[] = [
      member({ unit_id: "U1", kind: "account", device_type: null }),
      member({ unit_id: "DISP1", kind: "account", device_type: "dispatch_console" }),
    ];
    const out = withRosterMoveLock(original, new Map());

    assert.notStrictEqual(out, original, "must not mutate caller's array");
    assert.strictEqual(out[0], original[0], "unchanged members are passed through by reference");
    assert.notStrictEqual(out[1], original[1], "locked member is a fresh object (no aliased state)");
    assert.equal(original[1]!.move_locked, undefined, "input member must not be mutated in place");
  });
});

describe("isUnitMoveLocked", () => {
  test("returns true when the unit has a dispatch_console session", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    assert.equal(isUnitMoveLocked(AGENCY, "DISP1"), true);
    assert.equal(isUnitMoveLocked(AGENCY, "disp1"), true);
    assert.equal(isUnitMoveLocked(AGENCY, "  disp1  "), true);
  });

  test("returns false for a user with handset + web on different channels (PR #140 fix)", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "USER42",
      kind: "account",
      deviceType: "phone",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "USER42",
      kind: "account",
      deviceType: null,
    });
    assert.equal(isUnitMoveLocked(AGENCY, "USER42"), false);
  });

  test("returns false for legacy/bridge units even on many channels", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "LEG1",
      kind: "legacy",
    });
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 2",
      unitId: "LEG1",
      kind: "legacy",
    });
    assert.equal(isUnitMoveLocked(AGENCY, "LEG1"), false);
  });

  test("returns false for unknown units and empty unit ids", () => {
    __setVoiceRosterRecordForTest({
      agencyId: AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    assert.equal(isUnitMoveLocked(AGENCY, "NOPE"), false);
    assert.equal(isUnitMoveLocked(AGENCY, ""), false);
    assert.equal(isUnitMoveLocked(AGENCY, "   "), false);
  });

  test("scopes the lock check per agency", () => {
    __setVoiceRosterRecordForTest({
      agencyId: OTHER_AGENCY,
      channelName: "Green 1",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    });
    assert.equal(isUnitMoveLocked(AGENCY, "DISP1"), false);
    assert.equal(isUnitMoveLocked(OTHER_AGENCY, "DISP1"), true);
  });
});
