import { useEffect, useRef, useState } from "react";

/**
 * Perceptual 0–1 scale so quiet speech still moves the meter noticeably.
 * `gain` pre-amplifies the raw level before the perceptual curve — the live
 * mic / RX RMS typically runs low (~0.02–0.15 for speech), so the tx/rx meters
 * apply gain to stay responsive without pinning, while bridge meters keep
 * gain = 1 so their VOX threshold marker stays calibrated to the set value.
 */
export function meterScale(value: number, gain = 1): number {
  return Math.min(1, Math.sqrt(Math.max(0, value) * gain));
}

/** Pre-amp for the console mic/RX meters (raw RMS runs low). */
const TX_RX_METER_GAIN = 3.2;

export type AudioLevelMeterVariant = "tx" | "rx" | "bridge";

interface AudioLevelMeterProps {
  /** Normalized level 0–1 (controlled mode). */
  level?: number;
  /** Poll level each frame while active (live mode). */
  getLevel?: () => number;
  active: boolean;
  variant?: AudioLevelMeterVariant;
  /** Bridge VOX: gate is open. */
  keyed?: boolean;
  /** Optional VOX threshold marker, 0–1. */
  threshold?: number;
  className?: string;
  /** Status text beside the bar (bridge runner). */
  showStatus?: boolean;
}

/**
 * Horizontal level meter: silent on the left, louder toward the right (same as Bridges tab).
 */
export function AudioLevelMeter({
  level: levelProp,
  getLevel,
  active,
  variant = "tx",
  keyed = false,
  threshold,
  className = "",
  showStatus = false,
}: AudioLevelMeterProps) {
  const [polled, setPolled] = useState(0);
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  useEffect(() => {
    if (levelProp !== undefined || !getLevelRef.current) {
      return;
    }
    if (!active) {
      setPolled(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const next = getLevelRef.current?.() ?? 0;
      // Fast attack, slow release — catches transients yet reads smoothly
      // instead of flickering frame-to-frame off the raw instantaneous RMS.
      setPolled((prev) => (next > prev ? next : prev * 0.8 + next * 0.2));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelProp]);

  const raw = levelProp !== undefined ? levelProp : polled;
  const gain = variant === "bridge" ? 1 : TX_RX_METER_GAIN;
  const fillPct = active ? meterScale(raw, gain) * 100 : 0;
  const markPct =
    threshold !== undefined && Number.isFinite(threshold) ? meterScale(threshold, gain) * 100 : null;

  const fillClass =
    variant === "bridge" && keyed
      ? "audio-level-meter-fill keyed"
      : `audio-level-meter-fill ${variant}`;

  const status =
    variant === "bridge"
      ? !active
        ? "Not running"
        : keyed
          ? "Keying channel"
          : markPct !== null && fillPct >= markPct && fillPct > 1
            ? "Audio above gate"
            : fillPct > 4
              ? "Audio detected"
              : "Silent"
      : null;

  return (
    <div
      className={`audio-level-meter${className ? ` ${className}` : ""}`}
      aria-hidden={!showStatus}
    >
      <div className="audio-level-meter-bar" title="Audio level — quiet left, loud right">
        <div className={fillClass} style={{ width: `${fillPct}%` }} />
        {markPct !== null && (
          <div
            className="audio-level-meter-mark"
            style={{ left: `${markPct}%` }}
            title="VOX threshold"
          />
        )}
      </div>
      {showStatus && status !== null && (
        <span className={keyed ? "audio-level-meter-status keyed" : "audio-level-meter-status"}>
          {status}
        </span>
      )}
    </div>
  );
}
