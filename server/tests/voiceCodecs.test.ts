/**
 * Tests for `server/src/voiceCodecs.ts`.
 *
 * The registry is the single source of truth for which codecs the relay
 * supports and how each codec's wire frames identify themselves. Every
 * client (Android/iOS/web) decodes by inspecting the first two magic bytes,
 * so any drift here cuts off audio across the platform. The recorder also
 * dispatches its server-side decoders by the same magic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODEC_MAGIC,
  DEFAULT_VOICE_CODEC,
  VOICE_CODECS,
  coerceVoiceCodec,
  detectFrameCodec,
  isVoiceCodec,
} from "../src/voiceCodecs.js";

test("VOICE_CODECS includes the four codecs the platform ships", () => {
  assert.deepEqual([...VOICE_CODECS].sort(), ["ambe_2450", "codec2_3200", "imbe", "opus"]);
});

test("DEFAULT_VOICE_CODEC is IMBE — the only codec older clients can speak", () => {
  assert.equal(DEFAULT_VOICE_CODEC, "imbe");
});

test("CODEC_MAGIC has a distinct two-byte prefix for every codec", () => {
  const seen = new Set<string>();
  for (const codec of VOICE_CODECS) {
    const magic = CODEC_MAGIC[codec];
    assert.equal(magic.length, 2, `codec ${codec} magic must be 2 bytes`);
    const key = `${magic[0]}-${magic[1]}`;
    assert.ok(!seen.has(key), `codec ${codec} magic collides with another codec`);
    seen.add(key);
  }
});

test("detectFrameCodec round-trips every codec's wire magic", () => {
  for (const codec of VOICE_CODECS) {
    const [b0, b1] = CODEC_MAGIC[codec];
    const frame = Buffer.from([b0, b1, 0x00, 0x00, 0x00]);
    assert.equal(detectFrameCodec(frame), codec);
  }
});

test("detectFrameCodec returns null for unknown / short buffers", () => {
  assert.equal(detectFrameCodec(Buffer.alloc(0)), null);
  assert.equal(detectFrameCodec(Buffer.from([0xff])), null);
  assert.equal(detectFrameCodec(Buffer.from([0x00, 0x00, 0x00])), null);
  // Clear-PCM sideband magics (0xF6 0xAC = 16 kHz, 0xF6 0xAD = 8 kHz from
  // voiceRelay.ts) are intentionally not codecs — they carry unvocoded PCM for
  // the recorder, not for relay.
  assert.equal(detectFrameCodec(Buffer.from([0xf6, 0xac, 0x00])), null);
  assert.equal(detectFrameCodec(Buffer.from([0xf6, 0xad, 0x00])), null);
});

test("isVoiceCodec validates admin-supplied strings", () => {
  for (const codec of VOICE_CODECS) {
    assert.equal(isVoiceCodec(codec), true);
  }
  assert.equal(isVoiceCodec("IMBE"), false, "case-sensitive on the wire");
  assert.equal(isVoiceCodec("ambe"), false);
  assert.equal(isVoiceCodec(""), false);
  assert.equal(isVoiceCodec(null), false);
  assert.equal(isVoiceCodec(42), false);
});

test("coerceVoiceCodec accepts exact and case-mismatched strings", () => {
  assert.equal(coerceVoiceCodec("opus"), "opus");
  assert.equal(coerceVoiceCodec("OPUS"), "opus");
  assert.equal(coerceVoiceCodec("Codec2_3200"), "codec2_3200");
});

test("coerceVoiceCodec falls back to the default for unknown / nullish input", () => {
  assert.equal(coerceVoiceCodec(null), DEFAULT_VOICE_CODEC);
  assert.equal(coerceVoiceCodec(undefined), DEFAULT_VOICE_CODEC);
  assert.equal(coerceVoiceCodec(""), DEFAULT_VOICE_CODEC);
  assert.equal(coerceVoiceCodec("ambe"), DEFAULT_VOICE_CODEC);
  assert.equal(coerceVoiceCodec(42), DEFAULT_VOICE_CODEC);
});
