/**
 * Tests for `server/src/audioConfig.ts`.
 *
 * `deriveDeviceAudioConfig` is the mapping that every handset (Android, iOS)
 * and the web voice client hit on `GET /v1/audio/config` to learn what
 * mic-processing chain the agency wants in effect. A silent regression here
 * ships a misconfigured mic chain to the whole fleet without any visible
 * server error.
 *
 * The bug we're guarding against most aggressively is the PR-131 follow-up
 * (commit 8967253): an admin who combined `bypassMicProcessing=true` with a
 * leftover `agcEnabled=true` from an earlier "Maximum boost" preset was
 * shipped a 3× software gain on top of the "no processing" claim, because
 * the gainMultiplier mapping ignored the bypass flag. The fix forces
 * `gainMultiplier=1.0` whenever `bypassMicProcessing` is on, regardless of
 * `agcEnabled` or `agcMaxGain`. That contract is what the tests below pin.
 *
 * Other regressions to watch for:
 *
 *  - `agcEnabled=false` failing to force `gainMultiplier=1.0` → handsets
 *    that disabled AGC silently still get a gain boost.
 *  - The `noiseSuppression` OR'ing only one of the two upstream flags →
 *    Android handsets engage NoiseSuppressor for the wrong subset of presets.
 *  - The clamp on `agcMaxGain` losing its floor of 1.0 → a negative or zero
 *    gain configures a negative multiplier and silently mutes the channel.
 *  - The 2-decimal rounding drifting → JSON payload churns between deploys
 *    on identical config inputs, defeating the handset's
 *    "updatedAt + config-hash" change detection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveDeviceAudioConfig } from "../src/audioConfig.js";

test("deriveDeviceAudioConfig: null input → safe all-off defaults (gain=1.0)", () => {
  // A handset connecting before an admin has ever pushed a config still
  // needs a well-formed response so its capture chain initialises in the
  // "do nothing" state rather than crashing on undefined fields.
  const out = deriveDeviceAudioConfig(null);
  assert.deepEqual(out, {
    agcEnabled: false,
    noiseSuppression: false,
    gainMultiplier: 1.0,
    bypassMicProcessing: false,
  });
});

test("deriveDeviceAudioConfig: empty object → same safe defaults", () => {
  // A bare {} (no preImbe) is what the JSON validation in the PUT route lets
  // through for a partially-populated config — must not crash, must produce
  // the same safe defaults as a null input.
  assert.deepEqual(deriveDeviceAudioConfig({}), {
    agcEnabled: false,
    noiseSuppression: false,
    gainMultiplier: 1.0,
    bypassMicProcessing: false,
  });
});

test("deriveDeviceAudioConfig: array input is rejected → defaults", () => {
  // typeof [] === "object" in JS — guard explicitly so a corrupted DB row
  // doesn't get a phantom preImbe lookup.
  assert.deepEqual(deriveDeviceAudioConfig([]), {
    agcEnabled: false,
    noiseSuppression: false,
    gainMultiplier: 1.0,
    bypassMicProcessing: false,
  });
});

test("deriveDeviceAudioConfig: agcEnabled=false forces gainMultiplier=1.0 regardless of agcMaxGain", () => {
  // Even with the slider pinned at the top, AGC-off means no make-up gain.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: false, agcMaxGain: 12 },
  });
  assert.equal(out.agcEnabled, false);
  assert.equal(out.gainMultiplier, 1.0);
});

test("deriveDeviceAudioConfig: agcEnabled=true with default agcMaxGain (6) → 2.0×", () => {
  // 1.0 + (6/12)*2 = 2.0 exactly.
  const out = deriveDeviceAudioConfig({ preImbe: { agcEnabled: true } });
  assert.equal(out.agcEnabled, true);
  assert.equal(out.gainMultiplier, 2.0);
});

test("deriveDeviceAudioConfig: agcMaxGain endpoints map to 1.0× and 3.0×", () => {
  // The published contract is "agcMaxGain 1–12 maps into [1.0, 3.0]"; clients
  // depend on the endpoints being exact, not approximate.
  const min = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 0 },
  });
  // 1 + (0/12)*2 = 1.0 (already at the clamp floor).
  assert.equal(min.gainMultiplier, 1.0);

  const max = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 12 },
  });
  assert.equal(max.gainMultiplier, 3.0);
});

test("deriveDeviceAudioConfig: agcMaxGain is clamped to [1.0, 3.0] for out-of-band slider values", () => {
  // A stale config from a different schema version (or a manual DB poke)
  // must not be able to push the device gain past 3.0× or below 1.0×.
  const huge = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 99 },
  });
  assert.equal(huge.gainMultiplier, 3.0, "agcMaxGain=99 must clamp to 3.0×");

  const negative = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: -50 },
  });
  assert.equal(
    negative.gainMultiplier,
    1.0,
    "negative agcMaxGain must clamp to 1.0× (never mute)",
  );
});

test("deriveDeviceAudioConfig: bypassMicProcessing=true forces gainMultiplier=1.0 even with agcEnabled=true at max", () => {
  // This is the PR-131 follow-up regression (commit 8967253). The whole
  // point of "Bridge-style minimal" is no post-capture gain — a leftover
  // agcEnabled=true from an earlier preset must NOT sneak a 3× gain past
  // the bypass flag.
  const out = deriveDeviceAudioConfig({
    preImbe: {
      agcEnabled: true,
      agcMaxGain: 12,
      bypassMicProcessing: true,
    },
  });
  assert.equal(out.bypassMicProcessing, true);
  assert.equal(out.agcEnabled, true, "agcEnabled passes through unchanged");
  assert.equal(
    out.gainMultiplier,
    1.0,
    "bypass must hard-floor gain to 1.0× regardless of AGC state",
  );
});

test("deriveDeviceAudioConfig: noiseSuppression is the OR of windGateEnabled and windHpfEnabled", () => {
  // Android only exposes a single NoiseSuppressor toggle, so the route OR's
  // the two upstream controls. Each branch must independently enable it.
  const neither = deriveDeviceAudioConfig({ preImbe: {} });
  assert.equal(neither.noiseSuppression, false);

  const gateOnly = deriveDeviceAudioConfig({
    preImbe: { windGateEnabled: true },
  });
  assert.equal(gateOnly.noiseSuppression, true);

  const hpfOnly = deriveDeviceAudioConfig({
    preImbe: { windHpfEnabled: true },
  });
  assert.equal(hpfOnly.noiseSuppression, true);

  const both = deriveDeviceAudioConfig({
    preImbe: { windGateEnabled: true, windHpfEnabled: true },
  });
  assert.equal(both.noiseSuppression, true);
});

test("deriveDeviceAudioConfig: gainMultiplier is rounded to 2 decimals", () => {
  // The handset's change-detection compares the JSON payload across pulls;
  // unstable trailing digits would force a needless config re-apply on every
  // poll even when nothing changed.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 1 },
  });
  // 1 + (1/12)*2 = 1.16666... → 1.17 to 2 decimals.
  assert.equal(out.gainMultiplier, 1.17);

  const out2 = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 5 },
  });
  // 1 + (5/12)*2 = 1.8333... → 1.83.
  assert.equal(out2.gainMultiplier, 1.83);
});

test("deriveDeviceAudioConfig: preserves the bypassMicProcessing flag verbatim on the way to the device", () => {
  // The handset uses this flag for more than just the gain decision — it
  // also drives whether the browser/OS EC/NS/AGC are disabled and whether
  // the TX conditioner skips its expander stage. So even when the gain
  // result happens to coincide, the flag itself must round-trip honestly.
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { bypassMicProcessing: true } })
      .bypassMicProcessing,
    true,
  );
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: { bypassMicProcessing: false } })
      .bypassMicProcessing,
    false,
  );
  // Missing flag → false (matches the pre-PR-131 default fleet behaviour).
  assert.equal(
    deriveDeviceAudioConfig({ preImbe: {} }).bypassMicProcessing,
    false,
  );
});

test("deriveDeviceAudioConfig: ignores top-level keys outside preImbe (postDecode / vocoder)", () => {
  // The full AudioLabConfig stored in the DB has `postDecode` and `vocoder`
  // siblings; this device-facing summary must not accidentally pull from
  // them or change shape if a future Audio Lab adds more top-level sections.
  const out = deriveDeviceAudioConfig({
    preImbe: { agcEnabled: true, agcMaxGain: 6 },
    postDecode: { something: true },
    vocoder: { something: true },
  });
  assert.deepEqual(out, {
    agcEnabled: true,
    noiseSuppression: false,
    gainMultiplier: 2.0,
    bypassMicProcessing: false,
  });
});

test("deriveDeviceAudioConfig: every field type matches the device-side contract", () => {
  // Android / iOS deserialise into a struct with these exact JS types. If
  // the helper ever started returning e.g. `gainMultiplier: "2.0"` (string)
  // the clients would parse it as NaN and silently fall back to 1.0.
  const out = deriveDeviceAudioConfig({
    preImbe: {
      agcEnabled: true,
      agcMaxGain: 8,
      windGateEnabled: true,
      bypassMicProcessing: false,
    },
  });
  assert.equal(typeof out.agcEnabled, "boolean");
  assert.equal(typeof out.noiseSuppression, "boolean");
  assert.equal(typeof out.gainMultiplier, "number");
  assert.equal(typeof out.bypassMicProcessing, "boolean");
  assert.equal(Number.isFinite(out.gainMultiplier), true);
});
