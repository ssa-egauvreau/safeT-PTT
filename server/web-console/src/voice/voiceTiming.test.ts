import { describe, expect, it } from "vitest";
import {
  RX_GAP_MS,
  TALK_ACTIVITY_FAST_POLL_MS,
  TALK_ACTIVITY_POLL_MS,
  TALK_SPURT_GAP_MS,
  VOICE_AIR_TTL_MS,
} from "./voiceTiming.js";

describe("voiceTiming constants", () => {
  it("matches docs/voice-timing.md", () => {
    expect(VOICE_AIR_TTL_MS).toBe(900);
    expect(TALK_SPURT_GAP_MS).toBe(300);
    expect(RX_GAP_MS).toBe(TALK_SPURT_GAP_MS);
    expect(TALK_ACTIVITY_POLL_MS).toBe(1200);
    expect(TALK_ACTIVITY_FAST_POLL_MS).toBe(400);
  });
});
