// Human formatting helpers shared by the bridge UI and the runner's log lines.

/** Local wall-clock time, e.g. "14:32:05". */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

/** Compact duration: "0.4s", "32s", "5m 12s", "2h 14m", "3d 4h". */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${m % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

/** Compact byte count: "812 B", "24.6 KB", "1.20 MB". */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
