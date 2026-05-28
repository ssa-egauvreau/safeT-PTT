// Server-side libcodec2 decode — wraps the WebAssembly build of libcodec2
// (the same artifact the web console uses, copied here for the recorder
// path). Each digital talk-spurt gets its own decoder, because codec2's
// internal LPC + pitch + sine state carries across frames; a shared
// decoder would let interleaved channels corrupt each other's saved
// audio.
//
// Used by the recorder when a Codec2 (mode 3200) frame arrives without
// the clear-PCM sideband — gives Whisper a transcribable PCM stream
// without having to wait for the sideband bandwidth on bandwidth-
// constrained channels.

const CODEC2_MODE_3200 = 0;
const CODEC2_FRAME_SAMPLES = 160;
const CODEC2_FRAME_BYTES = 8;

type Codec2Factory = (typeof import("../vocoder/codec2Module.mjs"))["default"];
type Codec2Module = Awaited<ReturnType<Codec2Factory>>;

let modulePromise: Promise<Codec2Module | null> | null = null;
let codec: Codec2Module | null = null;

async function load(): Promise<Codec2Module | null> {
  try {
    const factory = (await import("../vocoder/codec2Module.mjs")).default;
    const mod = await factory();
    // Verify mode 3200 frame layout at init so a future libcodec2 release
    // that changed those constants would surface here rather than as
    // corrupted recordings later.
    const probe = mod._codec2_create(CODEC2_MODE_3200);
    if (!probe) {
      console.warn("Server Codec2 vocoder: codec2_create returned 0 — recordings of Codec2 frames will skip the direct-decode path.");
      return null;
    }
    const samplesOk = mod._codec2_samples_per_frame(probe) === CODEC2_FRAME_SAMPLES;
    const bytesOk = mod._codec2_bytes_per_frame(probe) === CODEC2_FRAME_BYTES;
    mod._codec2_destroy(probe);
    if (!samplesOk || !bytesOk) {
      console.warn("Server Codec2 vocoder: mode 3200 frame layout mismatch — direct-decode disabled.");
      return null;
    }
    return mod;
  } catch (error) {
    console.warn("Codec2 vocoder unavailable — Codec2 transmissions will fall back to the clear-PCM sideband for recording.", error);
    return null;
  }
}

/** Loads the libcodec2 WASM once. Resolves false if it cannot load. */
export async function initServerCodec2(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  if (codec) {
    console.log("Server Codec2 vocoder ready.");
  }
  return codec !== null;
}

/** A decoder dedicated to one digital talk-spurt. Call free() when it ends. */
export interface Codec2StreamDecoder {
  /** Decodes a 10-byte framed Codec2 packet (2-byte magic + 8-byte codeword)
   *  to 16 kHz PCM-16. Returns null on size mismatch or codec failure. */
  decode(framed: Buffer): Buffer | null;
  free(): void;
}

/** Creates an isolated Codec2 decoder, or null if the vocoder is unavailable.
 *  Mirrors the shape of [createImbeDecoder] so the recorder can dispatch by
 *  codec without caring which native lib is doing the work. */
export function createCodec2Decoder(): Codec2StreamDecoder | null {
  const mod = codec;
  if (!mod) {
    return null;
  }
  const state = mod._codec2_create(CODEC2_MODE_3200);
  if (!state) {
    return null;
  }
  let freed = false;
  return {
    decode(framed: Buffer): Buffer | null {
      // 2-byte magic + 8-byte codeword. Caller is the recorder, which has
      // already detected the codec from the leading magic; we still verify
      // length here so a misrouted frame can't crash the decoder.
      if (freed || framed.length !== 2 + CODEC2_FRAME_BYTES) {
        return null;
      }
      const codewordPtr = mod._malloc(CODEC2_FRAME_BYTES);
      const samplesPtr = mod._malloc(CODEC2_FRAME_SAMPLES * 2);
      try {
        mod.HEAPU8.set(framed.subarray(2), codewordPtr);
        mod._codec2_decode(state, samplesPtr, codewordPtr);
        const base = samplesPtr >> 1;
        const samples8k = mod.HEAP16.slice(base, base + CODEC2_FRAME_SAMPLES);
        // 160 samples @ 8 kHz → 320 samples @ 16 kHz by duplication.
        // Mirrors imbeServerCodec's upsample so transcription and stored
        // recordings come out at the same sample rate regardless of codec.
        const out = Buffer.allocUnsafe(CODEC2_FRAME_SAMPLES * 2 * 2);
        for (let i = 0; i < CODEC2_FRAME_SAMPLES; i++) {
          const sample = samples8k[i];
          out.writeInt16LE(sample, i * 4);
          out.writeInt16LE(sample, i * 4 + 2);
        }
        return out;
      } finally {
        mod._free(codewordPtr);
        mod._free(samplesPtr);
      }
    },
    free() {
      if (!freed) {
        freed = true;
        mod._codec2_destroy(state);
      }
    },
  };
}
