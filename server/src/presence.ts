/**
 * Lightweight in-memory channel presence keyed by normalized channel labels.
 */

const TTL_MS = 45_000;
const presence = new Map<string, Map<string, number>>(); // normalized channel → unit → lastHeartbeatMs

function normalizedChannel(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function prunePresence(now: number): void {
  const cutoff = now - TTL_MS;
  const channels = [...presence.entries()];
  for (const [ch, units] of channels) {
    const entries = [...units.entries()];
    for (const [u, ts] of entries) {
      if (ts < cutoff) units.delete(u);
    }
    if (units.size === 0) presence.delete(ch);
  }
}

export function heartbeatPresence(unitIdRaw: unknown, channelRaw: unknown): { ok: boolean; error?: string } {
  const unit = String(unitIdRaw ?? "").trim().toUpperCase();
  const ch = normalizedChannel(channelRaw);
  if (!unit || !ch || ch === "----") {
    return { ok: false, error: "bad_unit_or_channel" };
  }
  const now = Date.now();
  prunePresence(now);
  if (!presence.has(ch)) presence.set(ch, new Map());
  presence.get(ch)!.set(unit, now);
  return { ok: true };
}

export function countPresence(channelRaw: unknown): number {
  const ch = normalizedChannel(channelRaw);
  const now = Date.now();
  prunePresence(now);
  return presence.get(ch)?.size ?? 0;
}
