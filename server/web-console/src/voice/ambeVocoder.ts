// Browser-side AMBE+2 half-rate vocoder (the P25 Phase 2 / DMR vocoder rate,
// 49 voice bits @ 2450 bps in a 9-byte DMR-interleaved codeword) — wraps the
// same WebAssembly build of the bundled dvmvocoder that the IMBE path uses
// (see cpp/build-vocoder.sh). Loaded on demand; best-effort.

import { ImbeAgc } from "./imbeAgc";

type ImbeFactory = (typeof import("../vendor/imbeModule.js"))["default"];
type ImbeModule = Awaited<ReturnType<ImbeFactory>>;

let modulePromise: Promise<ImbeModule | null> | null = null;
let codec: ImbeModule | null = null;

// The bundled WASM vocoder ships without its receive AGC enabled, so decoded
// AMBE audio is normalised here instead — ImbeAgc is the generic MBE receive
// ramp shared with the IMBE path. The global decoder is single-stream, so a
// single AGC instance matches.
const agc = new ImbeAgc();

async function load(): Promise<ImbeModule | null> {
  try {
    const factory = (await import("../vendor/imbeModule.js")).default;
    const mod = await factory();
    if (mod._ambe_init() === 1) {
      return mod;
    }
    console.warn("[ambe] _ambe_init() did not return 1 — vocoder will be unavailable");
    return null;
  } catch (err) {
    console.warn("[ambe] failed to load WASM vocoder — uplink/downlink will fall back to IMBE or clear PCM:", err);
    return null;
  }
}

/** Loads the AMBE WASM vocoder once. Resolves false if it cannot load. */
export async function initAmbe(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  return codec !== null;
}

/** True once the vocoder has loaded and can encode/decode. */
export function ambeReady(): boolean {
  return codec !== null;
}

/** Decodes a 9-byte AMBE codeword to 160 PCM samples at 8 kHz; null if unavailable. */
export function ambeDecode(codeword: Uint8Array): Int16Array | null {
  const mod = codec;
  if (!mod || codeword.length !== 9) {
    return null;
  }
  const codewordPtr = mod._malloc(9);
  const samplesPtr = mod._malloc(320);
  try {
    mod.HEAPU8.set(codeword, codewordPtr);
    if (mod._ambe_decode(codewordPtr, samplesPtr) !== 1) {
      return null;
    }
    const samples = mod.HEAP16.slice(samplesPtr >> 1, (samplesPtr >> 1) + 160);
    agc.process(samples);
    return samples;
  } finally {
    mod._free(codewordPtr);
    mod._free(samplesPtr);
  }
}

/** Encodes 160 PCM samples (8 kHz) to a 9-byte AMBE codeword; null if unavailable. */
export function ambeEncode(samples: Int16Array): Uint8Array | null {
  const mod = codec;
  if (!mod || samples.length !== 160) {
    return null;
  }
  const samplesPtr = mod._malloc(320);
  const codewordPtr = mod._malloc(9);
  try {
    mod.HEAP16.set(samples, samplesPtr >> 1);
    if (mod._ambe_encode(samplesPtr, codewordPtr) !== 1) {
      return null;
    }
    return mod.HEAPU8.slice(codewordPtr, codewordPtr + 9);
  } finally {
    mod._free(samplesPtr);
    mod._free(codewordPtr);
  }
}
