/**
 * `refreshSimulcastSockets` — sockets joined to a simulcast cache its member
 * channels at join time; deleting/editing the simulcast must re-resolve those
 * caches live. Without it, a deleted simulcast kept transmitting onto its old
 * member channels until the talker reconnected.
 *
 * These tests run without a database, so the resolver inside
 * refreshSimulcastSockets finds no simulcast row — exactly the deleted case.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";

import {
  __claimVoiceAirForTest,
  __registerVoiceMemberForTest,
  __resetVoiceRosterForTest,
  peekVoiceTransmittingTalker,
  refreshSimulcastSockets,
} from "../src/voiceRelay.js";

const AGENCY = 42;
const SIMULCAST = "All Call";
const MEMBER = "Green 1";

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

function parsed(ws: { sent: string[] }): Array<{ type?: string; code?: string; channel?: string }> {
  return ws.sent.map((s) => JSON.parse(s) as { type?: string; code?: string; channel?: string });
}

beforeEach(() => {
  __resetVoiceRosterForTest();
});

afterEach(() => {
  __resetVoiceRosterForTest();
});

describe("refreshSimulcastSockets (simulcast deleted)", () => {
  test("clears the cached fan-out, releases held member air, and notifies the talker", async () => {
    const talker = fakeWs();
    const listener = fakeWs();
    __registerVoiceMemberForTest({
      ws: talker,
      agencyId: AGENCY,
      channel: SIMULCAST,
      unitId: "DISPATCH",
      simulcastMemberChannels: [MEMBER],
    });
    __registerVoiceMemberForTest({ ws: listener, agencyId: AGENCY, channel: MEMBER });
    // The talker is mid-transmission: it holds the member channel's air.
    __claimVoiceAirForTest({ agencyId: AGENCY, channel: MEMBER, ws: talker, unitId: "DISPATCH" });

    await refreshSimulcastSockets(AGENCY, SIMULCAST);

    // The member channel's air clears immediately (and the cue reaches its listeners).
    assert.equal(peekVoiceTransmittingTalker(AGENCY, MEMBER), null);
    assert.ok(parsed(listener).some((m) => m.type === "air_released" && m.channel === MEMBER));
    // The talker is told its channel no longer exists.
    assert.ok(parsed(talker).some((m) => m.type === "error" && m.code === "unknown_channel"));
  });

  test("does not touch sockets on other channels or plain (non-simulcast) joins", async () => {
    const plain = fakeWs();
    const otherSim = fakeWs();
    __registerVoiceMemberForTest({ ws: plain, agencyId: AGENCY, channel: SIMULCAST });
    __registerVoiceMemberForTest({
      ws: otherSim,
      agencyId: AGENCY,
      channel: "Other Sim",
      simulcastMemberChannels: [MEMBER],
    });
    __claimVoiceAirForTest({ agencyId: AGENCY, channel: MEMBER, ws: otherSim, unitId: "U2" });

    await refreshSimulcastSockets(AGENCY, SIMULCAST);

    // The plain join on the same name gets no error; the other simulcast keeps its air.
    assert.equal(parsed(plain).length, 0);
    assert.equal(peekVoiceTransmittingTalker(AGENCY, MEMBER)?.unit_id, "U2");
  });

  test("tenant isolation: another agency's same-named simulcast is untouched", async () => {
    const otherAgency = fakeWs();
    __registerVoiceMemberForTest({
      ws: otherAgency,
      agencyId: AGENCY + 1,
      channel: SIMULCAST,
      simulcastMemberChannels: [MEMBER],
    });
    __claimVoiceAirForTest({ agencyId: AGENCY + 1, channel: MEMBER, ws: otherAgency, unitId: "U9" });

    await refreshSimulcastSockets(AGENCY, SIMULCAST);

    assert.equal(parsed(otherAgency).length, 0);
    assert.equal(peekVoiceTransmittingTalker(AGENCY + 1, MEMBER)?.unit_id, "U9");
  });
});
