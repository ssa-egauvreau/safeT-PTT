// Server-side P25 IMBE decode — wraps the WebAssembly build of the bundled
// dvmvocoder. Each digital talk-spurt gets its own decoder, because IMBE
// decoding keeps frame-to-frame history; a shared decoder would let
// interleaved channels corrupt each other's saved audio.

type ImbeFactory = (typeof import("../vocoder/imbeModule.mjs"))["default"];
type ImbeModule = Awaited<ReturnType<ImbeFactory>>;

let modulePromise: Promise<ImbeModule | null> | null = null;
let codec: ImbeModule | null = null;

async function load(): Promise<ImbeModule | null> {
  try {
    const factory = (await import("../vocoder/imbeModule.mjs")).default;
    const mod = await factory();
    return mod._imbe_init() === 1 ? mod : null;
  } catch (error) {
    console.warn("IMBE vocoder unavailable — digital transmissions will not be recorded.", error);
    return null;
  }
}

/** Loads the IMBE vocoder once. Resolves false if it cannot load. */
export async function initServerImbe(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  if (codec) {
    console.log("Server IMBE vocoder ready.");
  }
  return codec !== null;
}

/** A decoder dedicated to one digital talk-spurt. Call free() when it ends. */
export interface ImbeStreamDecoder {
  /** Decodes a 13-byte IMBE frame (2-byte marker + 11-byte codeword) to 16 kHz PCM-16. */
  decode(frame: Buffer): Buffer | null;
  free(): void;
}

/** Creates an isolated IMBE decoder, or null if the vocoder is unavailable. */
export function createImbeDecoder(): ImbeStreamDecoder | null {
  const mod = codec;
  if (!mod) {
    return null;
  }
  const handle = mod._imbe_decoder_create();
  if (!handle) {
    return null;
  }
  let freed = false;
  return {
    decode(frame: Buffer): Buffer | null {
      if (freed || frame.length !== 13) {
        return null;
      }
      const codewordPtr = mod._malloc(11);
      const samplesPtr = mod._malloc(320);
      try {
        mod.HEAPU8.set(frame.subarray(2), codewordPtr);
        if (mod._imbe_decoder_decode(handle, codewordPtr, samplesPtr) !== 1) {
          return null;
        }
        // 160 samples at 8 kHz -> 320 samples at 16 kHz by duplication.
        const out = Buffer.allocUnsafe(640);
        const base = samplesPtr >> 1;
        for (let i = 0; i < 160; i++) {
          const sample = mod.HEAP16[base + i]!;
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
        mod._imbe_decoder_free(handle);
      }
    },
  };
}
