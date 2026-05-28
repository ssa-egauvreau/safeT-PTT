/**
 * Voice codec wire identity for the web console.
 *
 * Mirrors `server/src/voiceCodecs.ts` and the Android/iOS enums so all four
 * ends agree byte-for-byte. Every voice frame the relay forwards starts
 * with the codec's two-byte magic prefix, which is how receivers route
 * each frame to the right decoder when channels can use different codecs.
 *
 * IMBE keeps its existing 0xF5 0xAB so older clients that predate this
 * registry stay on-wire compatible without any change.
 *
 * Codec2 and Opus magic bytes are reserved here so the web console can:
 *  - recognise inbound frames in those codecs and drop them with a clear
 *    log instead of feeding them into the speaker as raw PCM noise;
 *  - parse the `codec` field on the joined reply / `codec_change` push
 *    and surface it in the UI.
 *
 * Real Codec2 + Opus encode/decode lands in a follow-up PR when the
 * corresponding WASM modules are vendored.
 */

export const VOICE_CODECS = ["imbe", "codec2_3200", "opus"] as const;
export type VoiceCodec = (typeof VOICE_CODECS)[number];

export const DEFAULT_VOICE_CODEC: VoiceCodec = "imbe";

interface CodecMagic {
  readonly b0: number;
  readonly b1: number;
}

const CODEC_MAGIC: Record<VoiceCodec, CodecMagic> = {
  imbe: { b0: 0xf5, b1: 0xab },
  codec2_3200: { b0: 0xc2, b1: 0x01 },
  opus: { b0: 0x4f, b1: 0x70 },
};

/** First two bytes of an inbound voice frame → which codec they identify. */
export function detectFrameCodec(bytes: Uint8Array): VoiceCodec | null {
  if (bytes.length < 2) return null;
  for (const codec of VOICE_CODECS) {
    const m = CODEC_MAGIC[codec];
    if (bytes[0] === m.b0 && bytes[1] === m.b1) {
      return codec;
    }
  }
  return null;
}

export function codecMagic(codec: VoiceCodec): CodecMagic {
  return CODEC_MAGIC[codec];
}

export function isVoiceCodec(value: unknown): value is VoiceCodec {
  return (
    typeof value === "string" &&
    (VOICE_CODECS as readonly string[]).includes(value)
  );
}

/** Codecs the web console can currently encode (TX). IMBE only today;
 *  add to this list when Codec2 / Opus WASM are wired up. */
export const WEB_ENCODE_CAPS: readonly VoiceCodec[] = ["imbe"];

/** Codecs the web console can currently decode (RX). IMBE only today;
 *  Codec2 / Opus frames are recognised but dropped until their decoders
 *  ship. */
export const WEB_DECODE_CAPS: readonly VoiceCodec[] = ["imbe"];
