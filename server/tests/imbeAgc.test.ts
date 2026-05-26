/**
 * Tests for `server/src/imbeAgc.ts`.
 *
 * `ImbeAgc` normalises decoded P25 IMBE talk-spurts in place. It runs
 * server-side on every digital transmission that gets recorded (via
 * `imbeServerCodec.createImbeDecoder`) and shares the same algorithm as
 * the Android native vocoder's autoGain path (see PR #127, which
 * defaulted the C++ `m_autoGain` to false so this TS port is the only
 * AGC actually applied on web + server).
 *
 * A regression here corrupts every recording the agency archives:
 *
 *  - Wrong gain accumulation → playback that fades in/out unpredictably.
 *  - Clipping the wrong direction → harsh, distorted, "clipped" recordings.
 *  - Off-by-one in the rolling peak history → gain ramps reset on a
 *    bug-shaped cadence that no operator can diagnose.
 *
 * The class also enforces a frame-size contract (FRAME = 160 = 20 ms @
 * 8 kHz). Silently mis-sized frames must be skipped, not processed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ImbeAgc } from "../src/imbeAgc.js";

const FRAME = 160;

function frameOf(value: number): Int16Array {
  const f = new Int16Array(FRAME);
  f.fill(value);
  return f;
}

function pureTone(amplitude: number, periodSamples = 8): Int16Array {
  const f = new Int16Array(FRAME);
  for (let n = 0; n < FRAME; n++) {
    f[n] = Math.round(amplitude * Math.sin((2 * Math.PI * n) / periodSamples));
  }
  return f;
}

test("ImbeAgc.process: leaves silence at zero (no spurious gain on empty input)", () => {
  const agc = new ImbeAgc();
  const f = new Int16Array(FRAME);
  agc.process(f);
  for (let n = 0; n < FRAME; n++) {
    assert.equal(f[n], 0, `silence sample ${n} must remain 0`);
  }
});

test("ImbeAgc.process: ignores frames that aren't exactly 160 samples", () => {
  const agc = new ImbeAgc();
  // Short frame — should be a no-op so the rolling state isn't polluted by
  // a partial frame's peak.
  const short = new Int16Array(80);
  short.fill(5000);
  agc.process(short);
  for (let n = 0; n < short.length; n++) {
    assert.equal(short[n], 5000, "short frame must be left untouched");
  }
  // Oversized frame too.
  const long = new Int16Array(320);
  long.fill(5000);
  agc.process(long);
  for (let n = 0; n < long.length; n++) {
    assert.equal(long[n], 5000, "oversized frame must be left untouched");
  }
});

test("ImbeAgc.process: clamps boosted output to ±32760 (one tick below int16 max)", () => {
  // Feed a tiny signal so the AGC's gain ramps toward MAX_GAIN (50) and tries
  // to push the signal way past full-scale. The in-place clamp must keep
  // every sample inside the int16 envelope minus a 7-unit guard.
  const agc = new ImbeAgc();
  const f = pureTone(50, 4); // amplitude 50 — basically silence
  for (let iter = 0; iter < 200; iter++) {
    // Make a fresh copy each iter — the AGC is in-place.
    const next = pureTone(50, 4);
    agc.process(next);
    f.set(next);
  }
  let peak = 0;
  for (let n = 0; n < FRAME; n++) {
    const a = Math.abs(f[n]);
    if (a > peak) peak = a;
  }
  assert.ok(peak <= 32760, `clamp ceiling violated: peak=${peak}`);
});

test("ImbeAgc.process: a loud frame after a quiet ramp drops gain immediately (no overshoot)", () => {
  // Ramp the gain up on a quiet signal, then slam in a loud frame. The class
  // documents an immediate drop (step = 0, gain := target) so the loud frame
  // can't be amplified by the previously-built-up gain.
  const agc = new ImbeAgc();
  // 15 quiet frames — gives the +5 %-per-frame ramp time to climb well above 1.
  for (let i = 0; i < 15; i++) {
    agc.process(pureTone(300));
  }
  // Loud frame — peak ≈ 20000. Pre-AGC: target gain ≈ 30000/20000 = 1.5,
  // which is far below whatever the ramp climbed to.
  const loud = pureTone(20_000);
  agc.process(loud);
  let peak = 0;
  for (let n = 0; n < FRAME; n++) {
    const a = Math.abs(loud[n]);
    if (a > peak) peak = a;
  }
  // With an immediate gain drop to ~1.5 and step=0, the loud frame's peak
  // should land near 30000 (the AGC's TARGET_PEAK). It must NOT exceed the
  // clamp ceiling (which would mean overshoot survived the in-place limit).
  assert.ok(peak <= 32760, `loud frame overshot clamp: peak=${peak}`);
  // And it must NOT be amplified to the ceiling — that would mean the
  // immediate-drop branch didn't fire and the ramped-up gain leaked through.
  assert.ok(
    peak < 32700,
    `gain failed to drop on louder frame — peak ${peak} pegged at ceiling`,
  );
});

test("ImbeAgc.process: a sustained quiet input ramps gain up gradually (~5 % per frame)", () => {
  // The class caps the per-frame ramp at 5 % of the current gain. Starting
  // gain is 1; after one quiet frame the new gain is ≤ 1.05. Verify the
  // first frame's output peak landed in a range consistent with that cap —
  // NOT immediately at TARGET_PEAK.
  const agc = new ImbeAgc();
  const f = pureTone(1000); // 1000 « 30000, so target gain ≈ 30
  agc.process(f);
  let peak = 0;
  for (let n = 0; n < FRAME; n++) {
    const a = Math.abs(f[n]);
    if (a > peak) peak = a;
  }
  // Gain ramps from 1 toward 1.05 over the frame, so peak ends up around
  // 1000 × ~1.025 ≈ 1025. It must NOT have jumped straight to ~30000.
  assert.ok(
    peak < 1200,
    `gain ramp exceeded the ~5 % cap on first frame: peak=${peak}`,
  );
  assert.ok(peak >= 1000, `gain must never drop below 1.0: peak=${peak}`);
});

test("ImbeAgc.process: gain reaches a steady state where peak ≈ TARGET_PEAK", () => {
  // After many frames of a constant moderate signal, the ramp should plateau
  // somewhere that puts the per-frame peak near TARGET_PEAK (30000). This is
  // the headline behaviour — "quiet talk-spurts get normalised to a
  // consistent level."
  const agc = new ImbeAgc();
  let lastPeak = 0;
  for (let i = 0; i < 200; i++) {
    const f = pureTone(2000);
    agc.process(f);
    lastPeak = 0;
    for (let n = 0; n < FRAME; n++) {
      const a = Math.abs(f[n]);
      if (a > lastPeak) lastPeak = a;
    }
  }
  // Steady state should land in a wide band around 30000 — tolerate ±15 %
  // so a tiny scaling change in the algorithm doesn't make this test brittle,
  // but a regression that puts the gain at 1× or pegs it at the ceiling will
  // still be caught.
  assert.ok(
    lastPeak > 25_000 && lastPeak < 32_500,
    `steady-state peak out of TARGET_PEAK band: ${lastPeak}`,
  );
});

test("ImbeAgc.process: separate instances do not share AGC state", () => {
  // Each digital talk-spurt gets its own ImbeAgc (per imbeServerCodec
  // comments) so cross-talk on one channel can't move another channel's
  // gain. Two fresh instances given the same first frame must produce
  // bit-identical output.
  const a = new ImbeAgc();
  const b = new ImbeAgc();
  const fa = pureTone(800);
  const fb = pureTone(800);
  a.process(fa);
  b.process(fb);
  for (let n = 0; n < FRAME; n++) {
    assert.equal(fa[n], fb[n], `instance crosstalk at sample ${n}`);
  }

  // Now keep ramping `a` for a while and confirm a fresh `c` still behaves
  // like a brand-new AGC, not like `a`.
  for (let i = 0; i < 50; i++) {
    a.process(pureTone(800));
  }
  const c = new ImbeAgc();
  const fc = pureTone(800);
  c.process(fc);
  const fa2 = pureTone(800);
  a.process(fa2);
  // The ramped `a` should now produce a louder sample than the fresh `c`
  // for the same input — otherwise the rolling peak history isn't actually
  // instance-local.
  let peakC = 0;
  let peakA = 0;
  for (let n = 0; n < FRAME; n++) {
    const ac = Math.abs(fc[n]);
    const aa = Math.abs(fa2[n]);
    if (ac > peakC) peakC = ac;
    if (aa > peakA) peakA = aa;
  }
  assert.ok(
    peakA > peakC,
    `ramped instance should be louder than fresh: peakA=${peakA} peakC=${peakC}`,
  );
});

test("ImbeAgc.process: rolling peak history caps gain growth even after quieter recent frames", () => {
  // The AGC keeps a 25-deep history of frame peaks and uses the max of
  // {current peak, history max} when computing the target gain. So if frame
  // 1 was loud, frames 2–25 see "the loudest recent frame" and won't try
  // to amplify themselves to TARGET_PEAK based on their own quieter peak.
  const agc = new ImbeAgc();
  // Frame 1 — very loud. Establishes a big number in the history buffer.
  agc.process(pureTone(25_000));
  // Frames 2..20 — quiet. With a fresh AGC their target gain would be ~30000
  // / 2000 = 15. With history, the target is ~30000 / 25000 = 1.2 and the
  // ramp tops out way below that.
  let peak = 0;
  for (let i = 0; i < 19; i++) {
    const f = pureTone(2000);
    agc.process(f);
    peak = 0;
    for (let n = 0; n < FRAME; n++) {
      const a = Math.abs(f[n]);
      if (a > peak) peak = a;
    }
  }
  // After 19 quiet frames following a single loud frame, the peak should
  // still be modest (the history is suppressing big ramps). A regression
  // that ignored the history would have peak near 30000 by now.
  assert.ok(
    peak < 6000,
    `history-driven gain cap failed — peak=${peak} after loud-then-quiet sequence`,
  );
});

test("ImbeAgc.process: handles DC offset and asymmetric peaks via absolute value", () => {
  // The peak detector uses Math.abs — a frame whose negative excursion is
  // much larger than its positive one must still be normalised based on the
  // negative peak, not silently let it clip.
  const agc = new ImbeAgc();
  const f = frameOf(-20_000); // every sample = -20000 (pure DC)
  agc.process(f);
  for (let n = 0; n < FRAME; n++) {
    // Output should not exceed the int16 envelope, even if the gain tries
    // to amplify a -20000 DC value.
    assert.ok(
      f[n] >= -32760 && f[n] <= 32760,
      `DC frame sample ${n} out of range: ${f[n]}`,
    );
  }
});
