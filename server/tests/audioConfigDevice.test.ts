/**
 * Tests for `server/src/audioConfigDevice.ts`.
 *
 * `deriveDeviceAudioConfig` is the trust boundary between the admin-tuned
 * Audio Lab config row and every transmit-side gain stage on every handset
 * that hits `GET /v1/audio/config` on connect / reconnect.
 *
 * A regression here is operationally invisible — handsets just sound wrong
 * for whoever happens to be on the agency at the time — so this suite pins
 * down every documented edge of the mapping:
 *
 *  - The bypass override (PR #132 critical fix #3): combining
 *    `bypassMicProcessing=true` with a stale `agcEnabled=true` must NOT
 *    leak a 2–3× gain into the "no processing" path.
 *  - The 1.0 floor on the agcMaxGain→gainMultiplier curve: the lowest
 *    simple-UI preset ("A little", agcMaxGain=4) must still deliver an
 *    audible boost, not collapse to "off".
 *  - The single-knob noiseSuppression projection for Android: EITHER
 *    windGate OR windHpf is enough; both off → off.
 *  - Defensive defaults for partial / malformed input so a half-migrated
 *    row in the DB can't crash the endpoint and lock the fleet out of
 *    refreshing config.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveDeviceAudioConfig } from "../src/audioConfigDevice.js";

test("deriveDeviceAudioConfig: empty/undefined/null input falls back to a safe default summary", () => {
  // A half-migrated row, a fresh agency that never saved an Audio Lab config,
  // or a corrupted preImbe slice — the endpoint must still return a valid
  // summary so handsets can fetch and apply it without crashing.
  for (const input of [undefined, null, {}] as const) {
    const out = deriveDeviceAudioConfig(input);
    assert.deepEqual(out, {
      agcEnabled: false,
      noiseSuppression: false,
      gainMultiplier: 1.0,
      bypassMicProcessing: false,
    });
  }
});

test("deriveDeviceAudioConfig: AGC off forces gainMultiplier=1.0 regardless of agcMaxGain", () => {
  // The mapping must only apply the (gain/12)*2 curve when AGC is on.
  // Otherwise an admin who left agcMaxGain=12 from an earlier preset but
  // disabled AGC would see a phantom 3× boost.
  const out = deriveDeviceAudioConfig({
    agcEnabled: false,
    agcMaxGain: 12,
  });
  assert.equal(out.gainMultiplier, 1.0);
  assert.equal(out.agcEnabled, false);
});

test("deriveDeviceAudioConfig: agcMaxGain→gainMultiplier curve at documented anchor points", () => {
  // 1.0 + (gain / 12) * 2.0, clamped to [1.0, 3.0], rounded to 2dp.
  // These anchors are the simple-UI presets the admin panel exposes; if
  // any of them drifts the on-air gain changes silently.
  const anchors: Array<[number, number]> = [
    [1, 1.17], // smallest documented setting
    [4, 1.67], // "A little"
    [6, 2.0], // mid
    [9, 2.5],
    [12, 3.0], // "Maximum"
  ];
  for (const [agcMaxGain, expected] of anchors) {
    const out = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain });
    assert.equal(
      out.gainMultiplier,
      expected,
      `agcMaxGain=${agcMaxGain} should map to ${expected}, got ${out.gainMultiplier}`,
    );
  }
});

test("deriveDeviceAudioConfig: gainMultiplier is clamped on both ends", () => {
  // An out-of-range value (e.g. a future preset that forgot the slider
  // bounds, or a hand-crafted row) must not ship a runaway gain.
  const low = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain: -100 });
  assert.equal(low.gainMultiplier, 1.0);
  const high = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain: 1000 });
  assert.equal(high.gainMultiplier, 3.0);
});

test("deriveDeviceAudioConfig: gainMultiplier is rounded to 2 decimal places", () => {
  // The endpoint's JSON contract is 2dp so the Android client can use
  // string equality in tests. agcMaxGain=5 → 1 + (5/12)*2 = 1.8333… → 1.83.
  const out = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain: 5 });
  assert.equal(out.gainMultiplier, 1.83);
});

test("deriveDeviceAudioConfig: bypassMicProcessing=true overrides agcEnabled and forces gain=1.0 (PR #132 regression)", () => {
  // This is the exact scenario PR #132 critical fix #3 was about:
  // a stale agcEnabled=true from a prior "Maximum boost" preset combined
  // with the new Bridge-style minimal toggle must NOT leak 3× gain into
  // the "no processing" path.
  const out = deriveDeviceAudioConfig({
    agcEnabled: true,
    agcMaxGain: 12,
    bypassMicProcessing: true,
  });
  assert.equal(out.gainMultiplier, 1.0);
  // agcEnabled is still reported truthfully — the bypass override
  // intentionally only neutralises the gain stage, not the truth bit
  // (web client / Android use both fields independently).
  assert.equal(out.agcEnabled, true);
  assert.equal(out.bypassMicProcessing, true);
});

test("deriveDeviceAudioConfig: bypassMicProcessing=true with AGC off is also gain=1.0", () => {
  const out = deriveDeviceAudioConfig({
    agcEnabled: false,
    bypassMicProcessing: true,
  });
  assert.equal(out.gainMultiplier, 1.0);
  assert.equal(out.bypassMicProcessing, true);
});

test("deriveDeviceAudioConfig: noiseSuppression is the OR of windGate and windHpf", () => {
  // Android only exposes a single hardware NoiseSuppressor toggle, so the
  // summary collapses both upstream flags into one.
  const cases: Array<[boolean, boolean, boolean]> = [
    // gate, hpf, expected
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];
  for (const [windGateEnabled, windHpfEnabled, expected] of cases) {
    const out = deriveDeviceAudioConfig({ windGateEnabled, windHpfEnabled });
    assert.equal(
      out.noiseSuppression,
      expected,
      `gate=${windGateEnabled} hpf=${windHpfEnabled} should map to ${expected}`,
    );
  }
});

test("deriveDeviceAudioConfig: defaults agcMaxGain to 6 when the field is absent", () => {
  // Documented default in the route handler — if AGC is on but no gain
  // value was stored, fall back to the mid-range "6" so we don't silently
  // ship the bottom of the curve.
  const out = deriveDeviceAudioConfig({ agcEnabled: true });
  assert.equal(out.gainMultiplier, 2.0); // 1 + (6/12)*2 = 2.0
});

test("deriveDeviceAudioConfig: defends against NaN / Infinity in agcMaxGain", () => {
  // A corrupted DB row could land NaN or Infinity in agcMaxGain (e.g. via
  // a JSON column manually edited). The mapping must not propagate NaN
  // into the JSON response — the handset would refuse to apply it and
  // every PTT would fall back to whatever's locally cached.
  const nan = deriveDeviceAudioConfig({
    agcEnabled: true,
    agcMaxGain: Number.NaN,
  });
  assert.equal(nan.gainMultiplier, 2.0);
  // ±Infinity is NOT finite — the helper substitutes the documented default
  // (6 → gainMultiplier 2.0) rather than letting the clamp interact with the
  // non-finite input in a surprising way.
  const inf = deriveDeviceAudioConfig({
    agcEnabled: true,
    agcMaxGain: Number.POSITIVE_INFINITY,
  });
  assert.equal(inf.gainMultiplier, 2.0);
  const negInf = deriveDeviceAudioConfig({
    agcEnabled: true,
    agcMaxGain: Number.NEGATIVE_INFINITY,
  });
  assert.equal(negInf.gainMultiplier, 2.0);
});

test("deriveDeviceAudioConfig: coerces truthy/falsy non-boolean inputs via Boolean()", () => {
  // The route handler reads from `row.config` which is a JSONB blob — the
  // mapping must not blow up if a field is missing or set to a JS-truthy
  // non-boolean (e.g. 1 / 0 from a legacy migration).
  const out = deriveDeviceAudioConfig({
    // @ts-expect-error — intentional bad input to exercise coercion
    agcEnabled: 1,
    agcMaxGain: 12,
    // @ts-expect-error
    windGateEnabled: 0,
    // @ts-expect-error
    windHpfEnabled: 1,
    // @ts-expect-error
    bypassMicProcessing: 0,
  });
  assert.equal(out.agcEnabled, true);
  assert.equal(out.noiseSuppression, true);
  assert.equal(out.bypassMicProcessing, false);
  assert.equal(out.gainMultiplier, 3.0);
});

test("deriveDeviceAudioConfig: the returned summary is a fresh object (no shared mutable state)", () => {
  // Defensive: two consecutive calls with identical input must not share
  // references. If the route ever mutates the response before sending it,
  // a second caller mustn't see the mutation.
  const a = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain: 6 });
  const b = deriveDeviceAudioConfig({ agcEnabled: true, agcMaxGain: 6 });
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

test("deriveDeviceAudioConfig: bypass=true returns all four documented fields with stable shape", () => {
  // The Android / iOS clients destructure the response by field name; an
  // accidental omission (e.g. dropping bypassMicProcessing because AGC is
  // off) would crash older clients that expect the field present.
  const out = deriveDeviceAudioConfig({
    agcEnabled: false,
    windGateEnabled: false,
    windHpfEnabled: false,
    bypassMicProcessing: true,
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "agcEnabled",
    "bypassMicProcessing",
    "gainMultiplier",
    "noiseSuppression",
  ]);
});
