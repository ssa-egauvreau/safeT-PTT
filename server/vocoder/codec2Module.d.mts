// Types for the Emscripten-generated libcodec2 module.
// The module itself (codec2Module.js) is built from the libcodec2 git
// submodule at android-app/app/src/main/cpp/codec2 — see
// android-app/app/src/main/cpp/codec2_generated/README.md for the
// rebuild recipe. Voice profile: mode 3200 (20 ms frames, 160 samples
// per frame @ 8 kHz, 8 bytes per codeword).

interface Codec2WasmModule {
  /** Create a codec2 state for `mode` (e.g. 0 = CODEC2_MODE_3200).
   *  Returns 0 on failure; otherwise an opaque pointer (uint32). */
  _codec2_create(mode: number): number;
  _codec2_destroy(state: number): void;
  /** Encode 160 PCM samples (Int16, 8 kHz mono) referenced by
   *  `speechInPtr` into an 8-byte codeword written to `bytesPtr`. */
  _codec2_encode(state: number, bytesPtr: number, speechInPtr: number): void;
  /** Decode an 8-byte codeword at `bytesPtr` into 160 PCM samples
   *  written to `speechOutPtr`. */
  _codec2_decode(state: number, speechOutPtr: number, bytesPtr: number): void;
  _codec2_samples_per_frame(state: number): number;
  _codec2_bytes_per_frame(state: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAPU8: Uint8Array;
}

declare const createCodec2Module: (
  options?: Record<string, unknown>,
) => Promise<Codec2WasmModule>;
export default createCodec2Module;
