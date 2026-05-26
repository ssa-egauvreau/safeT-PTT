// Derive the device-facing audio config summary the Android / iOS handsets
// consume from the much-richer AudioLabConfig the web admin edits.
//
// This was extracted out of the GET /v1/audio/config route handler so the
// mapping can be unit-tested directly. It's pure (no DB, no IO) and the
// shape on either side is fixed by long-lived contracts — handsets parse the
// returned summary, and the admin UI writes the lab config — so coupling
// regressions show up as both compile errors and observable behaviour
// changes on real devices.
//
// Critical regressions guarded against:
//
//   - `gainMultiplier` MUST be 1.0 when `bypassMicProcessing` is true, even
//     if a stale preset left `agcEnabled=true`. Commit 8967253 fixed the
//     case where an admin who selected "Bridge-style minimal" but still had
//     AGC enabled from a prior Maximum-boost preset shipped a 3× software
//     gain on top of the "no processing" promise.
//   - Wind reduction OR'd from the two upstream toggles (adaptive gate and
//     fixed wind HPF) into the single Android NoiseSuppressor switch.
//   - The (gain/12)*2 + 1 mapping has to clamp at [1.0, 3.0]; the lower
//     clamp is what keeps the "A little" preset (agcMaxGain=4) from
//     collapsing to indistinguishable-from-off on device.

/**
 * Raw shape of the lab config sub-tree the device summary depends on. Any
 * fields beyond preImbe.* are ignored here on purpose — handsets only learn
 * about device-controllable knobs.
 */
export interface GlobalAudioLabConfigPreImbe {
  preImbe?: {
    agcEnabled?: boolean;
    agcMaxGain?: number;
    windGateEnabled?: boolean;
    windHpfEnabled?: boolean;
    bypassMicProcessing?: boolean;
  };
}

/**
 * Device-facing summary. Field names + types match the schema the Android
 * and iOS apps parse — do not rename without bumping a versioned endpoint.
 */
export interface DeviceAudioConfigSummary {
  agcEnabled: boolean;
  noiseSuppression: boolean;
  /** 1.0–3.0, rounded to 2 decimal places. */
  gainMultiplier: number;
  bypassMicProcessing: boolean;
}

/** Lower bound. Below this the simple-UI presets become a no-op on device. */
export const MIN_GAIN_MULTIPLIER = 1.0;
/** Upper bound. Above this the speaker amp on the cheaper handsets clips. */
export const MAX_GAIN_MULTIPLIER = 3.0;

/**
 * Map an `agcMaxGain` slider value (typically 1–12 in the admin UI) into a
 * device-side gain multiplier. The expression `1.0 + (gain / 12) * 2.0`
 * means gain=0 → 1.0×, gain=6 → 2.0×, gain=12 → 3.0×, clamped at the ends
 * so out-of-range inputs from a future UI revision can't ship a destructive
 * multiplier to handsets.
 */
function gainCurve(agcMaxGain: number): number {
  // Defend against NaN / non-finite inputs: clamp first, then map.
  const safe = Number.isFinite(agcMaxGain) ? agcMaxGain : 0;
  const raw = 1.0 + (safe / 12.0) * 2.0;
  return Math.max(MIN_GAIN_MULTIPLIER, Math.min(MAX_GAIN_MULTIPLIER, raw));
}

/**
 * Pure transform from the persisted lab config to the device-facing summary.
 * Missing / undefined fields fall back to the same defaults that the route
 * handler used inline previously — keep this list in sync with
 * GET /v1/audio/config if any new fields are added.
 */
export function deriveDeviceAudioConfig(
  raw: GlobalAudioLabConfigPreImbe | null | undefined,
): DeviceAudioConfigSummary {
  const pre = raw?.preImbe ?? {};
  const agcEnabled = Boolean(pre.agcEnabled ?? false);
  const agcMaxGain = Number(pre.agcMaxGain ?? 6);
  const bypassMicProcessing = Boolean(pre.bypassMicProcessing ?? false);
  // Wind reduction is "on" on Android if EITHER the adaptive gate OR the
  // steep HPF is enabled — both contribute to noise rejection upstream of
  // IMBE, and Android only exposes a single NoiseSuppressor toggle.
  const noiseSuppression =
    Boolean(pre.windGateEnabled ?? false) || Boolean(pre.windHpfEnabled ?? false);
  // When bypass is on, force gainMultiplier=1.0. The whole point of
  // "Bridge-style minimal" is no post-capture gain — a stale agcEnabled=true
  // from an earlier preset must not sneak gain back in.
  const gain = agcEnabled && !bypassMicProcessing ? gainCurve(agcMaxGain) : 1.0;
  return {
    agcEnabled,
    noiseSuppression,
    gainMultiplier: Math.round(gain * 100) / 100,
    bypassMicProcessing,
  };
}
