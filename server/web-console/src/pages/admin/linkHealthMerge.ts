import type { ChannelMember, VoiceLinkUnitSummary } from "../../api";

/** One row in the Link Health table — live voice roster plus optional telemetry. */
export interface LinkHealthRow {
  unit_id: string;
  telemetry: VoiceLinkUnitSummary | null;
  connected_now: boolean;
  connected_channels: string[];
  roster_client: string | null;
}

/**
 * Merges live channel rosters (who is on voice right now) with aggregated
 * telemetry (who posted stats in the selected time window). Without this,
 * the dashboard only listed units that had already reported — so "3 radios"
 * could show while more handsets were online on channels but silent or on an
 * older app build.
 */
export function mergeLinkHealthRows(
  telemetry: VoiceLinkUnitSummary[],
  rosters: { channel: string; members: ChannelMember[] }[],
  channelFilter: string,
): LinkHealthRow[] {
  const byUnit = new Map<string, LinkHealthRow>();
  const filter = channelFilter.trim();

  for (const group of rosters) {
    if (filter && group.channel !== filter) {
      continue;
    }
    for (const m of group.members) {
      const id = m.unit_id.trim();
      if (!id) {
        continue;
      }
      let row = byUnit.get(id);
      if (!row) {
        row = {
          unit_id: id,
          telemetry: null,
          connected_now: true,
          connected_channels: [],
          roster_client: m.client ?? null,
        };
        byUnit.set(id, row);
      }
      row.connected_now = true;
      if (!row.connected_channels.includes(group.channel)) {
        row.connected_channels.push(group.channel);
      }
      if (!row.roster_client && m.client) {
        row.roster_client = m.client;
      }
    }
  }

  for (const t of telemetry) {
    const id = t.unit_id.trim();
    if (!id) {
      continue;
    }
    const existing = byUnit.get(id);
    if (existing) {
      existing.telemetry = t;
    } else {
      byUnit.set(id, {
        unit_id: id,
        telemetry: t,
        connected_now: false,
        connected_channels: [],
        roster_client: null,
      });
    }
  }

  const out = Array.from(byUnit.values());
  out.sort((a, b) => {
    if (a.connected_now !== b.connected_now) {
      return a.connected_now ? -1 : 1;
    }
    const aTs = a.telemetry?.last_seen ?? "";
    const bTs = b.telemetry?.last_seen ?? "";
    if (aTs && bTs) {
      return aTs < bTs ? 1 : aTs > bTs ? -1 : 0;
    }
    if (aTs) {
      return -1;
    }
    if (bTs) {
      return 1;
    }
    return a.unit_id.localeCompare(b.unit_id, undefined, { sensitivity: "base" });
  });
  return out;
}
