import { listAllChannelAiDispatchEnabledRows } from "../store.js";
import { clampTen8Priority } from "../ten8/incidentPayload.js";
import { listTen8ActiveIncidents } from "../ten8/store.js";
import { getAiDispatchPlatformConfig } from "./platformConfig.js";
import { callCodeForRadio, incidentHasAssignedUnits } from "./infoRequest.js";
import { shortenLocationForRadio } from "../ten8/cadRadioLookup.js";
import { synthesizeElevenLabsPcm16 } from "./tts.js";
import { playPcmOnChannel } from "./playback.js";
import { getChannelAiDispatchRow } from "../store.js";
import { getAiDispatchLoopbackPort } from "./engine.js";

/** Unassigned open calls past these ages get a radio reminder (by 10-8 priority 1–4). */
const STALE_UNASSIGNED_MS: Record<number, number> = {
  1: 2 * 60 * 1000,
  2: 10 * 60 * 1000,
  3: 30 * 60 * 1000,
  4: 60 * 60 * 1000,
};

const WATCHDOG_POLL_MS = 30_000;
const lastStaleAnnouncementAt = new Map<string, number>();

function parseIncidentPriority(priority: string | null): number {
  const n = Number.parseInt(String(priority ?? "").trim(), 10);
  return clampTen8Priority(Number.isFinite(n) ? n : 4, 4);
}

function staleThresholdMs(priority: number): number {
  return STALE_UNASSIGNED_MS[priority] ?? STALE_UNASSIGNED_MS[4]!;
}

function announcementKey(agencyId: number, callId: string, priority: number): string {
  return `${agencyId}:${callId}:p${priority}`;
}

export function buildStaleUnassignedCallout(
  callId: string,
  incidentType: string | null,
  location: string | null,
  priority: number,
  pendingMinutes: number,
): string {
  const code = callCodeForRadio(incidentType);
  const loc = shortenLocationForRadio(location);
  const where = loc ? `${code} at ${loc}` : code;
  return (
    `Dispatch, unassigned priority ${priority} ${where}, call ${callId}, ` +
    `pending ${pendingMinutes} minute${pendingMinutes === 1 ? "" : "s"} with no units assigned.`
  );
}

async function speakOnChannel(
  agencyId: number,
  channelName: string,
  text: string,
): Promise<void> {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.enabled) {
    return;
  }
  const row = await getChannelAiDispatchRow(agencyId, channelName);
  if (!row?.enabled) {
    return;
  }
  // Raw PCM straight to the channel — no ffmpeg decode (avoids the EAGAIN
  // spawn failure on resource-tight boxes).
  const pcm = await synthesizeElevenLabsPcm16(agencyId, text, { speechKind: "callout" });
  if (!pcm) {
    return;
  }
  await playPcmOnChannel({
    loopbackPort: getAiDispatchLoopbackPort(),
    agencyId,
    channelName,
    unitId: platform.dispatchUnitId,
    yieldsToUnits: row.yields_to_units !== false,
    pcm,
  });
}

async function tickStaleUnassignedCalls(): Promise<void> {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.enabled) {
    return;
  }

  const channels = await listAllChannelAiDispatchEnabledRows();
  const byAgency = new Map<number, string[]>();
  for (const row of channels) {
    const list = byAgency.get(row.agency_id) ?? [];
    list.push(row.channel_name);
    byAgency.set(row.agency_id, list);
  }

  const now = Date.now();
  for (const [agencyId, channelNames] of byAgency) {
    const incidents = await listTen8ActiveIncidents(agencyId);
    for (const inc of incidents) {
      if (incidentHasAssignedUnits(inc)) {
        continue;
      }
      const priority = parseIncidentPriority(inc.priority);
      const threshold = staleThresholdMs(priority);
      const updatedMs = Date.parse(inc.updated_at);
      if (!Number.isFinite(updatedMs)) {
        continue;
      }
      const ageMs = now - updatedMs;
      if (ageMs < threshold) {
        continue;
      }

      const key = announcementKey(agencyId, inc.call_id, priority);
      const last = lastStaleAnnouncementAt.get(key) ?? 0;
      if (now - last < threshold) {
        continue;
      }

      const pendingMinutes = Math.max(1, Math.round(ageMs / 60_000));
      const callout = buildStaleUnassignedCallout(
        inc.call_id,
        inc.incident_type,
        inc.location,
        priority,
        pendingMinutes,
      );

      for (const channelName of channelNames) {
        try {
          await speakOnChannel(agencyId, channelName, callout);
        } catch (e) {
          console.warn(
            `[ai-dispatch] stale-call watchdog playback failed agency=${agencyId} channel=${channelName}`,
            e,
          );
        }
      }
      lastStaleAnnouncementAt.set(key, now);
      console.log(
        `[ai-dispatch] stale unassigned callout agency=${agencyId} call=${inc.call_id} priority=${priority}`,
      );
    }
  }
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Poll open CAD calls and announce unassigned priority calls past their threshold. */
export function startDispatchWatchdog(): void {
  if (watchdogTimer) {
    return;
  }
  watchdogTimer = setInterval(() => {
    void tickStaleUnassignedCalls().catch((e) => {
      console.warn("[ai-dispatch] stale-call watchdog tick failed", e);
    });
  }, WATCHDOG_POLL_MS);
  void tickStaleUnassignedCalls().catch(() => undefined);
}
