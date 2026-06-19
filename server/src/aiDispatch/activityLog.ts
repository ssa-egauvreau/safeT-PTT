import { getPool, requirePool } from "../db.js";
import type { AiDispatchParseResult } from "./parse.js";
import type { PlateLookupResult } from "./plateLookup.js";

export type AiDispatchOutcome =
  | "processed"
  | "no_on_air_reply"
  | "tts_failed"
  | "skipped_channel_off"
  | "skipped_no_speech"
  | "skipped_duplicate"
  | "skipped_dispatch_unit"
  | "skipped_stale"
  | "followup_info";

export interface AiDispatchLogRow {
  id: number;
  agency_id: number;
  transmission_id: number | null;
  channel_name: string | null;
  unit_id: string | null;
  transcript: string;
  intent: string | null;
  summary: string | null;
  dispatcher_response: string | null;
  trigger_emergency_tone: boolean;
  plate_lookup: PlateLookupResult | null;
  ten8_actions: unknown;
  error: string | null;
  outcome: string | null;
  duration_ms: number | null;
  created_at: string;
}

export async function insertAiDispatchLog(entry: {
  agencyId: number;
  transmissionId: number | null;
  channelName: string | null;
  unitId: string | null;
  transcript: string;
  parsed: AiDispatchParseResult | null;
  plateLookup: PlateLookupResult | null;
  ten8Actions: unknown;
  error: string | null;
  outcome?: AiDispatchOutcome | null;
  durationMs: number | null;
}): Promise<number> {
  const res = await requirePool().query<{ id: number }>(
    `INSERT INTO ai_dispatch_log (
       agency_id, transmission_id, channel_name, unit_id, transcript,
       intent, summary, dispatcher_response, trigger_emergency_tone,
       plate_lookup, ten8_actions, error, outcome, duration_ms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id;`,
    [
      entry.agencyId,
      entry.transmissionId,
      entry.channelName,
      entry.unitId,
      entry.transcript.slice(0, 8000),
      entry.parsed?.intent ?? null,
      entry.parsed?.summary ?? null,
      entry.parsed?.dispatcher_response ?? null,
      entry.parsed?.trigger_emergency_tone === true,
      entry.plateLookup ? JSON.stringify(entry.plateLookup) : null,
      entry.ten8Actions ? JSON.stringify(entry.ten8Actions) : null,
      entry.error,
      entry.outcome ?? "processed",
      entry.durationMs,
    ],
  );
  return res.rows[0]!.id;
}

export async function listAiDispatchLog(agencyId: number, limit: number): Promise<AiDispatchLogRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  const res = await requirePool().query<AiDispatchLogRow>(
    `SELECT id, agency_id, transmission_id, channel_name, unit_id, transcript,
            intent, summary, dispatcher_response, trigger_emergency_tone,
            plate_lookup, ten8_actions, error, outcome, duration_ms, created_at
       FROM ai_dispatch_log
      WHERE agency_id = $1
      ORDER BY created_at DESC
      LIMIT $2;`,
    [agencyId, cap],
  );
  return res.rows.map((r) => ({
    ...r,
    plate_lookup:
      r.plate_lookup && typeof r.plate_lookup === "object"
        ? (r.plate_lookup as PlateLookupResult)
        : typeof r.plate_lookup === "string"
          ? (JSON.parse(r.plate_lookup) as PlateLookupResult)
          : null,
    ten8_actions:
      typeof r.ten8_actions === "string" ? JSON.parse(r.ten8_actions) : r.ten8_actions,
  }));
}

/**
 * The last few dispatch turns on one channel, oldest-to-newest, for conversational
 * context. Feeding the unit's recent transcripts AND the dispatcher's own replies
 * back into the LLM lets it resolve follow-ups ("what's on that call?", "the 415
 * you just gave me") instead of treating every transmission in isolation.
 */
export async function listRecentChannelDispatchTurns(
  agencyId: number,
  channelName: string,
  limit: number,
): Promise<Pick<AiDispatchLogRow, "unit_id" | "transcript" | "dispatcher_response" | "summary" | "created_at">[]> {
  const cap = Math.min(Math.max(limit, 1), 20);
  const res = await requirePool().query<
    Pick<AiDispatchLogRow, "unit_id" | "transcript" | "dispatcher_response" | "summary" | "created_at">
  >(
    `SELECT unit_id, transcript, dispatcher_response, summary, created_at
       FROM ai_dispatch_log
      WHERE agency_id = $1 AND channel_name = $2
        AND (transcript <> '' OR dispatcher_response IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT $3;`,
    [agencyId, channelName, cap],
  );
  // Reverse to chronological order so the LLM reads it as a conversation.
  return res.rows.reverse();
}

/** Deletes AI dispatch activity rows older than `retentionMs`. */
export async function sweepAiDispatchLog(retentionMs: number): Promise<number> {
  const p = getPool();
  if (!p) {
    return 0;
  }
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const res = await p.query(`DELETE FROM ai_dispatch_log WHERE created_at < $1;`, [cutoff]);
  return res.rowCount ?? 0;
}
