/** Perceptual 0–1 scale so quiet speech still moves the meter noticeably. */
function meterScale(value: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, value)));
}

/**
 * A horizontal input-level meter for a radio bridge. The fill shows the live
 * audio level; a marker line shows the VOX threshold — audio whose fill reaches
 * past the marker is loud enough to open the gate and key the channel.
 */
export function BridgeMeter({
  level,
  threshold,
  keyed,
  active,
}: {
  /** Normalized input level, 0–1. */
  level: number;
  /** VOX threshold, 0–1. */
  threshold: number;
  /** Whether the VOX gate is currently keying the channel. */
  keyed: boolean;
  /** Whether the bridge is running and capturing audio. */
  active: boolean;
}) {
  const fillPct = active ? meterScale(level) * 100 : 0;
  const markPct = meterScale(threshold) * 100;
  const status = !active
    ? "Not running"
    : keyed
      ? "Keying channel"
      : fillPct >= markPct && fillPct > 1
        ? "Audio above gate"
        : fillPct > 4
          ? "Audio detected"
          : "Silent";

  return (
    <div className="bridge-meter">
      <div className="bridge-meter-bar" title="Live input level from this bridge">
        <div
          className={keyed ? "bridge-meter-fill keyed" : "bridge-meter-fill"}
          style={{ width: `${fillPct}%` }}
        />
        <div
          className="bridge-meter-mark"
          style={{ left: `${markPct}%` }}
          title="VOX threshold — audio reaching past this line opens the gate"
        />
      </div>
      <span className={keyed ? "bridge-meter-status keyed" : "bridge-meter-status"}>
        {status}
      </span>
    </div>
  );
}
