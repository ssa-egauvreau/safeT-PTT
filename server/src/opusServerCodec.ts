// Server-side libopus decode — wraps the WebAssembly build of libopus
// (the same artifact the web console uses, copied here for the recorder
// path). Each digital talk-spurt gets its own decoder, because libopus
// state carries frame-to-frame (LPC + pitch + LBRR window in particular);
// a shared decoder would let interleaved channels corrupt each other's
// saved audio.
//
// Used by the recorder when an Opus frame arrives without the clear-PCM
// sideband — gives Whisper a transcribable PCM stream without having to
// wait for the sideband on bandwidth-constrained channels.
//
// Mirrors codec2ServerCodec.ts and imbeServerCodec.ts so the recorder
// can dispatch by codec without caring which native lib does the work.

const OPUS_FRAME_SAMPLES = 320; // 20 ms @ 16 kHz

type OpusFactory = (typeof import("../vocoder/opusModule.mjs"))["default"];
type OpusModule = Awaited<ReturnType<OpusFactory>>;

let modulePromise: Promise<OpusModule | null> | null = null;
let codec: OpusModule | null = null;

async function load(): Promise<OpusModule | null> {
  try {
    const factory = (await import("../vocoder/opusModule.mjs")).default;
    const mod = await factory();
    // Probe by allocating + releasing one decoder so a malformed WASM (or
    // an emscripten build that didn't expose the symbols we need) surfaces
    // here rather than later as "recordings of Opus frames are silent".
    const probe = mod._opus_decoder_make();
    if (!probe) {
      console.warn("Server Opus vocoder: opus_decoder_create returned 0 — recordings of Opus frames will skip the direct-decode path.");
      return null;
    }
    mod._opus_decoder_release(probe);
    return mod;
  } catch (error) {
    console.warn("Opus vocoder unavailable — Opus transmissions will fall back to the clear-PCM sideband for recording.", error);
    return null;
  }
}

/** Loads the libopus WASM once. Resolves false if it cannot load. */
export async function initServerOpus(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  if (codec) {
    console.log("Server Opus vocoder ready.");
  }
  return codec !== null;
}

/** A decoder dedicated to one digital talk-spurt. Call free() when it ends.
 *  Same shape as Codec2StreamDecoder / ImbeStreamDecoder so the recorder
 *  can call decode/free without caring which codec is running. */
export interface OpusStreamDecoder {
  /** Decodes a framed Opus packet (2-byte magic + opaque Opus packet) to
   *  16 kHz PCM-16. Returns null on size mismatch or codec failure.
   *
   *  Output: 320 samples × 2 bytes/sample = 640 bytes of PCM-16 LE.
   *  Unlike the IMBE / Codec2 server decoders which duplicate 8 kHz → 16 kHz,
   *  libopus already decodes at 16 kHz natively, so the output is single-rate. */
  decode(framed: Buffer): Buffer | null;
  free(): void;
}

/** Creates an isolated Opus decoder, or null if the vocoder is unavailable. */
export function createOpusDecoder(): OpusStreamDecoder | null {
  const mod = codec;
  if (!mod) {
    return null;
  }
  const state = mod._opus_decoder_make();
  if (!state) {
    return null;
  }
  // Allocate per-decoder scratch buffers up-front so the hot path doesn't
  // malloc/free on every 20 ms frame.
  const pcmPtr = mod._malloc(OPUS_FRAME_SAMPLES * 2);
  // Generous bound matching the encoder side (OPUS_MAX_PACKET_BYTES in
  // opus_jni.cpp / opus_wasm.c). Inbound packets larger than this are
  // rejected as malformed — a 20 ms 32 kbps Opus packet is always well
  // under 256 B even with FEC LBRR; 512 leaves comfortable headroom.
  const MAX_PACKET_BYTES = 512;
  const inPtr = mod._malloc(MAX_PACKET_BYTES);
  let freed = false;

  return {
    decode(framed: Buffer): Buffer | null {
      if (freed) return null;
      // 2-byte magic + opaque payload. Caller (recorder.ts) has already
      // detected the codec from the leading magic; we still verify the
      // length bounds here so a misrouted frame can't crash the decoder.
      if (framed.length <= 2 || framed.length - 2 > MAX_PACKET_BYTES) {
        return null;
      }
      const payloadLen = framed.length - 2;
      // Copy the bare Opus packet (skip the 2-byte wire magic) into the
      // WASM heap input buffer.
      mod.HEAPU8.set(framed.subarray(2), inPtr);
      const samples = mod._opus_decoder_run(state, inPtr, payloadLen, pcmPtr);
      if (samples !== OPUS_FRAME_SAMPLES) {
        return null;
      }
      // Copy the decoded PCM out as a Node Buffer in LE byte order. The
      // recorder writes these straight into the in-flight WAV chunk list.
      const base = pcmPtr >> 1;
      const decoded = mod.HEAP16.subarray(base, base + OPUS_FRAME_SAMPLES);
      const out = Buffer.allocUnsafe(OPUS_FRAME_SAMPLES * 2);
      for (let i = 0; i < OPUS_FRAME_SAMPLES; i++) {
        out.writeInt16LE(decoded[i], i * 2);
      }
      return out;
    },
    free() {
      if (!freed) {
        freed = true;
        mod._free(pcmPtr);
        mod._free(inPtr);
        mod._opus_decoder_release(state);
      }
    },
  };
}
