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

describe("air_released cue on TTL reap (carrier drop)", () => {
  // Real radios emit a squelch tail when the carrier drops, not just when the
  // talker releases the PTT. The relay reaps a stale claim after VOICE_AIR_TTL_MS
  // when a talker's socket disappears without sending `release_air`; the cue
  // must fire on that path too so listeners hear the same end-of-air signal
  // they would have heard on an explicit release.

  /** Forge a slot whose `lastPcmMs` is far enough in the past that the next
   *  `peekVoiceTransmittingTalker` call observes it as TTL-expired and reaps it. */
  function stalePastTtlMs(): number {
    // The TTL constant is `900` (see VOICE_AIR_TTL_MS in voiceRelay.ts).
    // 1 hour ago is unambiguously stale and avoids coupling the test to the
    // exact constant — if the TTL bumps in a future PR, this test still
    // exercises the "long stale" path.
    return Date.now() - 60 * 60 * 1000;
  }

  test("stale slot reaped on peek broadcasts air_released to listeners", () => {
    const talker = fakeWs();
    const listener = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: listener, agencyId: AGENCY, channel: CHANNEL });
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: talker,
      unitId: "U1",
      lastPcmMs: stalePastTtlMs(),
    });

    // Reading the talker peek runs the lazy reaper. The slot is older than
    // VOICE_AIR_TTL_MS, so peek deletes it AND broadcasts the cue.
    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL), null);

    // The dead talker's socket is excluded by broadcastAirReleased's filter
    // (mirroring the explicit release_air path), so the cue lands on the
    // listener only.
    assert.equal(airReleasedFor(talker).length, 0);
    const got = airReleasedFor(listener);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.channel, CHANNEL);
  });

  test("stale slot reaped on peek with no listeners emits nothing", () => {
    // Only the talker is registered — the talker is excluded from the
    // broadcast (peer === from filter) and there is nobody else to notify,
    // so the reap completes without sending any frame.
    const talker = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: talker,
      unitId: "U1",
      lastPcmMs: stalePastTtlMs(),
    });

    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL), null);
    assert.equal(airReleasedFor(talker).length, 0);
  });

  test("stale slot reaped on an empty channel emits nothing", () => {
    // No clientMeta members at all — the broadcast iterates clientMeta and
    // finds no peers, so no frames are sent. The slot is still reaped.
    const ghostWs = fakeWs();
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: ghostWs,
      unitId: "GHOST",
      lastPcmMs: stalePastTtlMs(),
    });

    assert.equal(peekVoiceTransmittingTalker(AGENCY, CHANNEL), null);
    assert.equal(airReleasedFor(ghostWs).length, 0);
  });

  test("a second peek after TTL reap does not re-broadcast the cue", () => {
    // Idempotent contract: the slot is the source of truth, so once it is
    // deleted the broadcast cannot fire again until a new talker claims and
    // releases. A future bug that double-fires would have listeners playing
    // two roger beeps on every release — pin it.
    const talker = fakeWs();
    const listener = fakeWs();
    __registerVoiceMemberForTest({ ws: talker, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: listener, agencyId: AGENCY, channel: CHANNEL });
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: talker,
      unitId: "U1",
      lastPcmMs: stalePastTtlMs(),
    });

    // First peek: reaps + broadcasts.
    peekVoiceTransmittingTalker(AGENCY, CHANNEL);
    // Second peek: slot is gone, observation is a no-op.
    peekVoiceTransmittingTalker(AGENCY, CHANNEL);

    assert.equal(airReleasedFor(listener).length, 1);
  });

  test("TTL reap on one channel leaves a parallel active channel untouched", () => {
    // Two channels in the same agency, both with listeners. Only the green
    // channel's slot is stale. The reap must fire the cue ONLY on green —
    // the blue listeners hear nothing.
    const talkerGreen = fakeWs();
    const listenerGreen = fakeWs();
    const talkerBlue = fakeWs();
    const listenerBlue = fakeWs();
    __registerVoiceMemberForTest({ ws: talkerGreen, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: listenerGreen, agencyId: AGENCY, channel: CHANNEL });
    __registerVoiceMemberForTest({ ws: talkerBlue, agencyId: AGENCY, channel: "Blue 2" });
    __registerVoiceMemberForTest({ ws: listenerBlue, agencyId: AGENCY, channel: "Blue 2" });
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: CHANNEL,
      ws: talkerGreen,
      unitId: "G1",
      lastPcmMs: stalePastTtlMs(),
    });
    __claimVoiceAirForTest({
      agencyId: AGENCY,
      channel: "Blue 2",
      ws: talkerBlue,
      unitId: "B1",
      // Fresh slot — blue must NOT be reaped.
    });

    peekVoiceTransmittingTalker(AGENCY, CHANNEL);

    assert.equal(airReleasedFor(listenerGreen).length, 1);
    assert.equal(airReleasedFor(listenerBlue).length, 0);
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
