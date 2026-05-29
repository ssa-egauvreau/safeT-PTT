/**
 * Fixed-vector lock for the feed-forward compressor in the post-decode chain.
 *
 * The compressor DSP is the load-bearing cross-platform contract: the EXACT
 * same arithmetic has to run in TypeScript (web), Kotlin (Android), and Swift
 * (iOS) so a channel sounds the same on a handset and the dispatch console.
 * This test pins the algorithm two ways:
 *
 *   1. An independent reference implementation of the documented algorithm
 *      (the pseudocode in the feature spec) is run on a known input vector and
 *      its envDb / gain are asserted at sample index 0, after the attack has
 *      engaged, and after the release has recovered — with hard-coded numeric
 *      bounds so a coefficient typo (attack/release swapped, wrong slope sign,
 *      missing 0.001 ms→s scale, etc.) fails the test.
 *
 *   2. The shipped `PostDecodeProcessor.processWideband` output is asserted to
 *      equal the reference oracle bit-for-bit on the same vector, so the class
 *      under test can't drift from the reference algorithm.
 *
 * The compressor is private, so it is exercised through the wideband entry
 * point (Opus path) with a compressor-only config: no biquads, no saturation,
 * and no upsample — the input samples pass straight through the compressor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PostDecodeProcessor,
  type PostDecodeConfig,
} from "../web-console/src/voice/postDecodeChain.ts";

const FS = 16_000;

// Pinned compressor parameters under test (the documented defaults).
const THRESHOLD_DB = -24;
const RATIO = 3.0;
const ATTACK_MS = 5;
const RELEASE_MS = 80;
const MAKEUP_DB = 0;

function clamp16(x: number): number {
  return x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x);
}

/** Independent reference implementation of the documented algorithm. Returns
 *  per-sample envDb, gain, and clamped output so the test can assert at chosen
 *  indices AND compare the full output vector against the shipped class. */
function referenceCompress(input: Int16Array): {
  out: Int16Array;
  envDb: Float64Array;
  gain: Float64Array;
} {
  const REF = 32768.0;
  const attackCoef = Math.exp(-1.0 / (ATTACK_MS * 0.001 * FS));
  const releaseCoef = Math.exp(-1.0 / (RELEASE_MS * 0.001 * FS));
  const slope = 1.0 / RATIO - 1.0;
  const makeupLin = Math.pow(10.0, MAKEUP_DB / 20.0);

  const out = new Int16Array(input.length);
  const envDbArr = new Float64Array(input.length);
  const gainArr = new Float64Array(input.length);
  let envDb = 0.0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const ax = Math.abs(x) / REF;
    const xDb = ax < 1e-9 ? -120.0 : 20.0 * Math.log10(ax);
    const overDb = xDb - THRESHOLD_DB;
    const grDb = overDb > 0.0 ? overDb * slope : 0.0;
    const coef = grDb < envDb ? attackCoef : releaseCoef;
    envDb = coef * envDb + (1.0 - coef) * grDb;
    const g = Math.pow(10.0, envDb / 20.0) * makeupLin;
    envDbArr[i] = envDb;
    gainArr[i] = g;
    out[i] = clamp16(x * g);
  }
  return { out, envDb: envDbArr, gain: gainArr };
}

/** Loud sine (above threshold) for `loudSamples`, then near-silence so the
 *  envelope releases. */
function makeVector(n: number, loudSamples: number): Int16Array {
  const pcm = new Int16Array(n);
  const loudAmp = 0.5 * 32767; // -6 dBFS peak — well above the -24 dB threshold
  const quietAmp = 0.001 * 32767; // far below threshold — drives release
  const hz = 440;
  for (let i = 0; i < n; i++) {
    const amp = i < loudSamples ? loudAmp : quietAmp;
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / FS) * amp);
  }
  return pcm;
}

const COMPRESSOR_ONLY: PostDecodeConfig = {
  upsampleMode: "duplicate",
  wideband: true,
  compressorEnabled: true,
  compressorThresholdDb: THRESHOLD_DB,
  compressorRatio: RATIO,
  compressorAttackMs: ATTACK_MS,
  compressorReleaseMs: RELEASE_MS,
  compressorMakeupDb: MAKEUP_DB,
};

test("compressor: envDb starts at 0 and gain is unity on the first sample (sin(0)=0)", () => {
  const input = makeVector(4000, 2000);
  const ref = referenceCompress(input);
  // First sample of a 440 Hz sine is 0 → no over-threshold energy → no GR yet.
  assert.equal(input[0], 0);
  assert.ok(Math.abs(ref.envDb[0]) < 1e-9, `envDb[0] should be ~0, got ${ref.envDb[0]}`);
  assert.ok(Math.abs(ref.gain[0] - 1.0) < 1e-9, `gain[0] should be ~1, got ${ref.gain[0]}`);
});

test("compressor: after the attack engages, gain is reduced into the expected band", () => {
  const input = makeVector(4000, 2000);
  const ref = referenceCompress(input);
  // By ~100 samples (6.25 ms > 5 ms attack) the envelope has clearly engaged on
  // the -6 dBFS tone. Static target gain-reduction for a -6.02 dBFS peak is
  //   over = (-6.02 - -24) = 17.98 dB; grDb = over * (1/3 - 1) = -11.99 dB
  //   gain = 10^(-11.99/20) ≈ 0.2516
  // After ~6 ms the one-pole envelope is partway there: expect a clear cut but
  // not yet fully settled.
  const g100 = ref.gain[100];
  assert.ok(g100 < 0.6, `gain after attack should be well under unity, got ${g100}`);
  assert.ok(g100 > 0.25, `gain after attack should not overshoot the static GR, got ${g100}`);
  assert.ok(ref.envDb[100] < -3, `envDb after attack should be clearly negative, got ${ref.envDb[100]}`);
});

test("compressor: steady loud tone converges toward the static gain-reduction", () => {
  // A loud tone the whole way: the peak-sensing envelope tracks the sine peak,
  // so the gain at peak samples late in the buffer settles near the static GR.
  const n = 6000;
  const input = makeVector(n, n);
  const ref = referenceCompress(input);
  // Find a near-peak sample late in the buffer.
  let bestI = 0;
  let bestAbs = 0;
  for (let i = 4000; i < n; i++) {
    if (Math.abs(input[i]) > bestAbs) {
      bestAbs = Math.abs(input[i]);
      bestI = i;
    }
  }
  const gPeak = ref.gain[bestI];
  // Static GR gain ≈ 0.2516; peak-sensing settles a touch above it.
  assert.ok(gPeak > 0.24 && gPeak < 0.32, `late peak gain should converge near static GR, got ${gPeak}`);
});

test("compressor: after release on near-silence, gain recovers toward unity", () => {
  const input = makeVector(4000, 2000);
  const ref = referenceCompress(input);
  // Just after the loud→quiet transition the envelope is still pulled down.
  const gJustAfter = ref.gain[2010];
  // Well into the quiet tail (release tau 80 ms ≈ 1280 samples) it has climbed
  // back most of the way toward unity but not fully (only ~1990 samples here).
  const gLate = ref.gain[3999];
  assert.ok(gLate > gJustAfter, `gain should be recovering (release): ${gJustAfter} -> ${gLate}`);
  assert.ok(gLate > 0.75, `gain should be most of the way back to unity, got ${gLate}`);
  assert.ok(gLate < 1.0 + 1e-9, `release must never overshoot unity, got ${gLate}`);
});

test("compressor: makeup gain is unity by default (envDb is pure gain-reduction)", () => {
  const input = makeVector(4000, 4000);
  const ref = referenceCompress(input);
  // With makeup 0 dB, the gain is exactly 10^(envDb/20) and envDb <= 0 always,
  // so the gain never exceeds unity anywhere.
  for (let i = 0; i < ref.gain.length; i++) {
    assert.ok(ref.gain[i] <= 1.0 + 1e-9, `gain[${i}] exceeded unity with 0 dB makeup: ${ref.gain[i]}`);
    assert.ok(ref.envDb[i] <= 1e-9, `envDb[${i}] should be <= 0 (gain reduction): ${ref.envDb[i]}`);
  }
});

test("compressor: shipped PostDecodeProcessor.processWideband matches the reference bit-for-bit", () => {
  const input = makeVector(4000, 2000);
  const ref = referenceCompress(input);
  // processWideband mutates in place — pass a copy so `input` stays pristine.
  const shaped = new PostDecodeProcessor(COMPRESSOR_ONLY).processWideband(input.slice());
  assert.equal(shaped.length, ref.out.length);
  for (let i = 0; i < shaped.length; i++) {
    assert.equal(shaped[i], ref.out[i], `sample ${i}: shipped=${shaped[i]} reference=${ref.out[i]}`);
  }
});

test("compressor: reset() zeroes the envelope so a new talk-spurt starts clean", () => {
  const loud = makeVector(2000, 2000);
  const proc = new PostDecodeProcessor(COMPRESSOR_ONLY);
  // Drive the envelope down with a loud spurt.
  proc.processWideband(loud.slice());
  // After reset, an identical fresh spurt must produce exactly the same output
  // as a brand-new processor (no residual gain-reduction carried over).
  proc.reset();
  const afterReset = proc.processWideband(loud.slice());
  const fresh = new PostDecodeProcessor(COMPRESSOR_ONLY).processWideband(loud.slice());
  for (let i = 0; i < fresh.length; i++) {
    assert.equal(afterReset[i], fresh[i], `sample ${i} after reset diverged from a fresh processor`);
  }
});
