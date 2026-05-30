// Browser-side libopus encoder + decoder — wraps the WebAssembly build of
// libopus (see server/web-console/cpp/build-opus.sh for the rebuild
// recipe and android-app/app/src/main/cpp/CMakeLists.txt + ios-app/project.yml
// for the matching Android NDK and iOS XcodeGen source enumerations).
//
// Voice profile is configured by the C bridge in cpp/opus_wasm.c when
// `_opus_init_encoder` is called: 16 kHz mono, 20 ms frames, 32 kbps,
// VOIP application, in-band FEC enabled with a 10 % packet-loss budget,
// complexity 8, DTX off. All three platforms share that block byte for
// byte.
//
// This replaces the previous `opusEncoder.ts` / `opusDecoder.ts` pair,
// which wrapped the browser's WebCodecs `AudioEncoder` / `AudioDecoder`.
// WebCodecs exposed only bitrate as a knob, with no way to enable Opus
// in-band FEC — which is the whole reason this PR bundles libopus.
//
// Loaded on demand: the WASM module is ~358 KB on disk (~150 KB
// compressed); a dispatcher console that never joins an Opus channel
// never pays the load cost.

type OpusFactory = (typeof import("../vendor/opusModule.js"))["default"];
type OpusModule = Awaited<ReturnType<OpusFactory>>;

const OPUS_FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
/** Upper bound on a 20 ms 32 kbps Opus packet. Measured ~80-160 bytes
 *  for voice; 512 leaves headroom for FEC LBRR bloat and the rare
 *  CELT burst. opus_encode returns the actual length. */
const OPUS_MAX_PACKET_BYTES = 512;

let modulePromise: Promise<OpusModule | null> | null = null;
let codec: OpusModule | null = null;

async function load(): Promise<OpusModule | null> {
  try {
    const factory = (await import("../vendor/opusModule.js")).default;
    const mod = await factory();
    // Initialise the singleton encoder + decoder up-front so a later
    // `opusEncode` / `opusDecode` doesn't have to lazy-init on the
    // hot path. Either failure means the lib is broken — fall back
    // to IMBE on TX rather than ship malformed Opus on the wire.
    if (!mod._opus_init_encoder() || !mod._opus_init_decoder()) {
      console.warn(
        "[opus] libopus init failed — Opus channels will fall back to IMBE on TX and drop inbound frames.",
      );
      return null;
    }
    return mod;
  } catch (err) {
    console.warn(
      "[opus] failed to load libopus WASM — Opus channels will fall back to IMBE on TX and drop inbound frames:",
      err,
    );
    return null;
  }
}

/** Loads the libopus WASM module once. Resolves false if it cannot
 *  load — caller may retry by triggering [initOpus] again later. */
export async function initOpus(): Promise<boolean> {
  if (!modulePromise) {
    modulePromise = load();
  }
  codec = await modulePromise;
  return codec !== null;
}

/** True once the libopus WASM has loaded and configured cleanly. */
export function opusReady(): boolean {
  return codec !== null;
}

/** Encode 320 PCM samples (Int16 @ 16 kHz mono) to an Opus packet
 *  (bare, no wire-format magic prefix — the caller in voiceClient
 *  prepends it). Returns null if the codec hasn't loaded yet or the
 *  input is the wrong size. */
export function opusEncode(pcm320: Int16Array): Uint8Array | null {
  const mod = codec;
  if (!mod || pcm320.length !== OPUS_FRAME_SAMPLES) {
    return null;
  }
  const pcmPtr = mod._malloc(OPUS_FRAME_SAMPLES * 2);
  const outPtr = mod._malloc(OPUS_MAX_PACKET_BYTES);
  try {
    mod.HEAP16.set(pcm320, pcmPtr >> 1);
    const len = mod._opus_encode_frame(pcmPtr, outPtr, OPUS_MAX_PACKET_BYTES);
    if (len <= 0) return null;
    return mod.HEAPU8.slice(outPtr, outPtr + len);
  } finally {
    mod._free(pcmPtr);
    mod._free(outPtr);
  }
}

/** Decode an Opus packet (bare, no wire-format magic prefix — the caller
 *  in voiceClient strips it) to 320 PCM samples (Int16 @ 16 kHz mono).
 *  Returns null if the codec hasn't loaded yet or the packet was
 *  malformed. */
export function opusDecode(packet: Uint8Array): Int16Array | null {
  const mod = codec;
  if (!mod || packet.length === 0) {
    return null;
  }
  const inPtr = mod._malloc(packet.length);
  const outPtr = mod._malloc(OPUS_FRAME_SAMPLES * 2);
  try {
    mod.HEAPU8.set(packet, inPtr);
    const samples = mod._opus_decode_frame(inPtr, packet.length, outPtr);
    if (samples !== OPUS_FRAME_SAMPLES) return null;
    return mod.HEAP16.slice(outPtr >> 1, (outPtr >> 1) + OPUS_FRAME_SAMPLES);
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
  }
}

/** Reconstruct the previous (lost) frame from the LBRR data embedded in
 *  `nextPacket`. Returns 320 samples or null if FEC was unavailable on
 *  the prior packet or the call failed.
 *
 *  Single-frame recovery only: if two or more packets in a row were
 *  lost, only the immediately-prior frame can be recovered this way.
 *  After a successful call, the caller must follow with a regular
 *  [opusDecode] for `nextPacket` to play its actual audio.
 *
 *  Receiver-side wiring (jitter-buffer loss detection that triggers
 *  this call) is intentionally out of scope for the PR that introduces
 *  libopus and FEC encoding — it requires either an explicit wire
 *  sequence number (forbidden by the wire-format-stability rule) or
 *  an arrival-time heuristic with false-positive cost analysis. The
 *  hook is exposed here so a follow-up PR can light it up without
 *  retouching the WASM surface. */
export function opusDecodeFec(nextPacket: Uint8Array): Int16Array | null {
  const mod = codec;
  if (!mod || nextPacket.length === 0) {
    return null;
  }
  const inPtr = mod._malloc(nextPacket.length);
  const outPtr = mod._malloc(OPUS_FRAME_SAMPLES * 2);
  try {
    mod.HEAPU8.set(nextPacket, inPtr);
    const samples = mod._opus_decode_fec_frame(inPtr, nextPacket.length, outPtr);
    if (samples !== OPUS_FRAME_SAMPLES) return null;
    return mod.HEAP16.slice(outPtr >> 1, (outPtr >> 1) + OPUS_FRAME_SAMPLES);
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
  }
}

/** Fresh encoder state for a new outbound talk-spurt — clears the
 *  encoder's LPC / pitch / FEC LBRR history so a previous transmission's
 *  tail can't bleed into the first frame of this one. Mirrors
 *  [resetCodec2EncoderForTalkSpurt]. */
export function resetOpusEncoderForTalkSpurt(): void {
  const mod = codec;
  if (!mod) return;
  mod._opus_reset_encoder();
}

/** Fresh decoder state for a new inbound talk-spurt. Mirrors
 *  [resetCodec2DecoderForTalkSpurt]. */
export function resetOpusDecoderForTalkSpurt(): void {
  const mod = codec;
  if (!mod) return;
  mod._opus_reset_decoder();
}
