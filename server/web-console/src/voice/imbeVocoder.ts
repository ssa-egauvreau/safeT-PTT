// Browser-side P25 IMBE vocoder — wraps the WebAssembly build of the bundled
// dvmvocoder (see cpp/build-vocoder.sh). Loaded on demand; best-effort.

import { ImbeAgc } from "./imbeAgc";

type ImbeFactory = (typeof import("../vendor/imbeModule.js"))["default"];
type ImbeModule = Awaited<ReturnType<ImbeFactory>>;

let modulePromise: Promise<ImbeModule | null> | null = null;
let codec: ImbeModule | null = null;

// The bundled WASM vocoder ships without its receive AGC enabled, so decoded
// IMBE audio is normalised here instead (see imbeAgc.ts). The global decoder
// is single-stream, so a single AGC instance matches.
const agc = new ImbeAgc();

async function load(): Promise<ImbeModule | null> {
  try {
    const factory = (await import("../vendor/imbeModule.js")).default;
    const mod = await factory();
    if (mod._imbe_init() === 1) {
      return mod;
    }
    console.warn("[imbe] _imbe_init() did not return 1 — vocoder will be unavailable");
    return null;
  } catch (err) {
    console.warn("[imbe] failed to load WASM vocoder — uplink/downlink will fall back to clear PCM:", err);
    return null;
  }
}

/** Loads the IMBE WASM vocoder once. Resolves false if it cannot load. */
export async function initImbe(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  return codec !== null;
}

/** True once the vocoder has loaded and can encode/decode. */
export function imbeReady(): boolean {
  return codec !== null;
}

/** Decodes an 11-byte IMBE codeword to 160 PCM samples at 8 kHz; null if unavailable. */
export function imbeDecode(codeword: Uint8Array): Int16Array | null {
  const mod = codec;
  if (!mod || codeword.length !== 11) {
    return null;
  }
  const codewordPtr = mod._malloc(11);
  const samplesPtr = mod._malloc(320);
  try {
    mod.HEAPU8.set(codeword, codewordPtr);
    if (mod._imbe_decode(codewordPtr, samplesPtr) !== 1) {
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

/** Encodes 160 PCM samples (8 kHz) to an 11-byte IMBE codeword; null if unavailable. */
export function imbeEncode(samples: Int16Array): Uint8Array | null {
  const mod = codec;
  if (!mod || samples.length !== 160) {
    return null;
  }
  const samplesPtr = mod._malloc(320);
  const codewordPtr = mod._malloc(11);
  try {
    mod.HEAP16.set(samples, samplesPtr >> 1);
    if (mod._imbe_encode(samplesPtr, codewordPtr) !== 1) {
      return null;
    }
    return mod.HEAPU8.slice(codewordPtr, codewordPtr + 11);
  } finally {
    mod._free(samplesPtr);
    mod._free(codewordPtr);
  }
}
