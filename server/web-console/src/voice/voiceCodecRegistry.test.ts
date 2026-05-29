import { describe, expect, it } from "vitest";
import {
  codecMagic,
  detectFrameCodec,
  isVoiceCodec,
  VOICE_CODECS,
} from "./voiceCodecRegistry.js";
import { releaseAirControlJson } from "./voiceTiming.js";

describe("voiceCodecRegistry", () => {
  it("detectFrameCodec identifies magic bytes", () => {
    expect(detectFrameCodec(new Uint8Array([0xf5, 0xab]))).toBe("imbe");
    expect(detectFrameCodec(new Uint8Array([0xc2, 0x01]))).toBe("codec2_3200");
    expect(detectFrameCodec(new Uint8Array([0x4f, 0x70]))).toBe("opus");
    expect(detectFrameCodec(new Uint8Array([0x00, 0x00]))).toBeNull();
  });

  it("codecMagic round-trips", () => {
    for (const codec of VOICE_CODECS) {
      const m = codecMagic(codec);
      expect(detectFrameCodec(new Uint8Array([m.b0, m.b1]))).toBe(codec);
    }
  });

  it("isVoiceCodec guards join payloads", () => {
    expect(isVoiceCodec("opus")).toBe(true);
    expect(isVoiceCodec("nope")).toBe(false);
  });
});

describe("release_air control frame", () => {
  it("serializes to the relay protocol shape", () => {
    expect(releaseAirControlJson()).toBe('{"type":"release_air"}');
  });
});
