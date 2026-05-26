// Read-only aggregations over the per-agency transmission / alert / AI-dispatch
// log. Used by the Analytics page (and, later, the daily summary email).
//
// Design notes:
//
// - All queries are agency-scoped (multi-tenant isolation is a hard rule).
// - Ranges are server-defined so the client can't accidentally request a year
//   of data and time out the pool.
// - generate_series is used for time-series so empty days return zero rather
//   than being missing — the front-end can plot directly without backfilling.
// - All durations are returned in milliseconds (matches the transmissions
//   schema and the rest of the API surface).

import { requirePool } from "./db.js";

export type AnalyticsRange = "24h" | "7d" | "30d";

interface RangeWindow {
  /** PostgreSQL interval clause, e.g. "24 hours". */
  interval: string;
  /** How many discrete buckets to break the range into for the time series. */
  buckets: number;
  /** Bucket granularity for date_trunc(). */
  bucketUnit: "hour" | "day";
}

const RANGE_WINDOWS: Record<AnalyticsRange, RangeWindow> = {
  "24h": { interval: "24 hours", buckets: 24, bucketUnit: "hour" },
  "7d": { interval: "7 days", buckets: 7, bucketUnit: "day" },
  "30d": { interval: "30 days", buckets: 30, bucketUnit: "day" },
};

export function isAnalyticsRange(value: string): value is AnalyticsRange {
  return value === "24h" || value === "7d" || value === "30d";
}

/**
 * Coerce a free-form query-string value (or anything else) into a valid
 * {@link AnalyticsRange}. Anything that isn't a recognised token falls back
 * to `7d`, matching the documented server default.
 *
 * Whitespace is trimmed and casing is folded so common URL variants
 * (`24H`, ` 7d `, etc.) still resolve to the canonical value rather than
 * silently degrading to the default — that masking-of-typos was the source
 * of confusing "why doesn't 30d work" support calls when the helper lived
 * inline in the route handler.
 */
export function parseAnalyticsRange(raw: unknown): AnalyticsRange {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return isAnalyticsRange(v) ? v : "7d";
}

export interface KpiResult {
  /** Total transmissions in the current window. */
  transmissions: number;
  /** Total transmissions in the same-length window immediately before. */
  transmissionsPrev: number;
  /** Unique active units (distinct unit_id with a transmission). */
  activeUnits: number;
  activeUnitsPrev: number;
  /** Sum of all transmission durations, milliseconds. */
  onAirMs: number;
  onAirMsPrev: number;
  /** Alerts (emergency / 10-33 / etc.) raised in the window. */
  alerts: number;
  alertsPrev: number;
  /** AI dispatcher calls answered. */
  aiCalls: number;
  aiCallsPrev: number;
  /** Subset of aiCalls that triggered the emergency tone (i.e. escalated). */
  aiEscalated: number;
}

/**
 * Returns a single-row KPI summary for the agency over the requested window,
 * plus the same metrics over the prior window for delta computation.
 */
export async function getKpiSummary(
  agencyId: number,
  range: AnalyticsRange,
): Promise<KpiResult> {
  const win = RANGE_WINDOWS[range];
  const sql = `
    WITH
      current_tx AS (
        SELECT COUNT(*)::int AS n,
               COUNT(DISTINCT unit_id)::int AS units,
               COALESCE(SUM(duration_ms), 0)::bigint AS air_ms
          FROM transmissions
         WHERE agency_id = $1
           AND started_at > now() - ($2::interval)
      ),
      prev_tx AS (
        SELECT COUNT(*)::int AS n,
               COUNT(DISTINCT unit_id)::int AS units,
               COALESCE(SUM(duration_ms), 0)::bigint AS air_ms
          FROM transmissions
         WHERE agency_id = $1
           AND started_at > now() - ($2::interval) * 2
           AND started_at <= now() - ($2::interval)
      ),
      current_alerts AS (
        SELECT COUNT(*)::int AS n
          FROM alerts
         WHERE agency_id = $1
           AND created_at > now() - ($2::interval)
      ),
      prev_alerts AS (
        SELECT COUNT(*)::int AS n
          FROM alerts
         WHERE agency_id = $1
           AND created_at > now() - ($2::interval) * 2
           AND created_at <= now() - ($2::interval)
      ),
      current_ai AS (
        SELECT COUNT(*)::int AS n,
               COALESCE(SUM(CASE WHEN trigger_emergency_tone THEN 1 ELSE 0 END), 0)::int AS escalated
          FROM ai_dispatch_log
         WHERE agency_id = $1
           AND created_at > now() - ($2::interval)
      ),
      prev_ai AS (
        SELECT COUNT(*)::int AS n
          FROM ai_dispatch_log
         WHERE agency_id = $1
           AND created_at > now() - ($2::interval) * 2
           AND created_at <= now() - ($2::interval)
      )
    SELECT
      (SELECT n FROM current_tx)        AS tx_now,
      (SELECT n FROM prev_tx)           AS tx_prev,
      (SELECT units FROM current_tx)    AS units_now,
      (SELECT units FROM prev_tx)       AS units_prev,
      (SELECT air_ms FROM current_tx)   AS air_now,
      (SELECT air_ms FROM prev_tx)      AS air_prev,
      (SELECT n FROM current_alerts)    AS alerts_now,
      (SELECT n FROM prev_alerts)       AS alerts_prev,
      (SELECT n FROM current_ai)        AS ai_now,
      (SELECT n FROM prev_ai)           AS ai_prev,
      (SELECT escalated FROM current_ai) AS ai_escalated;
  `;
  const res = await requirePool().query<{
    tx_now: number;
    tx_prev: number;
    units_now: number;
    units_prev: number;
    air_now: string; // bigint comes back as string
    air_prev: string;
    alerts_now: number;
    alerts_prev: number;
    ai_now: number;
    ai_prev: number;
    ai_escalated: number;
  }>(sql, [agencyId, win.interval]);
  const r = res.rows[0]!;
  return {
    transmissions: r.tx_now,
    transmissionsPrev: r.tx_prev,
    activeUnits: r.units_now,
    activeUnitsPrev: r.units_prev,
    onAirMs: Number(r.air_now),
    onAirMsPrev: Number(r.air_prev),
    alerts: r.alerts_now,
    alertsPrev: r.alerts_prev,
    aiCalls: r.ai_now,
    aiCallsPrev: r.ai_prev,
    aiEscalated: r.ai_escalated,
  };
}

export interface TimeSeriesPoint {
  /** ISO timestamp at the START of the bucket. */
  bucket: string;
  /** Number of transmissions whose `started_at` falls in this bucket. */
  transmissions: number;
  /** Sum of durations for those transmissions, in milliseconds. */
  onAirMs: number;
  /** Count of AI dispatcher invocations in this bucket. */
  aiCalls: number;
}

/**
 * Time-bucketed counts so the front-end can render a line chart directly. Empty
 * buckets are returned as zero (generate_series ensures the row exists).
 */
export async function getTimeSeries(
  agencyId: number,
  range: AnalyticsRange,
): Promise<TimeSeriesPoint[]> {
  const win = RANGE_WINDOWS[range];
  // The bucket "step" matches the unit so consecutive buckets are adjacent
  // without gaps or overlaps. PostgreSQL's date_trunc + generate_series with
  // the same step interval is the standard idiom for a zero-padded timeline.
  const stepInterval = win.bucketUnit === "hour" ? "1 hour" : "1 day";
  const sql = `
    WITH buckets AS (
      SELECT date_trunc('${win.bucketUnit}', now()) - (gs * '${stepInterval}'::interval) AS bucket
        FROM generate_series(0, ${win.buckets - 1}) AS gs
    ),
    tx AS (
      SELECT date_trunc('${win.bucketUnit}', started_at) AS bucket,
             COUNT(*)::int AS n,
             COALESCE(SUM(duration_ms), 0)::bigint AS air_ms
        FROM transmissions
       WHERE agency_id = $1
         AND started_at > now() - ($2::interval)
       GROUP BY 1
    ),
    ai AS (
      SELECT date_trunc('${win.bucketUnit}', created_at) AS bucket,
             COUNT(*)::int AS n
        FROM ai_dispatch_log
       WHERE agency_id = $1
         AND created_at > now() - ($2::interval)
       GROUP BY 1
    )
    SELECT b.bucket AS bucket,
           COALESCE(tx.n, 0)         AS tx_n,
           COALESCE(tx.air_ms, 0)    AS tx_air_ms,
           COALESCE(ai.n, 0)         AS ai_n
      FROM buckets b
      LEFT JOIN tx ON tx.bucket = b.bucket
      LEFT JOIN ai ON ai.bucket = b.bucket
     ORDER BY b.bucket ASC;
  `;
  const res = await requirePool().query<{
    bucket: Date;
    tx_n: number;
    tx_air_ms: string;
    ai_n: number;
  }>(sql, [agencyId, win.interval]);
  return res.rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    transmissions: r.tx_n,
    onAirMs: Number(r.tx_air_ms),
    aiCalls: r.ai_n,
  }));
}

export interface ChannelUtilizationRow {
  channel: string;
  transmissions: number;
  onAirMs: number;
  uniqueUnits: number;
}

/** Per-channel breakdown of transmissions / on-air time in the window. */
export async function getChannelUtilization(
  agencyId: number,
  range: AnalyticsRange,
): Promise<ChannelUtilizationRow[]> {
  const win = RANGE_WINDOWS[range];
  const res = await requirePool().query<{
    channel: string;
    transmissions: number;
    on_air_ms: string;
    unique_units: number;
  }>(
    `SELECT channel_name AS channel,
            COUNT(*)::int AS transmissions,
            COALESCE(SUM(duration_ms), 0)::bigint AS on_air_ms,
            COUNT(DISTINCT unit_id)::int AS unique_units
       FROM transmissions
      WHERE agency_id = $1
        AND started_at > now() - ($2::interval)
        AND channel_name IS NOT NULL
      GROUP BY channel_name
      ORDER BY on_air_ms DESC, transmissions DESC
      LIMIT 25;`,
    [agencyId, win.interval],
  );
  return res.rows.map((r) => ({
    channel: r.channel,
    transmissions: r.transmissions,
    onAirMs: Number(r.on_air_ms),
    uniqueUnits: r.unique_units,
  }));
}

export interface UnitOnAirRow {
  unitId: string;
  displayName: string | null;
  transmissions: number;
  onAirMs: number;
}

/** Top units by total on-air time in the window. */
export async function getTopUnits(
  agencyId: number,
  range: AnalyticsRange,
  limit = 15,
): Promise<UnitOnAirRow[]> {
  const win = RANGE_WINDOWS[range];
  const res = await requirePool().query<{
    unit_id: string;
    display_name: string | null;
    transmissions: number;
    on_air_ms: string;
  }>(
    // MAX(display_name) picks any non-null name for the unit in the window;
    // unit_aliases is admin-managed separately so this is fine as a fallback.
    `SELECT unit_id,
            MAX(display_name) AS display_name,
            COUNT(*)::int AS transmissions,
            COALESCE(SUM(duration_ms), 0)::bigint AS on_air_ms
       FROM transmissions
      WHERE agency_id = $1
        AND started_at > now() - ($2::interval)
        AND unit_id IS NOT NULL
        AND unit_id <> ''
      GROUP BY unit_id
      ORDER BY on_air_ms DESC, transmissions DESC
      LIMIT $3;`,
    [agencyId, win.interval, limit],
  );
  return res.rows.map((r) => ({
    unitId: r.unit_id,
    displayName: r.display_name,
    transmissions: r.transmissions,
    onAirMs: Number(r.on_air_ms),
  }));
}

export interface AiDispatchOutcomeRow {
  outcome: string;
  count: number;
}

/**
 * Outcome breakdown for AI dispatcher calls in the window. `outcome` is the
 * column the dispatch engine writes after each call ("answered", "escalated",
 * "no_match", "error", ...). Calls with a null outcome are bucketed as
 * "unlabelled".
 */
export async function getAiDispatchOutcomes(
  agencyId: number,
  range: AnalyticsRange,
): Promise<AiDispatchOutcomeRow[]> {
  const win = RANGE_WINDOWS[range];
  const res = await requirePool().query<{ outcome: string; n: number }>(
    `SELECT COALESCE(outcome, 'unlabelled') AS outcome,
            COUNT(*)::int AS n
       FROM ai_dispatch_log
      WHERE agency_id = $1
        AND created_at > now() - ($2::interval)
      GROUP BY outcome
      ORDER BY n DESC;`,
    [agencyId, win.interval],
  );
  return res.rows.map((r) => ({ outcome: r.outcome, count: r.n }));
}
