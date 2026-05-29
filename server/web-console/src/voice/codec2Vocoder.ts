// Browser-side libcodec2 vocoder — wraps the WebAssembly build of the
// libcodec2 submodule (see cpp/codec2_generated/README.md for the rebuild
// recipe). Mode 3200: 20 ms frames @ 8 kHz, 160 samples per frame, 8-byte
// codeword. Same wire format and frame layout as the Android NDK and iOS
// Xcode builds.
//
// Loaded on demand: a dispatcher console that never sees a Codec2
// channel never pays the ~270 KB WASM load cost.

type Codec2Factory = (typeof import("../vendor/codec2Module.js"))["default"];
type Codec2Module = Awaited<ReturnType<Codec2Factory>>;

const CODEC2_MODE_3200 = 0;
const CODEC2_FRAME_SAMPLES = 160;
const CODEC2_FRAME_BYTES = 8;

let modulePromise: Promise<Codec2Module | null> | null = null;
let codec: Codec2Module | null = null;
/** Singleton encoder + decoder state pointers, allocated on first use. */
let encoderState = 0;
let decoderState = 0;

async function load(): Promise<Codec2Module | null> {
  try {
    const factory = (await import("../vendor/codec2Module.js")).default;
    const mod = await factory();
    const enc = mod._codec2_create(CODEC2_MODE_3200);
    const dec = mod._codec2_create(CODEC2_MODE_3200);
    if (!enc || !dec) {
      console.warn("[codec2] codec2_create returned 0 — vocoder unavailable");
      if (enc) mod._codec2_destroy(enc);
      if (dec) mod._codec2_destroy(dec);
      return null;
    }
    if (
      mod._codec2_samples_per_frame(enc) !== CODEC2_FRAME_SAMPLES ||
      mod._codec2_bytes_per_frame(enc) !== CODEC2_FRAME_BYTES
    ) {
      // A future libcodec2 release that changes mode 3200 — fail fast
      // rather than corrupt wire data.
      console.warn(
        "[codec2] mode 3200 frame layout mismatch — vocoder disabled",
      );
      mod._codec2_destroy(enc);
      mod._codec2_destroy(dec);
      return null;
    }
    encoderState = enc;
    decoderState = dec;
    return mod;
  } catch (err) {
    console.warn(
      "[codec2] failed to load WASM vocoder — Codec2 channels will fall back to IMBE on TX and drop inbound frames:",
      err,
    );
    return null;
  }
}

/** Loads the libcodec2 WASM vocoder once. Resolves false if it cannot
 *  load — caller may retry by triggering [initCodec2] again later. */
export async function initCodec2(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  return codec !== null;
}

/** True once the vocoder has loaded and can encode/decode. */
export function codec2Ready(): boolean {
  return codec !== null;
}

/** Encode 160 PCM samples (Int16 @ 8 kHz mono) to an 8-byte codeword.
 *  Returns null if the vocoder hasn't loaded yet or the input is the
 *  wrong size. */
export function codec2Encode(samples: Int16Array): Uint8Array | null {
  const mod = codec;
  if (!mod || samples.length !== CODEC2_FRAME_SAMPLES) {
    return null;
  }
  const samplesPtr = mod._malloc(CODEC2_FRAME_SAMPLES * 2);
  const codewordPtr = mod._malloc(CODEC2_FRAME_BYTES);
  try {
    mod.HEAP16.set(samples, samplesPtr >> 1);
    mod._codec2_encode(encoderState, codewordPtr, samplesPtr);
    return mod.HEAPU8.slice(codewordPtr, codewordPtr + CODEC2_FRAME_BYTES);
  } finally {
    mod._free(samplesPtr);
    mod._free(codewordPtr);
  }
}

/** Decode an 8-byte codeword to 160 PCM samples (Int16 @ 8 kHz mono).
 *  Returns null if the vocoder hasn't loaded yet or the input is the
 *  wrong size. */
export function codec2Decode(codeword: Uint8Array): Int16Array | null {
  const mod = codec;
  if (!mod || codeword.length !== CODEC2_FRAME_BYTES) {
    return null;
  }
  const codewordPtr = mod._malloc(CODEC2_FRAME_BYTES);
  const samplesPtr = mod._malloc(CODEC2_FRAME_SAMPLES * 2);
  try {
    mod.HEAPU8.set(codeword, codewordPtr);
    mod._codec2_decode(decoderState, samplesPtr, codewordPtr);
    return mod.HEAP16.slice(samplesPtr >> 1, (samplesPtr >> 1) + CODEC2_FRAME_SAMPLES);
  } finally {
    mod._free(codewordPtr);
    mod._free(samplesPtr);
  }
}

/** Codec2 LPC/pitch state carries across frames — recreate encoder at TX spurt start/end. */
export function resetCodec2EncoderForTalkSpurt(): void {
  const mod = codec;
  if (!mod) return;
  if (encoderState) {
    mod._codec2_destroy(encoderState);
    encoderState = 0;
  }
  encoderState = mod._codec2_create(CODEC2_MODE_3200);
}

/** Fresh decoder for a new inbound talk-spurt (matches server recorder per-spurt decoders). */
export function resetCodec2DecoderForTalkSpurt(): void {
  const mod = codec;
  if (!mod) return;
  if (decoderState) {
    mod._codec2_destroy(decoderState);
    decoderState = 0;
  }
  decoderState = mod._codec2_create(CODEC2_MODE_3200);
}
