// Derive the device-oriented mic-processing config that handsets fetch on
// connect/reconnect (`GET /v1/audio/config`) from the full AudioLabConfig an
// admin pushed through the Audio Lab.
//
// This sits on the hot path for every Android and iOS handset on every
// reconnect, plus the web voice client. A silent bug here ships a misconfigured
// mic chain (wrong AGC, wrong wind-noise gate, or — worst case — a stale gain
// boost applied on top of a "no processing" claim) to the entire fleet without
// any visible server error.
//
// Kept as a standalone, dependency-free function so the mapping can be unit-
// tested without spinning up Express or Postgres, and so any future caller
// (e.g. the desktop console, the bridge worker self-config preview) shares
// exactly the same derivation as the route.

/** Shape the device clients (Android / iOS / web) understand. */
export interface DeviceAudioConfig {
  /** Apply server-driven AGC / make-up gain on the capture side. */
  agcEnabled: boolean;
  /**
   * Engage the device's noise-suppression chain. Android only exposes a
   * single NoiseSuppressor toggle, so this is OR'd from the two upstream
   * controls (adaptive wind gate + steep wind HPF).
   */
  noiseSuppression: boolean;
  /**
   * Post-capture make-up gain factor applied before IMBE.
   *
   * Forced to `1.0` when `agcEnabled` is off, OR when `bypassMicProcessing`
   * is on (bridge-style minimal path). Otherwise mapped linearly from
   * `agcMaxGain` (1–12) into the [1.0, 3.0] range and rounded to 2 decimals
   * so the JSON serialisation is stable.
   */
  gainMultiplier: number;
  /**
   * Bridge-style minimal mic processing — handset disables browser/OS
   * EC/NS/AGC and the TX conditioner runs HPF+LPF only.
   */
  bypassMicProcessing: boolean;
}

/**
 * Optional fields the function consumes from a stored AudioLabConfig. Any
 * absent field falls back to its safe "off" default so a partial config from
 * an older client version produces the same shape as the all-defaults config.
 */
interface AudioLabPreImbe {
  agcEnabled?: boolean;
  agcMaxGain?: number;
  windGateEnabled?: boolean;
  windHpfEnabled?: boolean;
  bypassMicProcessing?: boolean;
}

interface AudioLabConfigLike {
  preImbe?: AudioLabPreImbe;
}

/**
 * Map a stored full `AudioLabConfig` (the JSON blob saved by `PUT
 * /v1/admin/audio-config`) to the simplified device-oriented payload returned
 * by `GET /v1/audio/config`. Pure: no I/O, no dependence on `now()`.
 *
 * The mapping is intentionally conservative — when in doubt, return the
 * "feature off" value so a malformed config never escalates a handset's mic
 * chain unexpectedly. The one place where this matters most is the
 * `bypassMicProcessing` flag forcing `gainMultiplier` to 1.0 even when
 * `agcEnabled` is left on from a previous preset (PR-131 follow-up fix).
 */
export function deriveDeviceAudioConfig(input: unknown): DeviceAudioConfig {
  const pre =
    input && typeof input === "object" && !Array.isArray(input)
      ? ((input as AudioLabConfigLike).preImbe ?? {})
      : {};

  const agcEnabled = Boolean(pre.agcEnabled ?? false);
  const agcMaxGain = Number(pre.agcMaxGain ?? 6);
  const bypassMicProcessing = Boolean(pre.bypassMicProcessing ?? false);

  // Wind reduction is "on" on Android if EITHER the adaptive gate OR the
  // steep HPF is enabled — both contribute to noise rejection upstream of
  // IMBE, and Android only exposes a single NoiseSuppressor toggle.
  const noiseSuppression =
    Boolean(pre.windGateEnabled ?? false) || Boolean(pre.windHpfEnabled ?? false);

  // Map agcMaxGain (1–12) → gainMultiplier (1.0–3.0). The range starts at
  // 1.0 so the lowest simple-UI preset ("A little", agcMaxGain=4) still
  // delivers an audible boost — a linear (gain/12)*3 map collapses to 1.0×
  // at gain=4, making the preset indistinguishable from "off" on device.
  // When bypass is on, also force gainMultiplier=1.0: the whole point of
  // "Bridge-style minimal" is no post-capture gain, so even a stale
  // agcEnabled=true from a previous preset shouldn't sneak gain in.
  const rawMultiplier =
    agcEnabled && !bypassMicProcessing
      ? Math.max(1.0, Math.min(3.0, 1.0 + (agcMaxGain / 12.0) * 2.0))
      : 1.0;

  return {
    agcEnabled,
    noiseSuppression,
    gainMultiplier: Math.round(rawMultiplier * 100) / 100,
    bypassMicProcessing,
  };
}
