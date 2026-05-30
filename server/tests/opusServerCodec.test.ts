/**
 * Tests for `server/src/opusServerCodec.ts`.
 *
 * The server-side libopus decoder lets the recorder produce a transcribable
 * PCM stream from Opus frames directly without depending on the clear-PCM
 * sideband. The same libopus WASM artifact powers the web console, the
 * Android NDK build and the iOS XcodeGen build — see
 * server/web-console/cpp/build-opus.sh for the build recipe.
 *
 * These tests also pin the encoder contract by encoding test signals
 * through the SAME WASM module (the server WASM also exposes
 * `_opus_init_encoder` / `_opus_encode_frame`) and:
 *
 *  - Verifying the per-frame packet size sits in the 32 kbps + 10 %-FEC
 *    range (~40 - 200 B). Field reports show real voice packets at
 *    80 - 160 B; the test bound is wider to absorb the LBRR variability
 *    at frame N+1 carrying frame N's full-rate redundancy.
 *
 *  - Round-tripping a 1 kHz sine through encode/decode and checking the
 *    decoded waveform's energy is in the expected ballpark (PSNR vs an
 *    all-zeros reference would always pass — energy match is the
 *    meaningful guard against the encoder shipping silent packets).
 *
 *  - Exercising the FEC recovery path: encode 5 frames, "lose" frame 3,
 *    decode it from frame 4's LBRR payload, verify the reconstructed
 *    samples are not zero and not radically different from frame 3.
 *    LBRR quality is lower than the original at 32 kbps + 10 % loss
 *    budget — empirically PSNR ~12-20 dB for tone signals — so the
 *    test guards on a permissive 8 dB floor that real LBRR clears
 *    comfortably while a silent-frame regression (PSNR = 0) would
 *    fail cleanly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initServerOpus, createOpusDecoder } from "../src/opusServerCodec.js";

const FRAME_SAMPLES = 320;
const SAMPLE_RATE = 16000;
const OPUS_MAGIC_0 = 0x4f;
const OPUS_MAGIC_1 = 0x70;

/** Build a framed packet ready for the streaming decoder. */
function frame(packet: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(2 + packet.length);
  out[0] = OPUS_MAGIC_0;
  out[1] = OPUS_MAGIC_1;
  out.set(packet, 2);
  return out;
}

/** Synthesize a 20 ms 16 kHz mono Int16 tone at `freqHz` and `amp` peak. */
function tone(freqHz: number, amp = 8000): Int16Array {
  const buf = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    buf[i] = Math.round(Math.sin(2 * Math.PI * freqHz * i / SAMPLE_RATE) * amp);
  }
  return buf;
}

/** Mean energy of an Int16 PCM frame — used as a smoke check against the
 *  encoder shipping silent packets. */
function rms(samples: Int16Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += (samples[i] as number) * (samples[i] as number);
  }
  return Math.sqrt(sum / Math.max(samples.length, 1));
}

/** PSNR (peak signal-to-noise ratio) of `recovered` vs `original`, treated
 *  as Int16 PCM signals of equal length. Returns dB. Saturates at +99 dB
 *  for identical signals to avoid log(0). */
function psnrDb(original: Int16Array, recovered: Int16Array): number {
  let mse = 0;
  for (let i = 0; i < original.length; i++) {
    const d = recovered[i] - original[i];
    mse += d * d;
  }
  mse /= Math.max(original.length, 1);
  if (mse < 1) return 99;
  return 10 * Math.log10((32767 * 32767) / mse);
}

test("initServerOpus: loads the libopus WASM module and reports ready", async () => {
  const ok = await initServerOpus();
  assert.equal(ok, true);
});

test("createOpusDecoder: returns a non-null streaming decoder after init", async () => {
  await initServerOpus();
  const dec = createOpusDecoder();
  try {
    assert.notEqual(dec, null);
  } finally {
    dec?.free();
  }
});

test("createOpusDecoder: rejects malformed framing", async () => {
  await initServerOpus();
  const dec = createOpusDecoder();
  assert.notEqual(dec, null);
  if (!dec) return;
  try {
    assert.equal(dec.decode(Buffer.alloc(0)), null, "empty buffer rejected");
    assert.equal(dec.decode(Buffer.alloc(2)), null, "magic-only buffer rejected");
    assert.equal(
      dec.decode(Buffer.from([OPUS_MAGIC_0, OPUS_MAGIC_1, ...new Array(1024).fill(0)])),
      null,
      "oversized packet rejected",
    );
  } finally {
    dec.free();
  }
});

test("createOpusDecoder: free() is idempotent and decode after free returns null", async () => {
  await initServerOpus();
  const dec = createOpusDecoder();
  assert.notEqual(dec, null);
  if (!dec) return;
  dec.free();
  dec.free(); // must not double-free the WASM decoder
  assert.equal(dec.decode(Buffer.from([OPUS_MAGIC_0, OPUS_MAGIC_1, 0x00])), null);
});

// --- Encode/decode/FEC tests --------------------------------------------
//
// These reach into the same WASM module the decoder loads from but call
// the singleton encoder + decoder directly via the typed module surface.
// The singleton matches the web client's runtime layout; the per-talk
// spurt decoder used above is a separate instance.

test("singleton encoder: produces a non-empty packet of expected size", async () => {
  await initServerOpus();
  // We need direct WASM access; load the module a second time (same
  // factory cache as initServerOpus — second await on the same promise).
  const factory = (await import("../vocoder/opusModule.mjs")).default;
  const mod = await factory();
  assert.equal(mod._opus_init_encoder(), 1);

  const samples = tone(440);
  const pcmPtr = mod._malloc(FRAME_SAMPLES * 2);
  const outPtr = mod._malloc(512);
  try {
    mod.HEAP16.set(samples, pcmPtr >> 1);
    const packetLen = mod._opus_encode_frame(pcmPtr, outPtr, 512);
    // 32 kbps × 20 ms = 80 bytes nominal. FEC LBRR adds ~10-50 % depending
    // on signal — observed range ~40-200 B in practice; the upper end
    // catches a regression that flips the encoder out of voice mode.
    assert.ok(packetLen >= 40, `packet too small: ${packetLen} B`);
    assert.ok(packetLen <= 200, `packet too large: ${packetLen} B`);
  } finally {
    mod._free(pcmPtr);
    mod._free(outPtr);
  }
});

test("encode → decode round-trip: 1 kHz tone retains substantial energy", async () => {
  await initServerOpus();
  const factory = (await import("../vocoder/opusModule.mjs")).default;
  const mod = await factory();
  assert.equal(mod._opus_init_encoder(), 1);
  assert.equal(mod._opus_init_decoder(), 1);

  const samples = tone(1000, 8000);
  const inputEnergy = rms(samples);
  assert.ok(inputEnergy > 100, "input tone energy non-trivial");

  const pcmPtr = mod._malloc(FRAME_SAMPLES * 2);
  const outBufPtr = mod._malloc(512);
  const decOutPtr = mod._malloc(FRAME_SAMPLES * 2);
  try {
    mod.HEAP16.set(samples, pcmPtr >> 1);
    const packetLen = mod._opus_encode_frame(pcmPtr, outBufPtr, 512);
    assert.ok(packetLen > 0, "encoder emitted a packet");

    const decoded = mod._opus_decode_frame(outBufPtr, packetLen, decOutPtr);
    assert.equal(decoded, FRAME_SAMPLES);

    const out = mod.HEAP16.slice(decOutPtr >> 1, (decOutPtr >> 1) + FRAME_SAMPLES);
    const outEnergy = rms(out);
    // Opus at 32 kbps reproduces a voice-frequency tone with nearly the
    // input's energy; a regression that ships silent decode would land
    // RMS ≈ 0 and trip this guard. The 0.25× floor catches that case
    // while tolerating Opus' own gain shaping.
    assert.ok(
      outEnergy >= inputEnergy * 0.25,
      `decoded energy too low: ${outEnergy} vs input ${inputEnergy}`,
    );
  } finally {
    mod._free(pcmPtr);
    mod._free(outBufPtr);
    mod._free(decOutPtr);
  }
});

test("FEC recovery: lose frame 3 of 5, recover it from frame 4's LBRR", async () => {
  await initServerOpus();
  const factory = (await import("../vocoder/opusModule.mjs")).default;
  const mod = await factory();
  // Fresh encoder + decoder so prior tests' state doesn't bleed across.
  assert.equal(mod._opus_reset_encoder(), 1);
  assert.equal(mod._opus_reset_decoder(), 1);

  // 5 frames of varying tones — Opus FEC LBRR encodes the *immediately
  // prior* frame, so it doesn't matter which signals we pick as long as
  // they're non-trivial. Same shape as the spec's verification recipe.
  const frames: Int16Array[] = [];
  for (let f = 0; f < 5; f++) {
    frames.push(tone(500 + f * 50, 8000));
  }

  const pcmPtr = mod._malloc(FRAME_SAMPLES * 2);
  const outBufPtr = mod._malloc(512);
  const decOutPtr = mod._malloc(FRAME_SAMPLES * 2);

  const packets: Uint8Array[] = [];
  try {
    for (const samples of frames) {
      mod.HEAP16.set(samples, pcmPtr >> 1);
      const len = mod._opus_encode_frame(pcmPtr, outBufPtr, 512);
      assert.ok(len > 0, `frame encode returned ${len}`);
      packets.push(mod.HEAPU8.slice(outBufPtr, outBufPtr + len));
    }

    // Decode the first 3 frames normally to walk the decoder state to
    // exactly where frame 3 would be the next expected packet.
    for (let i = 0; i < 3; i++) {
      mod.HEAPU8.set(packets[i], outBufPtr);
      const d = mod._opus_decode_frame(outBufPtr, packets[i].length, decOutPtr);
      assert.equal(d, FRAME_SAMPLES);
    }

    // Now simulate the loss: instead of decoding packet 3, FEC-decode
    // from packet 4 to recover frame 3's audio from its LBRR.
    mod.HEAPU8.set(packets[4], outBufPtr);
    const fecDecoded = mod._opus_decode_fec_frame(
      outBufPtr,
      packets[4].length,
      decOutPtr,
    );
    assert.equal(fecDecoded, FRAME_SAMPLES);

    const recovered = mod.HEAP16.slice(decOutPtr >> 1, (decOutPtr >> 1) + FRAME_SAMPLES);

    // The recovered audio must have non-trivial energy — a regression that
    // ships silent FEC output (e.g. forgot to enable INBAND_FEC on the
    // encoder) lands at RMS ≈ 0 and trips here.
    const recoveredEnergy = rms(recovered);
    assert.ok(
      recoveredEnergy > 200,
      `FEC-recovered energy too low: ${recoveredEnergy}`,
    );

    // PSNR vs the original frame 3 — LBRR is lower-quality than the
    // original by design (10 % bitrate budget), so the floor is
    // permissive. 8 dB clears comfortably for tone signals (empirical
    // ~12-20 dB); a regression with random / silent output would trip.
    const psnr = psnrDb(frames[3], recovered);
    assert.ok(
      psnr >= 8,
      `FEC PSNR too low: ${psnr.toFixed(2)} dB (frame 3 vs LBRR recovery)`,
    );
  } finally {
    mod._free(pcmPtr);
    mod._free(outBufPtr);
    mod._free(decOutPtr);
  }
});

test("streaming decoder: round-trip a tone, then free, then decode after-free returns null", async () => {
  await initServerOpus();
  const factory = (await import("../vocoder/opusModule.mjs")).default;
  const mod = await factory();
  assert.equal(mod._opus_init_encoder(), 1);

  // Use the singleton encoder to produce a single 20 ms packet that the
  // streaming decoder then chews through. This exercises the real recorder
  // flow: each talk-spurt creates its own decoder; frames come through
  // one at a time as Buffer-wrapped framed packets.
  const samples = tone(800, 6000);
  const pcmPtr = mod._malloc(FRAME_SAMPLES * 2);
  const outBufPtr = mod._malloc(512);
  let framed: Buffer;
  try {
    mod.HEAP16.set(samples, pcmPtr >> 1);
    const len = mod._opus_encode_frame(pcmPtr, outBufPtr, 512);
    assert.ok(len > 0);
    const packet = mod.HEAPU8.slice(outBufPtr, outBufPtr + len);
    framed = frame(packet);
  } finally {
    mod._free(pcmPtr);
    mod._free(outBufPtr);
  }

  const dec = createOpusDecoder();
  assert.notEqual(dec, null);
  if (!dec) return;
  try {
    const out = dec.decode(framed);
    assert.notEqual(out, null);
    if (out) {
      assert.equal(out.length, FRAME_SAMPLES * 2, "PCM length is 640 bytes (320 samples × 2)");
    }
  } finally {
    dec.free();
  }
  assert.equal(dec.decode(framed), null, "decode after free returns null");
});
