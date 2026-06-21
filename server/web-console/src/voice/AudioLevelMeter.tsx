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

/** Throttle for the bridge status TEXT only (the bar itself runs every frame). */
const STATUS_UPDATE_MS = 150;

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
 *
 * In live mode (`getLevel`) the bar fill is animated by writing `style.width`
 * straight to the DOM inside the requestAnimationFrame loop — NOT via React
 * state. Driving a 60 fps animation through `setState` re-renders the component
 * every frame, and with many meters on one page (Mission Control's channel
 * grid) that flood of re-renders is what made the bars stutter. The ref path
 * keeps each meter free to animate smoothly regardless of how many are mounted.
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
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;
  const fillRef = useRef<HTMLDivElement>(null);
  const smoothedRef = useRef(0);
  // Only used to drive the bridge STATUS text; updated at a low rate, not per frame.
  const [statusLevel, setStatusLevel] = useState(0);

  const gain = variant === "bridge" ? 1 : TX_RX_METER_GAIN;
  const isLive = levelProp === undefined && !!getLevel;

  useEffect(() => {
    if (!isLive) return;
    if (!active) {
      smoothedRef.current = 0;
      if (fillRef.current) fillRef.current.style.width = "0%";
      if (showStatus) setStatusLevel(0);
      return;
    }
    let raf = 0;
    let lastStatusAt = 0;
    const tick = (t: number) => {
      const next = getLevelRef.current?.() ?? 0;
      const prev = smoothedRef.current;
      // Fast attack, slow release — catches transients yet reads smoothly
      // instead of flickering frame-to-frame off the raw instantaneous RMS.
      const smoothed = next > prev ? next : prev * 0.8 + next * 0.2;
      smoothedRef.current = smoothed;
      if (fillRef.current) {
        fillRef.current.style.width = `${meterScale(smoothed, gain) * 100}%`;
      }
      // The status text doesn't need 60 fps; sample it slowly so it stays a
      // cheap, occasional re-render instead of one per frame.
      if (showStatus && t - lastStatusAt >= STATUS_UPDATE_MS) {
        lastStatusAt = t;
        setStatusLevel(smoothed);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, isLive, gain, showStatus]);

  // Controlled mode renders the width from the prop; live mode starts at the last
  // known smoothed value and is then driven by the rAF loop above via the ref.
  const renderLevel = levelProp !== undefined ? levelProp : smoothedRef.current;
  const fillPct = active ? meterScale(renderLevel, gain) * 100 : 0;
  const markPct =
    threshold !== undefined && Number.isFinite(threshold) ? meterScale(threshold, gain) * 100 : null;

  const fillClass =
    variant === "bridge" && keyed
      ? "audio-level-meter-fill keyed"
      : `audio-level-meter-fill ${variant}`;

  // Status reads off the throttled level (live) or the controlled fill.
  const statusPct =
    levelProp !== undefined ? fillPct : active ? meterScale(statusLevel, gain) * 100 : 0;
  const status =
    variant === "bridge"
      ? !active
        ? "Not running"
        : keyed
          ? "Keying channel"
          : markPct !== null && statusPct >= markPct && statusPct > 1
            ? "Audio above gate"
            : statusPct > 4
              ? "Audio detected"
              : "Silent"
      : null;

  return (
    <div
      className={`audio-level-meter${className ? ` ${className}` : ""}`}
      aria-hidden={!showStatus}
    >
      <div className="audio-level-meter-bar" title="Audio level — quiet left, loud right">
        <div ref={fillRef} className={fillClass} style={{ width: `${fillPct}%` }} />
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
