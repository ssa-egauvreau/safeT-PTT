import { getPool, requirePool } from "./db.js";

/**
 * Per-window inbound voice-link counters a client reports every ~30 s. Counters
 * are absolute over the observation window (not running totals), so summing
 * across rows gives a meaningful aggregate without a delta step.
 *
 * Codec breakdown maps codec wire id (e.g. `imbe`, `opus`, `codec2_3200`) to
 * `{ framesReceived, framesDecoded }` for that codec. Empty object on an idle
 * window. Stored as JSONB so a future codec doesn't require a schema change.
 */
export interface VoiceLinkTelemetryCounters {
  framesReceived: number;
  framesDecoded: number;
  decodeFailures: number;
  plcFramesSynthesized: number;
  bufferUnderruns: number;
  maxBufferDepthFrames: number;
  talkSpurtsStarted: number;
  talkSpurtsEnded: number;
  bytesReceived: number;
  /** Uplink bytes (voice frames + sideband) — 0 from clients that predate the data-usage column. */
  bytesSent: number;
  wallMsObservation: number;
}

export interface CodecBreakdownEntry {
  framesReceived: number;
  framesDecoded: number;
}

export type CodecBreakdown = Record<string, CodecBreakdownEntry>;

export interface VoiceLinkTelemetryInsert {
  agencyId: number;
  unitId: string;
  channel: string | null;
  clientType: string | null;
  /** App build the client reports (drives the fleet OTA / version view). */
  appVersionName: string | null;
  appVersionCode: number | null;
  counters: VoiceLinkTelemetryCounters;
  codecBreakdown: CodecBreakdown;
  /** True when the reporting window ran in a hidden browser tab (timer
   *  throttling inflates PLC/underruns there — see classifyHealth). */
  tabHidden: boolean;
  /** ISO-8601 from the client clock, or null. Used only as a tiebreak when
   *  clients buffer multiple windows and the relay batches them — the server's
   *  `server_ts` is the authoritative one for retention and ordering. */
  clientTs: string | null;
}

export interface VoiceLinkUnitSummaryRow {
  unit_id: string;
  last_seen: string;
  reports: number;
  frames_received: number;
  frames_decoded: number;
  decode_failures: number;
  plc_frames_synthesized: number;
  buffer_underruns: number;
  max_buffer_depth_frames: number;
  talk_spurts_started: number;
  talk_spurts_ended: number;
  bytes_received: number;
  bytes_sent: number;
  wall_ms_observation: number;
  codec_mix: CodecBreakdown;
  channels: string[];
  client_types: string[];
  /**
   * Last-hour (relative to the unit's newest report), hidden-tab windows
   * excluded — the basis for the health badge, so one bad patrol segment ten
   * hours ago doesn't paint the unit "Degraded" all day and a backgrounded
   * console tab doesn't read as an outage.
   */
  recent_reports: number;
  recent_frames_decoded: number;
  recent_plc_frames_synthesized: number;
  recent_buffer_underruns: number;
  /** Hidden-tab windows in the same last-hour span (console-tab detection). */
  recent_hidden_reports: number;
}

/** Most-recent app build reported by one unit (fleet OTA / version view). */
export interface UnitAppVersionRow {
  unit_id: string;
  app_version_name: string | null;
  app_version_code: number | null;
  reported_at: string;
}

export interface VoiceLinkTimeseriesPoint {
  server_ts: string;
  channel: string | null;
  client_type: string | null;
  frames_received: number;
  frames_decoded: number;
  decode_failures: number;
  plc_frames_synthesized: number;
  buffer_underruns: number;
  max_buffer_depth_frames: number;
  talk_spurts_started: number;
  talk_spurts_ended: number;
  bytes_received: number;
  bytes_sent: number;
  wall_ms_observation: number;
  codec_breakdown: CodecBreakdown;
}

/** Maximum window-summary rows a single dashboard query returns. The detail
 *  view pages over 24h × ~30 s windows = ~2880 rows; cap at 5000 so a buggy
 *  client flooding short windows can't blow up the admin payload. */
const TIMESERIES_ROW_CAP = 5000;

/**
 * Persists one window summary. Caller has already validated and clamped the
 * counters to the allowed range; this function is a thin SQL insert.
 */
export async function insertVoiceLinkTelemetry(
  input: VoiceLinkTelemetryInsert,
): Promise<void> {
  await requirePool().query(
    `INSERT INTO voice_link_telemetry (
       agency_id, unit_id, channel, client_type,
       frames_received, frames_decoded, decode_failures, plc_frames_synthesized,
       buffer_underruns, max_buffer_depth_frames,
       talk_spurts_started, talk_spurts_ended,
       bytes_received, bytes_sent, wall_ms_observation,
       codec_breakdown, tab_hidden, client_ts,
       app_version_name, app_version_code
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10,
       $11, $12,
       $13, $14, $15,
       $16::jsonb, $17, $18,
       $19, $20
     );`,
    [
      input.agencyId,
      input.unitId,
      input.channel,
      input.clientType,
      input.counters.framesReceived,
      input.counters.framesDecoded,
      input.counters.decodeFailures,
      input.counters.plcFramesSynthesized,
      input.counters.bufferUnderruns,
      input.counters.maxBufferDepthFrames,
      input.counters.talkSpurtsStarted,
      input.counters.talkSpurtsEnded,
      input.counters.bytesReceived,
      input.counters.bytesSent,
      input.counters.wallMsObservation,
      JSON.stringify(input.codecBreakdown ?? {}),
      input.tabHidden,
      input.clientTs,
      input.appVersionName,
      input.appVersionCode,
    ],
  );
}

/**
 * One aggregated summary row per unit, over the window
 * `[now - sinceMs, now]`, optionally filtered to one channel. Counters sum
 * across the window; `codec_mix` merges every per-window codec breakdown so
 * the dashboard sees the per-codec health for that unit over the range.
 *
 * Implementation note: row-level counters (frames_received, etc.) and the
 * codec-level breakdown are aggregated as two SEPARATE queries on the same
 * filter, then joined per unit in JS. A single query that LATERAL-joins
 * `jsonb_each` produces one row per (telemetry_row × codec) and would
 * double-count the row-level counters whenever a window has more than one
 * codec key in its breakdown. Splitting keeps the row-level counters honest
 * without giving up the per-codec breakdown.
 */
export async function listVoiceLinkUnitSummaries(
  agencyId: number,
  sinceMs: number,
  channel?: string,
): Promise<VoiceLinkUnitSummaryRow[]> {
  const params: unknown[] = [agencyId, new Date(Date.now() - sinceMs).toISOString()];
  let channelClause = "";
  if (channel && channel.trim()) {
    params.push(channel.trim());
    channelClause = ` AND channel = $${params.length}`;
  }
  const pool = requirePool();
  const rowsRes = await pool.query<{
    unit_id: string;
    last_seen: Date | string;
    reports: string;
    frames_received: string;
    frames_decoded: string;
    decode_failures: string;
    plc_frames_synthesized: string;
    buffer_underruns: string;
    max_buffer_depth_frames: string;
    talk_spurts_started: string;
    talk_spurts_ended: string;
    bytes_received: string;
    bytes_sent: string;
    wall_ms_observation: string;
    channels: string[];
    client_types: string[];
  }>(
    `SELECT unit_id,
            MAX(server_ts) AS last_seen,
            COUNT(*)::text AS reports,
            COALESCE(SUM(frames_received),0)::text AS frames_received,
            COALESCE(SUM(frames_decoded),0)::text AS frames_decoded,
            COALESCE(SUM(decode_failures),0)::text AS decode_failures,
            COALESCE(SUM(plc_frames_synthesized),0)::text AS plc_frames_synthesized,
            COALESCE(SUM(buffer_underruns),0)::text AS buffer_underruns,
            COALESCE(MAX(max_buffer_depth_frames),0)::text AS max_buffer_depth_frames,
            COALESCE(SUM(talk_spurts_started),0)::text AS talk_spurts_started,
            COALESCE(SUM(talk_spurts_ended),0)::text AS talk_spurts_ended,
            COALESCE(SUM(bytes_received),0)::text AS bytes_received,
            COALESCE(SUM(bytes_sent),0)::text AS bytes_sent,
            COALESCE(SUM(wall_ms_observation),0)::text AS wall_ms_observation,
            COALESCE(ARRAY_AGG(DISTINCT channel) FILTER (WHERE channel IS NOT NULL), ARRAY[]::text[]) AS channels,
            COALESCE(ARRAY_AGG(DISTINCT client_type) FILTER (WHERE client_type IS NOT NULL), ARRAY[]::text[]) AS client_types
       FROM voice_link_telemetry
      WHERE agency_id = $1 AND server_ts >= $2${channelClause}
      GROUP BY unit_id
      ORDER BY MAX(server_ts) DESC NULLS LAST;`,
    params,
  );

  // Second pass: per-codec breakdown. One row per (unit, codec) which we
  // index into the units below. Same WHERE filter as the row aggregate so
  // the two stay in lockstep.
  const codecRes = await pool.query<{
    unit_id: string;
    codec_key: string;
    codec_rx: string;
    codec_dec: string;
  }>(
    `SELECT t.unit_id,
            kv.key AS codec_key,
            COALESCE(SUM((kv.value ->> 'framesReceived')::int), 0)::text AS codec_rx,
            COALESCE(SUM((kv.value ->> 'framesDecoded')::int), 0)::text AS codec_dec
       FROM voice_link_telemetry t,
            LATERAL jsonb_each(COALESCE(t.codec_breakdown,'{}'::jsonb)) kv
      WHERE t.agency_id = $1 AND t.server_ts >= $2${channelClause}
        AND jsonb_typeof(t.codec_breakdown) = 'object'
      GROUP BY t.unit_id, kv.key;`,
    params,
  );
  const codecByUnit = new Map<string, CodecBreakdown>();
  for (const c of codecRes.rows) {
    const map = codecByUnit.get(c.unit_id) ?? {};
    map[c.codec_key] = {
      framesReceived: Number(c.codec_rx),
      framesDecoded: Number(c.codec_dec),
    };
    codecByUnit.set(c.unit_id, map);
  }

  // Third pass: the unit's most recent hour (anchored at its own newest report,
  // so a radio that went quiet 9 h ago is judged on its final hour of activity,
  // not an empty window). Hidden-tab console windows are excluded from the
  // quality counters and surfaced separately for the "background tab" badge.
  const recentRes = await pool.query<{
    unit_id: string;
    recent_reports: string;
    recent_frames_decoded: string;
    recent_plc: string;
    recent_underruns: string;
    recent_hidden_reports: string;
  }>(
    `SELECT t.unit_id,
            COUNT(*) FILTER (WHERE NOT t.tab_hidden)::text AS recent_reports,
            COALESCE(SUM(t.frames_decoded) FILTER (WHERE NOT t.tab_hidden),0)::text AS recent_frames_decoded,
            COALESCE(SUM(t.plc_frames_synthesized) FILTER (WHERE NOT t.tab_hidden),0)::text AS recent_plc,
            COALESCE(SUM(t.buffer_underruns) FILTER (WHERE NOT t.tab_hidden),0)::text AS recent_underruns,
            COUNT(*) FILTER (WHERE t.tab_hidden)::text AS recent_hidden_reports
       FROM voice_link_telemetry t
       JOIN (SELECT unit_id, MAX(server_ts) AS last_seen
               FROM voice_link_telemetry
              WHERE agency_id = $1 AND server_ts >= $2${channelClause}
              GROUP BY unit_id) m ON m.unit_id = t.unit_id
      WHERE t.agency_id = $1 AND t.server_ts >= $2${channelClause}
        AND t.server_ts >= m.last_seen - interval '60 minutes'
      GROUP BY t.unit_id;`,
    params,
  );
  const recentByUnit = new Map(recentRes.rows.map((r) => [r.unit_id, r]));
  const rows = rowsRes;

  return rows.rows.map((r) => ({
    unit_id: r.unit_id,
    last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : String(r.last_seen),
    reports: Number(r.reports),
    frames_received: Number(r.frames_received),
    frames_decoded: Number(r.frames_decoded),
    decode_failures: Number(r.decode_failures),
    plc_frames_synthesized: Number(r.plc_frames_synthesized),
    buffer_underruns: Number(r.buffer_underruns),
    max_buffer_depth_frames: Number(r.max_buffer_depth_frames),
    talk_spurts_started: Number(r.talk_spurts_started),
    talk_spurts_ended: Number(r.talk_spurts_ended),
    bytes_received: Number(r.bytes_received),
    bytes_sent: Number(r.bytes_sent),
    wall_ms_observation: Number(r.wall_ms_observation),
    codec_mix: codecByUnit.get(r.unit_id) ?? {},
    channels: Array.isArray(r.channels) ? r.channels : [],
    client_types: Array.isArray(r.client_types) ? r.client_types : [],
    recent_reports: Number(recentByUnit.get(r.unit_id)?.recent_reports ?? 0),
    recent_frames_decoded: Number(recentByUnit.get(r.unit_id)?.recent_frames_decoded ?? 0),
    recent_plc_frames_synthesized: Number(recentByUnit.get(r.unit_id)?.recent_plc ?? 0),
    recent_buffer_underruns: Number(recentByUnit.get(r.unit_id)?.recent_underruns ?? 0),
    recent_hidden_reports: Number(recentByUnit.get(r.unit_id)?.recent_hidden_reports ?? 0),
  }));
}

/**
 * Window-by-window time series for one unit, newest first then reversed by the
 * caller for left-to-right time charts. Caps at {@link TIMESERIES_ROW_CAP}
 * rows; a buggy client posting a flood of short windows can't OOM the admin.
 */
export async function listVoiceLinkUnitTimeseries(
  agencyId: number,
  unitId: string,
  sinceMs: number,
  channel?: string,
): Promise<VoiceLinkTimeseriesPoint[]> {
  const params: unknown[] = [agencyId, unitId, new Date(Date.now() - sinceMs).toISOString()];
  let channelClause = "";
  if (channel && channel.trim()) {
    params.push(channel.trim());
    channelClause = ` AND channel = $${params.length}`;
  }
  params.push(TIMESERIES_ROW_CAP);
  const limitParam = `$${params.length}`;
  const res = await requirePool().query<{
    server_ts: Date | string;
    channel: string | null;
    client_type: string | null;
    frames_received: number;
    frames_decoded: number;
    decode_failures: number;
    plc_frames_synthesized: number;
    buffer_underruns: number;
    max_buffer_depth_frames: number;
    talk_spurts_started: number;
    talk_spurts_ended: number;
    bytes_received: number;
    bytes_sent: number;
    wall_ms_observation: number;
    codec_breakdown: unknown;
  }>(
    `SELECT server_ts, channel, client_type,
            frames_received, frames_decoded, decode_failures,
            plc_frames_synthesized, buffer_underruns, max_buffer_depth_frames,
            talk_spurts_started, talk_spurts_ended,
            bytes_received, bytes_sent, wall_ms_observation, codec_breakdown
       FROM voice_link_telemetry
      WHERE agency_id = $1 AND unit_id = $2 AND server_ts >= $3${channelClause}
      ORDER BY server_ts DESC
      LIMIT ${limitParam};`,
    params,
  );
  return res.rows.map((r) => ({
    server_ts: r.server_ts instanceof Date ? r.server_ts.toISOString() : String(r.server_ts),
    channel: r.channel,
    client_type: r.client_type,
    frames_received: Number(r.frames_received),
    frames_decoded: Number(r.frames_decoded),
    decode_failures: Number(r.decode_failures),
    plc_frames_synthesized: Number(r.plc_frames_synthesized),
    buffer_underruns: Number(r.buffer_underruns),
    max_buffer_depth_frames: Number(r.max_buffer_depth_frames),
    talk_spurts_started: Number(r.talk_spurts_started),
    talk_spurts_ended: Number(r.talk_spurts_ended),
    bytes_received: Number(r.bytes_received),
    bytes_sent: Number(r.bytes_sent),
    wall_ms_observation: Number(r.wall_ms_observation),
    codec_breakdown: coerceCodecMix(r.codec_breakdown),
  }));
}

/**
 * Deletes telemetry rows older than `retentionMs`. Idempotent — safe to run
 * from multiple instances; rows already deleted just match zero. Returns the
 * count for logging.
 */
/**
 * Most recent app build each unit reported within the window — one row per unit.
 * Kept separate from the heavy counter aggregation so the version/OTA view is a
 * cheap `DISTINCT ON` and doesn't touch the summary query.
 */
export async function listLatestAppVersionsByUnit(
  agencyId: number,
  sinceMs: number,
): Promise<UnitAppVersionRow[]> {
  const res = await requirePool().query<{
    unit_id: string;
    app_version_name: string | null;
    app_version_code: number | null;
    reported_at: Date | string;
  }>(
    `SELECT DISTINCT ON (unit_id)
            unit_id, app_version_name, app_version_code, server_ts AS reported_at
       FROM voice_link_telemetry
      WHERE agency_id = $1
        AND server_ts >= $2
        AND app_version_code IS NOT NULL
      ORDER BY unit_id, server_ts DESC;`,
    [agencyId, new Date(Date.now() - sinceMs).toISOString()],
  );
  return res.rows.map((r) => ({
    unit_id: r.unit_id,
    app_version_name: r.app_version_name,
    app_version_code: r.app_version_code,
    reported_at: typeof r.reported_at === "string" ? r.reported_at : r.reported_at.toISOString(),
  }));
}

export async function sweepVoiceLinkTelemetry(retentionMs: number): Promise<number> {
  const p = getPool();
  if (!p) {
    return 0;
  }
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const res = await p.query(
    `DELETE FROM voice_link_telemetry WHERE server_ts < $1;`,
    [cutoff],
  );
  return res.rowCount ?? 0;
}

// --- pure helpers (exported for tests) ----------------------------------

/**
 * Per-unit roll-up derived purely from a list of window rows in memory. Useful
 * to keep the in-process aggregator covered by a unit test that doesn't need a
 * live Postgres — the SQL version above mirrors this shape.
 */
export interface AggregatedUnitSummary {
  unitId: string;
  reports: number;
  framesReceived: number;
  framesDecoded: number;
  decodeFailures: number;
  plcFramesSynthesized: number;
  bufferUnderruns: number;
  maxBufferDepthFrames: number;
  talkSpurtsStarted: number;
  talkSpurtsEnded: number;
  bytesReceived: number;
  bytesSent: number;
  wallMsObservation: number;
  codecMix: CodecBreakdown;
  channels: string[];
  clientTypes: string[];
  /** Last (newest) server timestamp seen for this unit. */
  lastSeen: string;
  /** Per-window PLC ratio (plc / framesDecoded) capped at 1.0; 0 when no frames. */
  plcRatio: number;
  /** Health classification used by the admin dashboard badge — computed from
   *  the unit's most recent hour of windows (hidden-tab windows excluded),
   *  mirroring the SQL summary's `recent_*` basis. */
  health: "green" | "yellow" | "orange" | "red" | "unknown";
}

export interface AggregatableWindow {
  unit_id: string;
  server_ts: string;
  channel: string | null;
  client_type: string | null;
  frames_received: number;
  frames_decoded: number;
  decode_failures: number;
  plc_frames_synthesized: number;
  buffer_underruns: number;
  max_buffer_depth_frames: number;
  talk_spurts_started: number;
  talk_spurts_ended: number;
  bytes_received: number;
  bytes_sent: number;
  wall_ms_observation: number;
  codec_breakdown: CodecBreakdown;
  /** True for a web-console window recorded in a hidden (timer-throttled) tab. */
  tab_hidden?: boolean;
}

/** Span the health badge is judged over, anchored at the unit's newest report. */
export const HEALTH_RECENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Aggregates a flat list of window rows into one summary per unit. Used as the
 * pure core of the SQL aggregation so the rules (sum vs. max, codec merge,
 * health badge) have a unit test that doesn't need a live Postgres. Caller
 * orders the rows however they like; this function is order-independent for
 * sums and tracks `lastSeen` as the max server_ts.
 */
export function aggregateWindowsByUnit(
  rows: readonly AggregatableWindow[],
): AggregatedUnitSummary[] {
  const map = new Map<string, AggregatedUnitSummary>();
  for (const row of rows) {
    const existing = map.get(row.unit_id);
    if (!existing) {
      map.set(row.unit_id, {
        unitId: row.unit_id,
        reports: 1,
        framesReceived: row.frames_received,
        framesDecoded: row.frames_decoded,
        decodeFailures: row.decode_failures,
        plcFramesSynthesized: row.plc_frames_synthesized,
        bufferUnderruns: row.buffer_underruns,
        maxBufferDepthFrames: row.max_buffer_depth_frames,
        talkSpurtsStarted: row.talk_spurts_started,
        talkSpurtsEnded: row.talk_spurts_ended,
        bytesReceived: row.bytes_received,
        bytesSent: row.bytes_sent,
        wallMsObservation: row.wall_ms_observation,
        codecMix: cloneCodecMix(row.codec_breakdown),
        channels: row.channel ? [row.channel] : [],
        clientTypes: row.client_type ? [row.client_type] : [],
        lastSeen: row.server_ts,
        plcRatio: 0,
        health: "unknown",
      });
    } else {
      existing.reports += 1;
      existing.framesReceived += row.frames_received;
      existing.framesDecoded += row.frames_decoded;
      existing.decodeFailures += row.decode_failures;
      existing.plcFramesSynthesized += row.plc_frames_synthesized;
      existing.bufferUnderruns += row.buffer_underruns;
      existing.maxBufferDepthFrames = Math.max(existing.maxBufferDepthFrames, row.max_buffer_depth_frames);
      existing.talkSpurtsStarted += row.talk_spurts_started;
      existing.talkSpurtsEnded += row.talk_spurts_ended;
      existing.bytesReceived += row.bytes_received;
      existing.bytesSent += row.bytes_sent;
      existing.wallMsObservation += row.wall_ms_observation;
      mergeCodecMixInto(existing.codecMix, row.codec_breakdown);
      if (row.channel && !existing.channels.includes(row.channel)) {
        existing.channels.push(row.channel);
      }
      if (row.client_type && !existing.clientTypes.includes(row.client_type)) {
        existing.clientTypes.push(row.client_type);
      }
      if (row.server_ts > existing.lastSeen) {
        existing.lastSeen = row.server_ts;
      }
    }
  }
  const out = Array.from(map.values());
  for (const s of out) {
    s.plcRatio = computePlcRatio(s.plcFramesSynthesized, s.framesDecoded);
    // Badge from the unit's last hour of NON-hidden windows: a bad patch this
    // morning shouldn't paint the unit red all day, and a backgrounded console
    // tab (timer-throttled, phantom PLC) shouldn't read as an outage.
    const cutoff = new Date(Date.parse(s.lastSeen) - HEALTH_RECENT_WINDOW_MS).toISOString();
    const recent = rows.filter(
      (r) => r.unit_id === s.unitId && r.server_ts >= cutoff && !r.tab_hidden,
    );
    const recentSums = {
      framesDecoded: recent.reduce((a, r) => a + r.frames_decoded, 0),
      plcFramesSynthesized: recent.reduce((a, r) => a + r.plc_frames_synthesized, 0),
      bufferUnderruns: recent.reduce((a, r) => a + r.buffer_underruns, 0),
      reports: recent.length,
    };
    s.health = classifyHealth({
      ...recentSums,
      plcRatio: computePlcRatio(recentSums.plcFramesSynthesized, recentSums.framesDecoded),
    });
  }
  out.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  return out;
}

/**
 * PLC ratio: PLC frames vs. real decoded frames over the window. Caps at 1.0
 * so a degenerate window (all PLC, no decoded) doesn't blow up the badge
 * scaling. Returns 0 when no decoded frames yet — keeps a fresh idle unit
 * out of the red category before it has reported any audio.
 */
export function computePlcRatio(plc: number, decoded: number): number {
  if (!Number.isFinite(plc) || !Number.isFinite(decoded) || plc <= 0) return 0;
  if (decoded <= 0) return 1;
  const ratio = plc / (plc + decoded);
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Maps a summary to a health badge. Callers should feed it the unit's
 * RECENT counters (last hour, hidden-tab windows excluded) so the badge says
 * "how is this link right now", not "did anything bad happen all day".
 *
 *  - green ("Good"): PLC ratio < 1 % AND zero buffer underruns.
 *  - yellow ("Fair"): PLC ratio < 5 % AND fewer than 3 underruns/window.
 *  - orange ("Marginal"): PLC ratio < 15 % AND fewer than 15 underruns/window.
 *    Audible smoothing, but usable — a cellular unit on a patrol route lives
 *    here; lumping it in with 25 %+ links made the dashboard cry wolf.
 *  - red ("Degraded"): anything worse — operator-noticeable cutout.
 *  - unknown: no decoded frames AND no PLC (a truly silent unit — could be
 *    off-air, but is not "having voice quality problems").
 */
export function classifyHealth(s: {
  framesDecoded: number;
  plcFramesSynthesized: number;
  bufferUnderruns: number;
  plcRatio: number;
  reports: number;
}): "green" | "yellow" | "orange" | "red" | "unknown" {
  if (s.framesDecoded === 0 && s.plcFramesSynthesized === 0) {
    return "unknown";
  }
  const underrunsPerWindow = s.reports > 0 ? s.bufferUnderruns / s.reports : s.bufferUnderruns;
  if (s.plcRatio < 0.01 && s.bufferUnderruns === 0) {
    return "green";
  }
  if (s.plcRatio < 0.05 && underrunsPerWindow < 3) {
    return "yellow";
  }
  if (s.plcRatio < 0.15 && underrunsPerWindow < 15) {
    return "orange";
  }
  return "red";
}

function cloneCodecMix(mix: CodecBreakdown | null | undefined): CodecBreakdown {
  if (!mix || typeof mix !== "object") return {};
  const out: CodecBreakdown = {};
  for (const [k, v] of Object.entries(mix)) {
    if (!v || typeof v !== "object") continue;
    out[k] = {
      framesReceived: Number((v as CodecBreakdownEntry).framesReceived ?? 0),
      framesDecoded: Number((v as CodecBreakdownEntry).framesDecoded ?? 0),
    };
  }
  return out;
}

function mergeCodecMixInto(target: CodecBreakdown, addition: CodecBreakdown | null | undefined): void {
  if (!addition || typeof addition !== "object") return;
  for (const [k, v] of Object.entries(addition)) {
    if (!v || typeof v !== "object") continue;
    const addRx = Number((v as CodecBreakdownEntry).framesReceived ?? 0);
    const addDec = Number((v as CodecBreakdownEntry).framesDecoded ?? 0);
    if (!target[k]) {
      target[k] = { framesReceived: addRx, framesDecoded: addDec };
    } else {
      target[k].framesReceived += addRx;
      target[k].framesDecoded += addDec;
    }
  }
}

function coerceCodecMix(raw: unknown): CodecBreakdown {
  if (!raw || typeof raw !== "object") return {};
  const out: CodecBreakdown = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const entry = v as { framesReceived?: unknown; framesDecoded?: unknown };
    out[k] = {
      framesReceived: Number(entry.framesReceived ?? 0),
      framesDecoded: Number(entry.framesDecoded ?? 0),
    };
  }
  return out;
}
