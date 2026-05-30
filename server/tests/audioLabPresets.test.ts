/**
 * Tests for the pure validation + summary helpers powering the
 * `GET/PUT/DELETE /v1/admin/audio-lab-presets` routes.
 *
 * The routes themselves talk to Postgres (covered indirectly via
 * `apiRoutes.test.ts` route-registration assertions), but the operator-facing
 * validation contract — what names are accepted, which one is reserved, what
 * the dropdown summary shows — has to be pinned with unit tests so a future
 * tweak can't silently widen the allowed character class or let "default"
 * slip through.
 *
 * The PR-flagged regressions to guard:
 *  - Path-traversal characters ("../", "/") sneaking into a name that is
 *    later spliced into a URL path segment.
 *  - The reserved "default" name slipping past on different casings ("Default",
 *    "DEFAULT") — the reservation is case-insensitive so a future "factory
 *    reset" alias can be wired up without breaking any agency.
 *  - The summary collapsing to an empty string when nothing is enabled (the
 *    dropdown would then show a bare name with a trailing separator and
 *    look broken).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESET_NAME_MAX,
  RESERVED_PRESET_NAMES,
  isValidPresetName,
  summarizePreset,
} from "../src/audioLabPresets.js";

test("isValidPresetName: accepts a typical operator-chosen name", () => {
  assert.equal(isValidPresetName("Patrol"), true);
  assert.equal(isValidPresetName("EMS-loud"), true);
  assert.equal(isValidPresetName("Detective 2"), true);
  assert.equal(isValidPresetName("under_score"), true);
  assert.equal(isValidPresetName("a"), true); // 1-char floor
  assert.equal(isValidPresetName("A".repeat(PRESET_NAME_MAX)), true); // 64-char ceiling
});

test("isValidPresetName: rejects names outside the allowed length range", () => {
  assert.equal(isValidPresetName(""), false);
  assert.equal(isValidPresetName("   "), false, "whitespace-only trims to empty");
  assert.equal(
    isValidPresetName("A".repeat(PRESET_NAME_MAX + 1)),
    false,
    "must reject 65-char name so the DB column doesn't see a giant string",
  );
});

test("isValidPresetName: rejects characters outside [A-Za-z0-9 _-]", () => {
  // Path / URL hazards — every one of these would either break the
  // `/audio-lab-presets/:name` route segment or make the audit log target
  // ambiguous.
  assert.equal(isValidPresetName("a/b"), false);
  assert.equal(isValidPresetName("../etc/passwd"), false);
  assert.equal(isValidPresetName("a.b"), false);
  assert.equal(isValidPresetName("name?query"), false);
  assert.equal(isValidPresetName("name#hash"), false);
  // Shell / quote characters that could surprise log parsers.
  assert.equal(isValidPresetName("a'b"), false);
  assert.equal(isValidPresetName('a"b'), false);
  assert.equal(isValidPresetName("a;b"), false);
  // Unicode is rejected today (deliberate) — keep the contract pinned.
  assert.equal(isValidPresetName("Patrolé"), false);
});

test("isValidPresetName: reserves the 'default' name across all casings", () => {
  for (const reserved of RESERVED_PRESET_NAMES) {
    assert.equal(isValidPresetName(reserved), false);
    assert.equal(
      isValidPresetName(reserved.toUpperCase()),
      false,
      "reservation is case-insensitive so 'DEFAULT' is also blocked",
    );
    assert.equal(isValidPresetName(`${reserved[0]?.toUpperCase()}${reserved.slice(1)}`), false);
  }
});

test("isValidPresetName: rejects non-string input without throwing", () => {
  assert.equal(isValidPresetName(undefined), false);
  assert.equal(isValidPresetName(null), false);
  assert.equal(isValidPresetName(42), false);
  assert.equal(isValidPresetName({}), false);
  assert.equal(isValidPresetName([]), false);
});

test("summarizePreset: empty / unrecognised config collapses to a stable label", () => {
  // The dropdown joins the summary into the option label, so it must never
  // be the empty string — otherwise the option reads as "Name · " with a
  // dangling separator.
  assert.equal(summarizePreset(null), "empty config");
  assert.equal(summarizePreset(undefined), "empty config");
  assert.equal(summarizePreset([]), "empty config");
  assert.equal(summarizePreset({}), "no shaping");
  assert.equal(summarizePreset({ preImbe: {}, postDecode: {} }), "no shaping");
});

test("summarizePreset: lists enabled pre-IMBE knobs", () => {
  const cfg = {
    preImbe: { agcEnabled: true, windGateEnabled: true },
    postDecode: {},
  };
  const out = summarizePreset(cfg);
  assert.match(out, /AGC/);
  assert.match(out, /wind reduction/);
});

test("summarizePreset: 'bypass' wins over AGC tagging", () => {
  // bypassMicProcessing forces gainMultiplier=1.0 server-side (see
  // audioConfig.ts), so the summary should call out bypass instead of
  // claiming AGC — operators reading "AGC, bypass" would think both run.
  const cfg = {
    preImbe: { agcEnabled: true, bypassMicProcessing: true },
    postDecode: {},
  };
  const out = summarizePreset(cfg);
  assert.match(out, /bypass/);
  assert.doesNotMatch(out, /AGC/);
});

test("summarizePreset: lists post-decode features the operator can recognise", () => {
  const cfg = {
    preImbe: {},
    postDecode: {
      hpfEnabled: true,
      presenceEnabled: true,
      compressorEnabled: true,
      rogerBeepEnabled: true,
      squelchTailEnabled: true,
      saturationAmount: 0.4,
      dmrCharacter: 60,
    },
  };
  const out = summarizePreset(cfg);
  assert.match(out, /EQ/);
  assert.match(out, /presence bell/);
  assert.match(out, /compressor/);
  assert.match(out, /roger beep/);
  assert.match(out, /squelch tail/);
  assert.match(out, /saturation/);
  assert.match(out, /DMR 60/);
});

test("summarizePreset: zero saturation / zero dmrCharacter are not flagged", () => {
  // Two of the post-decode fields are numeric and "off" is "0". The summary
  // must treat 0 as off so a freshly-saved preset where the slider was
  // pulled back to zero doesn't read "saturation, DMR 0".
  const cfg = {
    preImbe: {},
    postDecode: { saturationAmount: 0, dmrCharacter: 0 },
  };
  const out = summarizePreset(cfg);
  assert.doesNotMatch(out, /saturation/);
  assert.doesNotMatch(out, /DMR/);
});
