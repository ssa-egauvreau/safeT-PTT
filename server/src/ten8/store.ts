import { requirePool } from "../db.js";

// AI-created seed rows exist only to bridge the short gap until the real 10-8 webhook lands.
// If that webhook never arrives, the seed should age out so we don't keep matching/posting to
// stale calls indefinitely. The DB-side filter in [buildListTen8ActiveIncidentsQuery] enforces
// this at 15 minutes; the JS-side helper [shouldTreatTen8IncidentAsActive] provides a
// per-row override (20-minute grace) for callers that already hold a list of rows in memory.
export const AI_DISPATCH_SEED_MAX_AGE_MINUTES = 15;

// Marker the AI dispatcher writes onto its bridge rows (see engine.ts). The active-incidents
// query below filters on this exact `payload.seeded_by = 'ai_dispatch_create'` string, so a
// drift between writer and reader silently breaks expiry — every seed lingers forever, or
// real CAD-sourced rows get expired by mistake.
export const AI_DISPATCH_SEED_PAYLOAD_KEY = "seeded_by";
export const AI_DISPATCH_SEED_PAYLOAD_VALUE = "ai_dispatch_create";

// AI dispatch temporarily seeds new calls before the webhook sync arrives.
// If that webhook never lands, we must age out the synthetic row so unrelated
// transmissions cannot be attached to a stale call forever. This in-memory cap
// is intentionally slightly looser than the DB-side filter so callers reading
// a freshly-fetched row still see it during the SQL→JS hand-off.
export const AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS = 20 * 60 * 1000;

export interface Ten8ActiveIncidentRow {
  call_id: string;
  incident_type: string | null;
  priority: string | null;
  status: string | null;
  location: string | null;
  payload: unknown;
  updated_at: string;
}

function isAiDispatchSeedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const seededBy = (payload as Record<string, unknown>)[AI_DISPATCH_SEED_PAYLOAD_KEY];
  return (
    typeof seededBy === "string" &&
    seededBy.trim().toLowerCase() === AI_DISPATCH_SEED_PAYLOAD_VALUE
  );
}

export function shouldTreatTen8IncidentAsActive(
  row: Pick<Ten8ActiveIncidentRow, "payload" | "updated_at">,
  nowMs: number = Date.now(),
): boolean {
  if (!isAiDispatchSeedPayload(row.payload)) {
    return true;
  }
  const updatedAtMs = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS;
}

export async function upsertTen8Incident(row: {
  agencyId: number;
  callId: string;
  action: string;
  isClosed: boolean;
  incidentType: string | null;
  priority: string | null;
  status: string | null;
  location: string | null;
  payload: unknown;
}): Promise<void> {
  await requirePool().query(
    `INSERT INTO ten8_incidents (
       agency_id, call_id, action, is_closed, incident_type, priority, status, location, payload, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (agency_id, call_id) DO UPDATE SET
       action = EXCLUDED.action,
       is_closed = EXCLUDED.is_closed,
       incident_type = EXCLUDED.incident_type,
       priority = EXCLUDED.priority,
       status = EXCLUDED.status,
       location = EXCLUDED.location,
       payload = EXCLUDED.payload,
       updated_at = now();`,
    [
      row.agencyId,
      row.callId,
      row.action,
      row.isClosed,
      row.incidentType,
      row.priority,
      row.status,
      row.location,
      JSON.stringify(row.payload),
    ],
  );
}

export async function insertTen8WebhookLog(row: {
  agencyId: number;
  action: string;
  callId: string | null;
  payload: unknown;
}): Promise<void> {
  await requirePool().query(
    `INSERT INTO ten8_webhook_log (agency_id, action, call_id, payload) VALUES ($1,$2,$3,$4);`,
    [row.agencyId, row.action, row.callId, JSON.stringify(row.payload)],
  );
}

/**
 * Build the SQL + bind values for the active-incidents read. Exposed (rather than
 * inlining inside {@link listTen8ActiveIncidents}) so the stale-seed expiry filter
 * can be regression-tested without standing up a live Postgres — the rule that
 * AI-seed bridge rows older than {@link AI_DISPATCH_SEED_MAX_AGE_MINUTES} minutes
 * must be excluded is otherwise invisible to anything that does not actually run
 * the query.
 */
export function buildListTen8ActiveIncidentsQuery(agencyId: number): {
  text: string;
  values: [number, number];
} {
  return {
    text: `SELECT call_id, incident_type, priority, status, location, payload, updated_at
       FROM ten8_incidents
      WHERE agency_id = $1
        AND is_closed = FALSE
        AND NOT (
          COALESCE(payload->>'seeded_by', '') = 'ai_dispatch_create'
          AND updated_at < now() - ($2::int * interval '1 minute')
        )
      ORDER BY updated_at DESC
      LIMIT 100;`,
    values: [agencyId, AI_DISPATCH_SEED_MAX_AGE_MINUTES],
  };
}

export async function listTen8ActiveIncidents(
  agencyId: number,
): Promise<Ten8ActiveIncidentRow[]> {
  const q = buildListTen8ActiveIncidentsQuery(agencyId);
  const res = await requirePool().query(q.text, q.values);
  const nowMs = Date.now();
  const rows = res.rows as Ten8ActiveIncidentRow[];
  return rows.filter((row) => shouldTreatTen8IncidentAsActive(row, nowMs));
}

export async function listTen8WebhookLog(agencyId: number, limit: number): Promise<
  Array<{ id: number; action: string; call_id: string | null; received_at: string }>
> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const res = await requirePool().query(
    `SELECT id, action, call_id, received_at
       FROM ten8_webhook_log
      WHERE agency_id = $1
      ORDER BY received_at DESC
      LIMIT $2;`,
    [agencyId, cap],
  );
  return res.rows;
}
