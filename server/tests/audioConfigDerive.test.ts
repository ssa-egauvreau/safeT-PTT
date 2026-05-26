/**
 * Regression tests for `deriveDeviceAudioConfig` (`server/src/audioConfigDerive.ts`).
 *
 * This is the small but high-blast-radius mapping that turns the rich
 * AudioLabConfig the admin UI persists into the compact summary that every
 * Android / iOS handset polls on connect. Every handset on the agency
 * picks up these values exactly once per session, so a regression here
 * doesn't surface as a slow leak — it ships to the whole fleet on the
 * very first PTT after a deploy.
 *
 * The specific bugs these tests guard against:
 *
 *   1. `gainMultiplier` MUST be 1.0 when `bypassMicProcessing` is true,
 *      even if `agcEnabled` is also true (a stale value left over from
 *      an earlier Maximum-boost preset). Commit 8967253 fixed exactly
 *      this case after review of PR #131. Without the test, a future
 *      refactor of the mapping condition could quietly ship 3× software
 *      gain on top of the "no processing" promise.
 *
 *   2. The (gain/12)*2 + 1 formula must clamp at the LOWER bound (1.0),
 *      not collapse to 0.33 / 0.5 / etc. The original "(gain/12) * 3"
 *      formula collapsed to ≤1.0 for the entire "A little" preset range
 *      and made the lowest UI position indistinguishable from "off".
 *
 *   3. The upper clamp at 3.0 prevents an admin slider that's been
 *      pushed past the historical 1–12 range from shipping a destructive
 *      multiplier to handsets that may have weak speaker amps.
 *
 *   4. `noiseSuppression` is the OR of `windGateEnabled` and
 *      `windHpfEnabled` — both contribute upstream of IMBE on the web
 *      side but Android only exposes a single switch. Each contributor
 *      must independently be sufficient to flip the device flag on.
 *
 *   5. Missing / undefined / non-finite fields fall back to the same
 *      defaults the inline route handler used previously — silent shape
 *      changes here would mean an agency that hasn't customised
 *      anything yet starts seeing different device behaviour after a
 *      deploy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_GAIN_MULTIPLIER,
  MIN_GAIN_MULTIPLIER,
  deriveDeviceAudioConfig,
} from "../src/audioConfigDerive.js";

test("clamp constants pin the documented [1.0, 3.0] device range", () => {
  // The lower clamp is what keeps the "A little" preset audible on device.
  // The upper clamp is the safety ceiling for cheap-speaker handsets. If
  // either of these drifts the device fleet starts behaving differently
  // without any admin action; pin them.
  assert.equal(MIN_GAIN_MULTIPLIER, 1.0);
  assert.equal(MAX_GAIN_MULTIPLIER, 3.0);
});

test("bypassMicProcessing forces gainMultiplier=1.0 even when AGC is enabled", () => {
  // This is the headline bug fix from commit 8967253. Without the
  // `&& !bypassMicProcessing` guard, an admin who switched to the
  // "Bridge-style minimal" preset but left agcEnabled=true from a prior
  // Maximum-boost preset would ship a 3× gain on top of the "no
  // processing" promise.
  const out = deriveDeviceAudioConfig({
    preImbe: {
      agcEnabled: true,
      agcMaxGain: 12, // would otherwise map to 3.0×
      bypassMicProcessing: true,
    },
  });
  assert.equal(out.gainMultiplier, 1.0);
  assert.equal(out.bypassMicProcessing, true);
  // agcEnabled is reported truthfully — only the gain mapping is suppressed.
  // (Handsets use the bypass flag itself to decide what to do.)
  assert.equal(out.agcEnabled, true);
});

test("bypassMicProcessing is reported verbatim", () => {
  // Defensive: handsets branch on this flag directly. Returning a wrong
  // value would make the device-side capture path disagree with the
  // server-side gain decision above and break the "bridge-minimal"
  // contract entirely.
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { bypassMicProcessing: true } }).bypassMicProcessing,
    true,
  );
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { bypassMicProcessing: false } }).bypassMicProcessing,
    false,
  );
});

test("gainMultiplier curve hits the documented (1.0, 2.0, 3.0) anchors", () => {
  // 1.0 + (gain/12) * 2.0:
  //   gain=0  → 1.0
  //   gain=6  → 2.0
  //   gain=12 → 3.0
  // The "A little" simple-UI preset is gain=4 → 1.67, which is what makes
  // the lowest preset audibly different from "off" on device (the prior
  // (gain/12)*3 formula gave 1.0 there).
  const at = (gain: number) =>
    deriveDeviceAudioConfig({
      preImbe: { agcEnabled: true, agcMaxGain: gain },
    }).gainMultiplier;
  assert.equal(at(0), 1.0);
  assert.equal(at(6), 2.0);
  assert.equal(at(12), 3.0);
  assert.equal(at(4), 1.67); // "A little" preset — audible boost, not no-op
});

test("gainMultiplier clamps at the [1.0, 3.0] bounds", () => {
  const at = (gain: number) =>
    deriveDeviceAudioConfig({
      preImbe: { agcEnabled: true, agcMaxGain: gain },
    }).gainMultiplier;
  // Negative gain shouldn't drag the multiplier below 1.0 (silent on device).
  assert.equal(at(-50), 1.0);
  // Above-range gain shouldn't push past 3.0 (clipping on cheap speakers).
  assert.equal(at(99), 3.0);
});

test("gainMultiplier survives non-finite agcMaxGain without producing NaN", () => {
  // A future UI revision could ship a malformed config row through —
  // e.g. JSON.parse left a string in there, or a divide-by-zero crept
  // into a derived slider. The device summary must never serialise NaN
  // (some clients will treat that as "config unavailable" and refuse to
  // connect).
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: Number.NaN },
  });
  assert.ok(Number.isFinite(out.gainMultiplier));
  assert.equal(out.gainMultiplier, 1.0);

  const out2 = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: Number.POSITIVE_INFINITY },
  });
  assert.ok(Number.isFinite(out2.gainMultiplier));
  assert.equal(out2.gainMultiplier, 1.0);
});

test("gainMultiplier is 1.0 whenever AGC is disabled, regardless of slider", () => {
  // Without this, an admin who turned AGC off but left the slider at 12
  // would still ship 3× to handsets — confusing behaviour for an
  // "AGC off" preset.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: false, agcMaxGain: 12 },
  });
  assert.equal(out.gainMultiplier, 1.0);
});

test("noiseSuppression is the OR of windGateEnabled and windHpfEnabled", () => {
  // Each upstream toggle must independently flip the single Android
  // NoiseSuppressor switch on.
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { windGateEnabled: true, windHpfEnabled: false } })
      .noiseSuppression,
    true,
    "windGateEnabled alone must trigger noiseSuppression",
  );
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { windGateEnabled: false, windHpfEnabled: true } })
      .noiseSuppression,
    true,
    "windHpfEnabled alone must trigger noiseSuppression",
  );
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { windGateEnabled: true, windHpfEnabled: true } })
      .noiseSuppression,
    true,
  );
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { windGateEnabled: false, windHpfEnabled: false } })
      .noiseSuppression,
    false,
  );
});

test("missing fields fall back to documented defaults (agc off, gain 1.0, no NS, no bypass)", () => {
  // An agency that hasn't touched the audio config yet must still get a
  // well-formed summary — the route used to inline these defaults and
  // device clients depend on them.
  const out = deriveDeviceAudioConfig({});
  assert.deepEqual(out, {
    agcEnabled: false,
    noiseSuppression: false,
    gainMultiplier: 1.0,
    bypassMicProcessing: false,
  });
});

test("null / undefined raw config is handled like an empty object", () => {
  // The route only invokes this helper when `row` is non-null, but
  // defending against null at the helper itself prevents a future caller
  // from accidentally throwing a TypeError before the response is sent.
  const expected = {
    agcEnabled: false,
    noiseSuppression: false,
    gainMultiplier: 1.0,
    bypassMicProcessing: false,
  };
  assert.deepEqual(deriveDeviceAudioConfig(null), expected);
  assert.deepEqual(deriveDeviceAudioConfig(undefined), expected);
});

test("gainMultiplier is rounded to 2 decimal places (matches device-side parser)", () => {
  // 1.0 + (5/12) * 2.0 = 1.833... → 1.83 on the wire. The Android client
  // parses this as a Float and 6+ decimal places have historically tripped
  // up some locale-aware parsers; the route guaranteed 2dp before this
  // refactor and the contract still applies.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 5 },
  });
  assert.equal(out.gainMultiplier, 1.83);
});

test("agcEnabled is reported truthfully even when gainMultiplier is forced to 1.0 by bypass", () => {
  // Handsets use these two flags independently — the gain decision and the
  // "is AGC even on?" UI hint live in different code paths. If a future
  // refactor "simplifies" by zeroing agcEnabled whenever gain is forced
  // back to 1.0, the device-side AGC indicator goes dark even though the
  // admin still has AGC switched on.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 12, bypassMicProcessing: true },
  });
  assert.equal(out.agcEnabled, true);
  assert.equal(out.gainMultiplier, 1.0);
});
