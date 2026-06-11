// Server-side AMBE+2 half-rate decode (the P25 Phase 2 / DMR vocoder rate) —
// wraps the WebAssembly build of the bundled dvmvocoder, same module as IMBE.
// Each digital talk-spurt gets its own decoder, because AMBE decoding keeps
// frame-to-frame history exactly like IMBE; a shared decoder would let
// interleaved channels corrupt each other's saved audio.

import { ImbeAgc } from "./imbeAgc.js";

type ImbeFactory = (typeof import("../vocoder/imbeModule.mjs"))["default"];
type ImbeModule = Awaited<ReturnType<ImbeFactory>>;

let modulePromise: Promise<ImbeModule | null> | null = null;
let codec: ImbeModule | null = null;

async function load(): Promise<ImbeModule | null> {
  try {
    const factory = (await import("../vocoder/imbeModule.mjs")).default;
    const mod = await factory();
    return mod._ambe_init() === 1 ? mod : null;
  } catch (error) {
    console.warn("AMBE vocoder unavailable — P25 Phase 2 transmissions will not be recorded.", error);
    return null;
  }
}

/** Loads the AMBE vocoder once. Resolves false if it cannot load. */
export async function initServerAmbe(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  if (codec) {
    console.log("Server AMBE (P25 Phase 2 half-rate) vocoder ready.");
  }
  return codec !== null;
}

/** A decoder dedicated to one digital talk-spurt. Call free() when it ends. */
export interface AmbeStreamDecoder {
  /** Decodes an 11-byte AMBE frame (2-byte marker + 9-byte codeword) to 16 kHz PCM-16. */
  decode(frame: Buffer): Buffer | null;
  free(): void;
}

/** Creates an isolated AMBE decoder, or null if the vocoder is unavailable. */
export function createAmbeDecoder(): AmbeStreamDecoder | null {
  const mod = codec;
  if (!mod) {
    return null;
  }
  const handle = mod._ambe_decoder_create();
  if (!handle) {
    return null;
  }
  let freed = false;
  // The bundled WASM vocoder ships without its receive AGC enabled; normalise
  // decoded AMBE audio here so stored recordings match uncompressed levels.
  // ImbeAgc is the generic MBE receive ramp — same one the IMBE path uses.
  const agc = new ImbeAgc();
  return {
    decode(frame: Buffer): Buffer | null {
      if (freed || frame.length !== 11) {
        return null;
      }
      const codewordPtr = mod._malloc(9);
      const samplesPtr = mod._malloc(320);
      try {
        mod.HEAPU8.set(frame.subarray(2), codewordPtr);
        if (mod._ambe_decoder_decode(handle, codewordPtr, samplesPtr) !== 1) {
          return null;
        }
        const base = samplesPtr >> 1;
        const samples = mod.HEAP16.slice(base, base + 160);
        agc.process(samples);
        // 160 samples at 8 kHz -> 320 samples at 16 kHz by duplication.
        const out = Buffer.allocUnsafe(640);
        for (let i = 0; i < 160; i++) {
          const sample = samples[i];
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
        mod._ambe_decoder_free(handle);
      }
    },
  };
}
