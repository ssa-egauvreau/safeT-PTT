/**
 * Tests for `server/src/imbeAgc.ts`.
 *
 * ImbeAgc is the receive-side automatic gain control applied to every decoded
 * P25 IMBE frame (8 kHz / 160 samples). Without it, digital recordings stored
 * by the server play back noticeably quieter than uncompressed PCM clips, so
 * any regression here directly damages the audio quality of archived
 * transmissions — and there's no visible error, just quiet playback.
 *
 * The gain-control algorithm has four sharp behaviours that need protection:
 *
 *  1. Hard skip on wrong frame size (defensive — must not corrupt buffers).
 *  2. Asymmetric response — instant attack on loud peaks, slow release on
 *     quiet stretches (≤5% per frame).
 *  3. Output clamp at ±32760 — must never wrap around (an int16 wrap on a
 *     loud talk-spurt sounds like a digital click on playback).
 *  4. Convergence — repeated identical quiet frames eventually reach the
 *     target peak (TARGET_PEAK=30000) without oscillating.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ImbeAgc } from "../src/imbeAgc.js";

const FRAME = 160;
const TARGET_PEAK = 30000;
const CLAMP = 32760;

function constantFrame(level: number): Int16Array {
  const f = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = level;
  return f;
}

function peak(frame: Int16Array): number {
  let p = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = Math.abs(frame[i]!);
    if (v > p) p = v;
  }
  return p;
}

test("ImbeAgc.process: ignores frames that are not exactly 160 samples (defensive)", () => {
  const agc = new ImbeAgc();
  // Use a recognisable sentinel buffer; if process() mutates it, we'll see.
  const tooShort = new Int16Array([1, 2, 3, 4, 5]);
  const tooLong = new Int16Array(FRAME + 10).fill(1000);
  const shortCopy = Int16Array.from(tooShort);
  const longCopy = Int16Array.from(tooLong);
  agc.process(tooShort);
  agc.process(tooLong);
  assert.deepEqual(Array.from(tooShort), Array.from(shortCopy), "short frame must not be mutated");
  assert.deepEqual(Array.from(tooLong), Array.from(longCopy), "oversized frame must not be mutated");
});

test("ImbeAgc.process: silent frame is left silent (no spurious gain on zero input)", () => {
  // A zero-peak frame would otherwise divide by zero in the gain formula; the
  // algorithm picks MAX_GAIN as a fallback but with zero samples the output
  // must still be zero everywhere.
  const agc = new ImbeAgc();
  const frame = new Int16Array(FRAME);
  agc.process(frame);
  for (let i = 0; i < FRAME; i++) {
    assert.equal(frame[i], 0, `sample ${i} of an all-zero frame must remain 0`);
  }
});

test("ImbeAgc.process: a quiet talk-spurt ramps gain up toward target peak after enough frames", () => {
  // Feed a long stream of identical quiet frames. The algorithm releases at
  // ≤5% per frame, so a single frame's output will still be quiet, but after
  // ~100 frames the output peak should be close to TARGET_PEAK.
  const agc = new ImbeAgc();
  const quietLevel = 1000; // ~3% of int16 range
  let lastPeak = 0;
  for (let i = 0; i < 200; i++) {
    const f = constantFrame(quietLevel);
    agc.process(f);
    lastPeak = peak(f);
  }
  // Within 5% of the target — confirms the ramp converges (and doesn't
  // overshoot into the clamp).
  assert.ok(
    Math.abs(lastPeak - TARGET_PEAK) <= TARGET_PEAK * 0.05,
    `quiet stream should converge near ${TARGET_PEAK}, got peak ${lastPeak}`,
  );
});

test("ImbeAgc.process: instant attack — a sudden loud peak drops gain on the same frame", () => {
  // Ramp the gain up on quiet frames, then hit one loud frame. The first
  // sample of the loud frame should already be at a low gain (instant attack);
  // we verify by checking the peak stays at or below the clamp and doesn't
  // explode out of int16 range.
  const agc = new ImbeAgc();
  for (let i = 0; i < 80; i++) {
    agc.process(constantFrame(800));
  }
  const loud = constantFrame(20000);
  agc.process(loud);
  const p = peak(loud);
  assert.ok(p <= CLAMP, `loud frame output must be clamped to <= ${CLAMP}, got ${p}`);
  // And it must not have been muted entirely — there's still audio there.
  assert.ok(p > 0, "loud frame must still produce output, not be zeroed");
});

test("ImbeAgc.process: output is clamped at ±32760 (no int16 wraparound on a hot frame)", () => {
  // Start from a fresh AGC (gain=1) and feed a single frame that's already
  // very close to the int16 limit. The algorithm should never amplify it
  // further; even a same-frame "attack" must not wrap.
  const agc = new ImbeAgc();
  const f = constantFrame(32000);
  agc.process(f);
  for (let i = 0; i < FRAME; i++) {
    const v = f[i]!;
    assert.ok(
      v <= CLAMP && v >= -CLAMP,
      `sample ${i}=${v} exceeds ±${CLAMP} clamp — risk of int16 wraparound`,
    );
  }
});

test("ImbeAgc.process: release rate per frame is bounded (slow ramp prevents pumping)", () => {
  // Starting from gain=1 (initial), one quiet frame should NOT immediately
  // jump to MAX_GAIN — the algorithm caps the ramp to 5% per frame, so a
  // single frame can only nudge the peak slightly upward.
  const agc = new ImbeAgc();
  const quiet = constantFrame(1000);
  agc.process(quiet);
  const after = peak(quiet);
  // Input peak was 1000 at gain≈1; after one frame the per-sample gain is
  // 1 + (step * n) with step capped at 5% / 160. So the very last sample's
  // effective gain is at most 1 + 0.05 ≈ 1.05.
  assert.ok(after <= 1100, `single-frame ramp should not jump from 1000 to ${after}`);
  assert.ok(after >= 1000, `single-frame ramp should not attenuate (got ${after})`);
});

test("ImbeAgc.process: gain history is per-instance (two streams don't share state)", () => {
  // The decoder pool creates one ImbeAgc per active digital talk-spurt — if
  // they ever shared state (e.g. via a static class field), interleaved
  // channels would pump each other's gain. This guards that contract.
  const a = new ImbeAgc();
  const b = new ImbeAgc();
  for (let i = 0; i < 80; i++) {
    a.process(constantFrame(800)); // a ramps up
  }
  // b is brand-new — give it one loud frame; result should be unaffected by
  // a's history, i.e. essentially gain≈1 (clamped, but not pumped down by
  // a's ramp).
  const f = constantFrame(15000);
  b.process(f);
  for (let i = 0; i < FRAME; i++) {
    assert.ok(
      Math.abs(f[i]!) >= 14000,
      `b's first frame should be near-unity gain (got |sample[${i}]|=${Math.abs(f[i]!)})`,
    );
  }
});
