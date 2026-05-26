// Device-oriented projection of the agency-wide audio lab config.
//
// `GET /v1/audio/config` returns a simplified summary that Android and iOS
// handsets fetch on connect / reconnect so they can mirror the agency's
// global pre-IMBE pipeline without parsing the full `AudioLabConfig` schema.
//
// The mapping is the trust boundary between the admin-tuned Audio Lab and
// every transmit-side gain stage on every handset. A regression here:
//
//  - Wrong `gainMultiplier` ships an unexpected post-capture gain to every
//    handset on the agency, distorting talk-spurts or making them inaudible.
//  - Forgetting to clamp `gainMultiplier=1.0` when `bypassMicProcessing=true`
//    is the exact bug PR #132 fixed: combined with a stale agcEnabled=true
//    from a prior "Maximum boost" preset, the "Bridge-style minimal" toggle
//    silently stacked 3× software gain on top of the "no processing" claim.
//  - Mis-mapping `windHpfEnabled` / `windGateEnabled` → `noiseSuppression`
//    leaves Android's hardware NoiseSuppressor off when an admin expected it
//    on (or vice versa) — Android only exposes a single toggle.
//
// Kept as a standalone helper (no DB, no Express) so the mapping can be
// unit-tested without spinning up the API stack.

/**
 * Shape of the `preImbe` slice of the full AudioLabConfig that the device
 * summary derives from. Only the fields the summary reads are listed;
 * everything else on the full config is intentionally ignored.
 */
export interface PreImbeConfigInput {
  agcEnabled?: boolean;
  agcMaxGain?: number;
  windGateEnabled?: boolean;
  windHpfEnabled?: boolean;
  bypassMicProcessing?: boolean;
}

export interface DeviceAudioConfigSummary {
  /** Whether handsets should apply software AGC after capture. */
  agcEnabled: boolean;
  /** Single-knob hardware noise-suppression flag for Android-style clients. */
  noiseSuppression: boolean;
  /** Linear post-capture gain in the range [1.0, 3.0], rounded to 2dp. */
  gainMultiplier: number;
  /**
   * When true, handsets bypass the entire post-capture conditioning chain
   * (browser EC/NS/AGC, native NoiseSuppressor, TX expander, makeup AGC) and
   * mirror the radio bridge mic path. Always forces gainMultiplier=1.0 below.
   */
  bypassMicProcessing: boolean;
}

/**
 * Project the relevant `preImbe` slice of an AudioLabConfig down to the
 * device summary that handsets fetch via `GET /v1/audio/config`.
 *
 * The mapping is intentionally tolerant of partial input: any missing field
 * falls back to a defensive default so a half-migrated row in the DB can't
 * crash the endpoint and lock every handset out of refreshing config.
 */
export function deriveDeviceAudioConfig(
  preImbe: PreImbeConfigInput | undefined | null,
): DeviceAudioConfigSummary {
  const p = preImbe ?? {};
  const agcEnabled = Boolean(p.agcEnabled ?? false);
  const agcMaxGainRaw = Number(p.agcMaxGain ?? 6);
  // Treat NaN / Infinity as the documented default so a corrupted row can't
  // propagate into the gain calculation below.
  const agcMaxGain = Number.isFinite(agcMaxGainRaw) ? agcMaxGainRaw : 6;
  const bypassMicProcessing = Boolean(p.bypassMicProcessing ?? false);
  // Wind reduction is "on" on Android if EITHER the adaptive gate OR the
  // steep HPF is enabled — both contribute to noise rejection upstream of
  // IMBE, and Android only exposes a single NoiseSuppressor toggle.
  const noiseSuppression =
    Boolean(p.windGateEnabled ?? false) || Boolean(p.windHpfEnabled ?? false);
  // Map agcMaxGain (1–12) → gainMultiplier (1.0–3.0). The range starts at
  // 1.0 so the lowest simple-UI preset ("A little", agcMaxGain=4) still
  // delivers an audible boost — a linear (gain/12)*3 map collapses to 1.0×
  // at gain=4, making the preset indistinguishable from "off" on device.
  // When bypass is on, also force gainMultiplier=1.0: the whole point of
  // "Bridge-style minimal" is no post-capture gain, so even a stale
  // agcEnabled=true from a previous preset shouldn't sneak gain in.
  const gainMultiplierRaw =
    agcEnabled && !bypassMicProcessing
      ? Math.max(1.0, Math.min(3.0, 1.0 + (agcMaxGain / 12.0) * 2.0))
      : 1.0;
  return {
    agcEnabled,
    noiseSuppression,
    gainMultiplier: Math.round(gainMultiplierRaw * 100) / 100,
    bypassMicProcessing,
  };
}
