// Types for the Node-side Emscripten-built libopus module. Mirror of
// server/web-console/src/vendor/opusModule.d.ts — the runtime artifact
// (opusModule.mjs) is the same WASM rebuilt for the `node` environment.
// See server/web-console/cpp/build-opus.sh for the build recipe.

interface OpusWasmModule {
  _opus_init_encoder(): number;
  _opus_init_decoder(): number;
  _opus_reset_encoder(): number;
  _opus_reset_decoder(): number;
  _opus_encode_frame(pcmPtr: number, outPtr: number, outMax: number): number;
  _opus_decode_frame(inPtr: number, inLen: number, pcmOutPtr: number): number;
  _opus_decode_fec_frame(nextInPtr: number, nextLen: number, pcmOutPtr: number): number;
  /** Per-talk-spurt decoder factory used by the recorder so concurrent
   *  channels don't share decoder state. Returns the OpusDecoder* (>0)
   *  or 0 on failure. */
  _opus_decoder_make(): number;
  _opus_decoder_release(dec: number): void;
  _opus_decoder_run(dec: number, inPtr: number, inLen: number, pcmOutPtr: number): number;

  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAPU8: Uint8Array;
}

declare const createOpusModule: (
  options?: Record<string, unknown>,
) => Promise<OpusWasmModule>;
export default createOpusModule;
