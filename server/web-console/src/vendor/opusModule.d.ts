// Types for the Emscripten-generated libopus module.
//
// The module itself (opusModule.js) is built from the libopus git
// submodule at android-app/app/src/main/cpp/opus pinned to v1.5.2 — see
// server/web-console/cpp/build-opus.sh for the rebuild recipe and
// android-app/app/src/main/cpp/CMakeLists.txt + ios-app/project.yml for
// the matching source-file enumerations that must stay in sync.
//
// Voice profile (16 kHz mono, 20 ms frames, 32 kbps, VOIP application,
// in-band FEC + 10 % packet-loss budget) is applied by the C bridge in
// cpp/opus_wasm.c when `_opus_init_encoder` is called. All three
// platforms share that configuration block byte-for-byte so any peer
// can decode any other peer's frames identically.

interface OpusWasmModule {
  /** Allocate and configure the singleton encoder with the VOIP voice
   *  profile (16 kHz mono, 32 kbps, in-band FEC, packet-loss-perc=10,
   *  complexity=8, DTX off). Returns 1 on success, 0 on any failure
   *  (encoder_create error or any CTL rejected). Idempotent — destroys
   *  + recreates if already allocated. */
  _opus_init_encoder(): number;
  /** Allocate the singleton decoder for 16 kHz mono. Returns 1 / 0.
   *  Idempotent — destroys + recreates if already allocated. */
  _opus_init_decoder(): number;
  /** Recreate the singleton encoder at a talk-spurt boundary so prior
   *  LPC / pitch / FEC LBRR state doesn't bleed into the new spurt. */
  _opus_reset_encoder(): number;
  /** Recreate the singleton decoder at an inbound talk-spurt boundary. */
  _opus_reset_decoder(): number;
  /** Encode 320 int16 samples at `pcmPtr` into an Opus packet written to
   *  `outPtr` (bounded by `outMax`). Returns the byte length (>0) or a
   *  negative opus_int32 error code. */
  _opus_encode_frame(pcmPtr: number, outPtr: number, outMax: number): number;
  /** Decode an Opus packet at `inPtr` (length `inLen`) into 320 int16
   *  samples at `pcmOutPtr`. Returns 320 on success or a negative error. */
  _opus_decode_frame(inPtr: number, inLen: number, pcmOutPtr: number): number;
  /** Reconstruct the previous (lost) frame from the LBRR data inside
   *  `nextInPtr`. Returns 320 samples (the recovered prior frame) or
   *  a negative error. The caller must follow with a regular
   *  `_opus_decode_frame(nextInPtr, ...)` to play the actual audio of
   *  the new packet — opus_decode is stateful. */
  _opus_decode_fec_frame(nextInPtr: number, nextLen: number, pcmOutPtr: number): number;

  // Per-talk-spurt decoder factories — used by the server recorder.
  /** Allocate a dedicated decoder; returns the OpusDecoder* (>0) or 0. */
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
