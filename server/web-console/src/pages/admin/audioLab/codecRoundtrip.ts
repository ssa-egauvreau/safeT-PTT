// Audio Lab vocoder round-trip — IMBE, Codec2 3200, Opus, or AMBE+2 2450 (same wire format as live voice).

import type { VoiceCodec } from "../../../api";
import { ambeDecode, ambeEncode, ambeReady, initAmbe } from "../../../voice/ambeVocoder";
import { codec2Decode, codec2Encode, codec2Ready, initCodec2 } from "../../../voice/codec2Vocoder";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "../../../voice/imbeVocoder";
import { opusDecode, opusEncode, opusReady, initOpus } from "../../../voice/opusWasmCodec";
import {
  downsample16To8,
  upsampleDup8To16,
  upsampleLinear8To16,
  upsamplePolyphase8To16,
  type UpsampleMode,
} from "./pipeline";

const OPUS_FRAME_16K = 320;

function upsampleDecoded8k(decoded: Int16Array, mode: UpsampleMode): Int16Array {
  if (mode === "linear") {
    return upsampleLinear8To16(decoded);
  }
  if (mode === "polyphase" || mode === "polyphase24") {
    return upsamplePolyphase8To16(decoded);
  }
  return upsampleDup8To16(decoded);
}

async function ensureCodecReady(codec: VoiceCodec): Promise<void> {
  if (codec === "imbe") {
    if (!imbeReady()) {
      const ok = await initImbe();
      if (!ok) throw new Error("IMBE vocoder unavailable — WASM failed to load");
    }
    return;
  }
  if (codec === "codec2_3200") {
    if (!codec2Ready()) {
      const ok = await initCodec2();
      if (!ok) throw new Error("Codec2 vocoder unavailable — WASM failed to load");
    }
    return;
  }
  if (codec === "ambe_2450") {
    if (!ambeReady()) {
      const ok = await initAmbe();
      if (!ok) throw new Error("AMBE vocoder unavailable — WASM failed to load");
    }
    return;
  }
  if (!opusReady()) {
    const ok = await initOpus();
    if (!ok) throw new Error("Opus vocoder unavailable — WASM failed to load");
  }
}

/** Encode → decode the conditioned 16 kHz clip; returns 16 kHz PCM for post-decode shaping. */
export async function runLabCodecRoundtrip(
  conditioned: Int16Array,
  codec: VoiceCodec,
  upsampleMode: UpsampleMode,
): Promise<Int16Array> {
  await ensureCodecReady(codec);

  if (codec === "opus") {
    const decoded = new Int16Array(conditioned.length);
    let outOff = 0;
    for (let off = 0; off + OPUS_FRAME_16K <= conditioned.length; off += OPUS_FRAME_16K) {
      const packet = opusEncode(conditioned.subarray(off, off + OPUS_FRAME_16K));
      if (!packet) continue;
      const frame = opusDecode(packet);
      if (!frame) continue;
      decoded.set(frame, outOff);
      outOff += OPUS_FRAME_16K;
    }
    return decoded.subarray(0, outOff);
  }

  const pcm8k = downsample16To8(conditioned);
  const decoded8k = new Int16Array(pcm8k.length);
  let outOff = 0;

  if (codec === "imbe") {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = imbeEncode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = imbeDecode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  } else if (codec === "ambe_2450") {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = ambeEncode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = ambeDecode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  } else {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = codec2Encode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = codec2Decode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  }

  return upsampleDecoded8k(decoded8k.subarray(0, outOff), upsampleMode);
}

/** Production-style round-trip (dup upsample for 8 kHz codecs; Opus stays 16 kHz). */
export async function runLabCodecRoundtripProduction(
  conditioned: Int16Array,
  codec: VoiceCodec,
): Promise<Int16Array> {
  await ensureCodecReady(codec);

  if (codec === "opus") {
    const decoded = new Int16Array(conditioned.length);
    let outOff = 0;
    for (let off = 0; off + OPUS_FRAME_16K <= conditioned.length; off += OPUS_FRAME_16K) {
      const packet = opusEncode(conditioned.subarray(off, off + OPUS_FRAME_16K));
      if (!packet) continue;
      const frame = opusDecode(packet);
      if (!frame) continue;
      decoded.set(frame, outOff);
      outOff += OPUS_FRAME_16K;
    }
    return decoded.subarray(0, outOff);
  }

  const pcm8k = downsample16To8(conditioned);
  const decoded8k = new Int16Array(pcm8k.length);
  let outOff = 0;

  if (codec === "imbe") {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = imbeEncode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = imbeDecode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  } else if (codec === "ambe_2450") {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = ambeEncode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = ambeDecode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  } else {
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = codec2Encode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = codec2Decode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
  }

  return upsampleDup8To16(decoded8k.subarray(0, outOff));
}
