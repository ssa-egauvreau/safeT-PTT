/**
 * Half-duplex `/v1/air` slot lifecycle — especially immediate clear on `release_air`.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";

import {
  __claimVoiceAirForTest,
  __handleVoiceControlForTest,
  __registerVoiceMemberForTest,
  __resetVoiceRosterForTest,
  peekVoiceTransmittingTalker,
} from "../src/voiceRelay.js";

const AGENCY = 42;
const CHANNEL = "Green 1";

/** Minimal WebSocket stub: records every `send` payload, reports OPEN. The
 *  relay's `air_released` fan-out only touches `readyState` and `send`. */
function fakeWs(): { sent: string[] } & WebSocket {
  const sent: string[] = [];
  return {
    sent,
    readyState: 1, // WebSocket.OPEN
    send(payload: unknown) {
      sent.push(String(payload));
    },
  } as unknown as { sent: string[] } & WebSocket;
}

function airReleasedFor(ws: { sent: string[] }): Array<{ type?: string; channel?: string }> {
  return ws.sent
    .map((s) => JSON.parse(s) as { type?: string; channel?: string })
    .filter((m) => m.type === "air_released");
}

beforeEach(() => {
  __resetVoiceRosterForTest();
});

afterEach(() => {
  __resetVoiceRosterForTest();
});

describe("voice air / release_air", () => {
  test("peekVoiceTransmittingTalker returns holder while slot is live", () => {
    const ws = {} as WebSocket;
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws,
      unitId: "U100",
      displayName: "Patrol 1",
    });
    const talker = peekVoiceTransmittingTalker(AGENCY, CHANNEL);
    assert.deepEqual(talker, { unit_id: "U100", display_name: "Patrol 1" });
  });

  test("release_air clears the holder immediately", () => {
    const ws = {} as WebSocket;
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws,
      unitId: "U100",
    });
    __handleVoiceControlForTest(ws, "release_air");
    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL), null);
  });

  test("release_air only clears slots owned by that socket", () => {
    const wsA = {} as WebSocket;
    const wsB = {} as WebSocket;
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: wsA,
      unitId: "A",
    });
    __handleVoiceControlForTest(wsB, "release_air");
    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL)?.unit_id, "A");
    __handleVoiceControlForTest(wsA, "release_air");
    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL), null);
  });
});

describe("air_released cue broadcast", () => {
  test("release_air notifies other members of the channel, never the talker", () => {
    const talker = fakeWs();
    const listener = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: listener, agencyId: AGENCY, channel: CHANNEL });
    __claimVoiceAirForTest({ agencyId: AGENCY, channel: CHANNEL, ws: talker, unitId: "U1" });

    __handleVoiceControlForTest(talker, "release_air");

    // The talker (releasing socket) must NOT receive the cue.
    assert.equal(airReleasedFor(talker).length, 0);
    // Every other member gets exactly one air_released for the right channel.
    const got = airReleasedFor(listener);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.channel, CHANNEL);
  });

  test("release_air with no slot held emits nothing (idempotent)", () => {
    const a = fakeWs();
    const b = fakeWs();
    __registerVoiceMemberForTest({ ws: a, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: b, agencyId: AGENCY, channel: CHANNEL });
    // a never claimed the air → releasing emits no cue to anyone.
    __handleVoiceControlForTest(a, "release_air");
    assert.equal(airReleasedFor(b).length, 0);
  });

  test("air_released stays within the channel (other channels untouched)", () => {
    const talker = fakeWs();
    const sameChan = fakeWs();
    const otherChan = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: sameChan, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: otherChan, agencyId: AGENCY, channel: "Blue 2" });
    __claimVoiceAirForTest({ agencyId: AGENCY, channel: CHANNEL, ws: talker, unitId: "U1" });

    __handleVoiceControlForTest(talker, "release_air");

    assert.equal(airReleasedFor(sameChan).length, 1);
    assert.equal(airReleasedFor(otherChan).length, 0);
  });

  test("release_air fires the cue exactly once per real release", () => {
    const talker = fakeWs();
    const listener = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: listener, agencyId: AGENCY, channel: CHANNEL });
    __claimVoiceAirForTest({ agencyId: AGENCY, channel: CHANNEL, ws: talker, unitId: "U1" });

    __handleVoiceControlForTest(talker, "release_air");
    // A second release with the slot already gone must not re-broadcast.
    __handleVoiceControlForTest(talker, "release_air");
    assert.equal(airReleasedFor(listener).length, 1);
  });
});
