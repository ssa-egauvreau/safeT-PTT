import { getPool, requirePool } from "./db.js";
import { hashPassword, type Role } from "./auth.js";

export type Permission = "talk_priority" | "talk" | "listen_only";

export const ROLES: Role[] = ["admin", "dispatcher", "radio"];
export const PERMISSIONS: Permission[] = ["talk_priority", "talk", "listen_only"];

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  unit_id: string | null;
  disabled: boolean;
  created_at: string;
}

export interface UserWithHash extends UserRow {
  password_hash: string;
}

export interface ChannelRow {
  id: number;
  name: string;
  sort_order: number;
  color: string | null;
  zone: string | null;
}

export interface MembershipRow {
  user_id: number;
  channel_id: number;
  permission: Permission;
}

export interface UserChannelRow {
  id: number;
  name: string;
  permission: Permission;
  color: string | null;
  zone: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_user_id: number | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

const USER_COLS = "id, username, display_name, role, unit_id, disabled, created_at";

// --- users ---------------------------------------------------------------

export async function listUsers(): Promise<UserRow[]> {
  const res = await requirePool().query<UserRow>(`SELECT ${USER_COLS} FROM users ORDER BY username ASC;`);
  return res.rows;
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const res = await requirePool().query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1;`, [id]);
  return res.rows[0] ?? null;
}

export async function getUserByUsername(username: string): Promise<UserWithHash | null> {
  const res = await requirePool().query<UserWithHash>(
    `SELECT ${USER_COLS}, password_hash FROM users WHERE lower(username) = lower($1);`,
    [username],
  );
  return res.rows[0] ?? null;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
  unitId: string | null;
}): Promise<UserRow> {
  const hash = await hashPassword(input.password);
  const res = await requirePool().query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role, unit_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_COLS};`,
    [input.username.trim(), input.displayName.trim(), hash, input.role, input.unitId],
  );
  return res.rows[0]!;
}

export async function updateUser(
  id: number,
  patch: { displayName?: string; role?: Role; unitId?: string | null; disabled?: boolean; password?: string },
): Promise<UserRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(patch.displayName.trim()); }
  if (patch.role !== undefined) { sets.push(`role = $${i++}`); vals.push(patch.role); }
  if (patch.unitId !== undefined) { sets.push(`unit_id = $${i++}`); vals.push(patch.unitId); }
  if (patch.disabled !== undefined) { sets.push(`disabled = $${i++}`); vals.push(patch.disabled); }
  if (patch.password !== undefined) { sets.push(`password_hash = $${i++}`); vals.push(await hashPassword(patch.password)); }
  if (sets.length === 0) {
    return getUserById(id);
  }
  vals.push(id);
  const res = await requirePool().query<UserRow>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${USER_COLS};`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function deleteUser(id: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM users WHERE id = $1;`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Active admins — used to block deleting/demoting the final administrator. */
export async function countActiveAdmins(): Promise<number> {
  const res = await requirePool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM users WHERE role = 'admin' AND disabled = FALSE;`,
  );
  return Number(res.rows[0]?.c ?? "0");
}

// --- channels ------------------------------------------------------------

export async function listChannels(): Promise<ChannelRow[]> {
  const res = await requirePool().query<ChannelRow>(
    `SELECT id, name, sort_order, color, zone FROM radio_channels
     ORDER BY zone NULLS FIRST, sort_order ASC, id ASC;`,
  );
  return res.rows;
}

export async function createChannel(name: string): Promise<ChannelRow> {
  const res = await requirePool().query<ChannelRow>(
    `INSERT INTO radio_channels (name, sort_order)
     VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM radio_channels), 1))
     RETURNING id, name, sort_order, color, zone;`,
    [name.trim()],
  );
  return res.rows[0]!;
}

export async function updateChannel(
  id: number,
  patch: { name?: string; color?: string | null; zone?: string | null },
): Promise<ChannelRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(patch.name.trim());
  }
  if (patch.color !== undefined) {
    sets.push(`color = $${i++}`);
    vals.push(patch.color);
  }
  if (patch.zone !== undefined) {
    sets.push(`zone = $${i++}`);
    vals.push(patch.zone);
  }
  if (sets.length === 0) {
    const res = await requirePool().query<ChannelRow>(
      `SELECT id, name, sort_order, color, zone FROM radio_channels WHERE id = $1;`,
      [id],
    );
    return res.rows[0] ?? null;
  }
  vals.push(id);
  const res = await requirePool().query<ChannelRow>(
    `UPDATE radio_channels SET ${sets.join(", ")} WHERE id = $${i}
     RETURNING id, name, sort_order, color, zone;`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function deleteChannel(id: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_channels WHERE id = $1;`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Case-insensitive channel lookup by display name (used by the voice relay on join). */
export async function getChannelByName(name: string): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRow>(
    `SELECT id, name, sort_order, color, zone FROM radio_channels WHERE lower(name) = lower($1);`,
    [name.trim()],
  );
  return res.rows[0] ?? null;
}

// --- memberships ---------------------------------------------------------

export async function listMemberships(): Promise<MembershipRow[]> {
  const res = await requirePool().query<MembershipRow>(
    `SELECT user_id, channel_id, permission FROM channel_members;`,
  );
  return res.rows;
}

export async function listChannelsForUser(userId: number): Promise<UserChannelRow[]> {
  const res = await requirePool().query<UserChannelRow>(
    `SELECT c.id, c.name, c.color, c.zone, m.permission
     FROM channel_members m
     JOIN radio_channels c ON c.id = m.channel_id
     WHERE m.user_id = $1
     ORDER BY c.zone NULLS FIRST, c.sort_order ASC, c.id ASC;`,
    [userId],
  );
  return res.rows;
}

export async function setMembership(userId: number, channelId: number, permission: Permission): Promise<void> {
  await requirePool().query(
    `INSERT INTO channel_members (user_id, channel_id, permission)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = EXCLUDED.permission;`,
    [userId, channelId, permission],
  );
}

export async function removeMembership(userId: number, channelId: number): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM channel_members WHERE user_id = $1 AND channel_id = $2;`,
    [userId, channelId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** A single account's permission on one channel, or null when not assigned. */
export async function getMembership(userId: number, channelId: number): Promise<Permission | null> {
  const res = await requirePool().query<{ permission: Permission }>(
    `SELECT permission FROM channel_members WHERE user_id = $1 AND channel_id = $2;`,
    [userId, channelId],
  );
  return res.rows[0]?.permission ?? null;
}

// --- audit ---------------------------------------------------------------

export async function writeAudit(entry: {
  actorUserId: number | null;
  actorName: string | null;
  action: string;
  target?: string | null;
  detail?: unknown;
  ip?: string | null;
}): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }
  try {
    await p.query(
      `INSERT INTO audit_log (actor_user_id, actor_name, action, target, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        entry.actorUserId,
        entry.actorName,
        entry.action,
        entry.target ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        entry.ip ?? null,
      ],
    );
  } catch (error) {
    console.warn("audit write failed", error);
  }
}

export async function listAudit(limit = 200): Promise<AuditRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 200, 1), 1000);
  const res = await requirePool().query<AuditRow>(
    `SELECT id, ts, actor_user_id, actor_name, action, target, detail, ip
     FROM audit_log ORDER BY ts DESC LIMIT $1;`,
    [capped],
  );
  return res.rows;
}

// --- unit aliases --------------------------------------------------------

export interface UnitAliasRow {
  unit_id: string;
  label: string;
  updated_at: string;
}

export async function listUnitAliases(): Promise<UnitAliasRow[]> {
  const res = await requirePool().query<UnitAliasRow>(
    `SELECT unit_id, label, updated_at FROM unit_aliases ORDER BY unit_id ASC;`,
  );
  return res.rows;
}

export async function setUnitAlias(unitId: string, label: string): Promise<UnitAliasRow> {
  const res = await requirePool().query<UnitAliasRow>(
    `INSERT INTO unit_aliases (unit_id, label, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (unit_id) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
     RETURNING unit_id, label, updated_at;`,
    [unitId.trim(), label.trim()],
  );
  return res.rows[0]!;
}

export async function deleteUnitAlias(unitId: string): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM unit_aliases WHERE unit_id = $1;`, [unitId.trim()]);
  return (res.rowCount ?? 0) > 0;
}

// --- transmissions -------------------------------------------------------

export interface TransmissionRow {
  id: number;
  channel_id: number | null;
  channel_name: string;
  user_id: number | null;
  unit_id: string | null;
  display_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  sample_rate: number;
  audio_mime: string;
  transcript: string | null;
  transcript_status: string;
}

const TX_META_COLS =
  "id, channel_id, channel_name, user_id, unit_id, display_name, started_at, " +
  "ended_at, duration_ms, sample_rate, audio_mime, transcript, transcript_status";

export async function insertTransmission(input: {
  channelId: number | null;
  channelName: string;
  userId: number | null;
  unitId: string;
  displayName: string | null;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  sampleRate: number;
  audio: Buffer;
}): Promise<number> {
  const res = await requirePool().query<{ id: number }>(
    `INSERT INTO transmissions
       (channel_id, channel_name, user_id, unit_id, display_name, started_at, ended_at,
        duration_ms, sample_rate, audio, audio_mime, transcript_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'audio/wav', 'pending')
     RETURNING id;`,
    [
      input.channelId,
      input.channelName,
      input.userId,
      input.unitId,
      input.displayName,
      input.startedAt,
      input.endedAt,
      input.durationMs,
      input.sampleRate,
      input.audio,
    ],
  );
  return res.rows[0]!.id;
}

export type TransmissionSort = "newest" | "oldest" | "longest" | "shortest" | "speaker";

const TX_SORT_SQL: Record<TransmissionSort, string> = {
  newest: "started_at DESC",
  oldest: "started_at ASC",
  longest: "duration_ms DESC, started_at DESC",
  shortest: "duration_ms ASC, started_at DESC",
  speaker: "lower(COALESCE(display_name, unit_id, '')) ASC, started_at DESC",
};

/**
 * Recent transmissions (metadata only — never selects the audio bytes).
 * `channelNames` scopes the result to a role's accessible channels; the other
 * fields narrow the result and `sort` orders it.
 */
export async function listTransmissions(opts: {
  channelNames?: string[];
  channel?: string;
  search?: string;
  user?: string;
  from?: string;
  to?: string;
  sort?: TransmissionSort;
  limit?: number;
}): Promise<TransmissionRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 500);
  if (opts.channelNames && opts.channelNames.length === 0) {
    return [];
  }
  const where: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  if (opts.channelNames) {
    where.push(`lower(channel_name) = ANY($${i++})`);
    vals.push(opts.channelNames.map((n) => n.trim().toLowerCase()));
  }
  const channel = opts.channel?.trim();
  if (channel) {
    where.push(`lower(channel_name) = lower($${i++})`);
    vals.push(channel);
  }
  const search = opts.search?.trim();
  if (search) {
    where.push(`transcript ILIKE $${i++}`);
    vals.push(like(search));
  }
  const user = opts.user?.trim();
  if (user) {
    where.push(`(display_name ILIKE $${i} OR unit_id ILIKE $${i})`);
    vals.push(like(user));
    i++;
  }
  const from = opts.from?.trim();
  if (from) {
    where.push(`started_at >= $${i++}::date`);
    vals.push(from);
  }
  const to = opts.to?.trim();
  if (to) {
    where.push(`started_at < ($${i++}::date + interval '1 day')`);
    vals.push(to);
  }
  const order = TX_SORT_SQL[opts.sort ?? "newest"] ?? TX_SORT_SQL.newest;
  vals.push(limit);
  const res = await requirePool().query<TransmissionRow>(
    `SELECT ${TX_META_COLS} FROM transmissions
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${order} LIMIT $${i};`,
    vals,
  );
  return res.rows;
}

export async function getTransmissionAudio(id: number): Promise<{ audio: Buffer; mime: string } | null> {
  const res = await requirePool().query<{ audio: Buffer | null; audio_mime: string }>(
    `SELECT audio, audio_mime FROM transmissions WHERE id = $1;`,
    [id],
  );
  const row = res.rows[0];
  if (!row || !row.audio) {
    return null;
  }
  return { audio: row.audio, mime: row.audio_mime };
}

export async function getTransmissionChannel(id: number): Promise<string | null> {
  const res = await requirePool().query<{ channel_name: string }>(
    `SELECT channel_name FROM transmissions WHERE id = $1;`,
    [id],
  );
  return res.rows[0]?.channel_name ?? null;
}

export async function setTranscript(id: number, status: string, text: string | null): Promise<void> {
  await requirePool().query(
    `UPDATE transmissions SET transcript_status = $2, transcript = $3 WHERE id = $1;`,
    [id, status, text],
  );
}

export async function listPendingTranscriptionIds(): Promise<number[]> {
  const res = await requirePool().query<{ id: number }>(
    `SELECT id FROM transmissions WHERE transcript_status = 'pending' ORDER BY started_at ASC LIMIT 200;`,
  );
  return res.rows.map((r) => r.id);
}

// --- radio positions (GPS) ----------------------------------------------

export interface RadioPosition {
  unit_id: string;
  user_id: number | null;
  display_name: string | null;
  channel_name: string | null;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  updated_at: string;
}

export async function upsertPosition(input: {
  unitId: string;
  userId: number | null;
  displayName: string | null;
  channelName: string | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
  heading: number | null;
  speedMps: number | null;
}): Promise<void> {
  await requirePool().query(
    `INSERT INTO radio_positions
       (unit_id, user_id, display_name, channel_name, lat, lon, accuracy_m, heading, speed_mps, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (unit_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       display_name = COALESCE(EXCLUDED.display_name, radio_positions.display_name),
       channel_name = EXCLUDED.channel_name,
       lat = EXCLUDED.lat,
       lon = EXCLUDED.lon,
       accuracy_m = EXCLUDED.accuracy_m,
       heading = EXCLUDED.heading,
       speed_mps = EXCLUDED.speed_mps,
       updated_at = now();`,
    [
      input.unitId,
      input.userId,
      input.displayName,
      input.channelName,
      input.lat,
      input.lon,
      input.accuracyM,
      input.heading,
      input.speedMps,
    ],
  );
}

export async function listPositions(): Promise<RadioPosition[]> {
  const res = await requirePool().query<RadioPosition>(
    `SELECT unit_id, user_id, display_name, channel_name, lat, lon, accuracy_m, heading, speed_mps, updated_at
     FROM radio_positions ORDER BY updated_at DESC;`,
  );
  return res.rows;
}

// --- alerts (emergencies + pages) ---------------------------------------

export type AlertKind = "emergency" | "page";

export interface AlertRow {
  id: number;
  kind: string;
  channel_name: string | null;
  target_unit: string | null;
  from_user_id: number | null;
  from_name: string | null;
  from_unit: string | null;
  message: string | null;
  active: boolean;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

const ALERT_COLS =
  "id, kind, channel_name, target_unit, from_user_id, from_name, from_unit, message, " +
  "active, created_at, cleared_by, cleared_at";

export async function createAlert(input: {
  kind: AlertKind;
  channelName: string | null;
  targetUnit: string | null;
  fromUserId: number | null;
  fromName: string | null;
  fromUnit: string | null;
  message: string | null;
}): Promise<AlertRow> {
  const res = await requirePool().query<AlertRow>(
    `INSERT INTO alerts (kind, channel_name, target_unit, from_user_id, from_name, from_unit, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ALERT_COLS};`,
    [
      input.kind,
      input.channelName,
      input.targetUnit,
      input.fromUserId,
      input.fromName,
      input.fromUnit,
      input.message,
    ],
  );
  return res.rows[0]!;
}

/** Active alerts plus anything from the last 24h, newest first. */
export async function listAlerts(limit = 100): Promise<AlertRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
  const res = await requirePool().query<AlertRow>(
    `SELECT ${ALERT_COLS} FROM alerts
     WHERE active = TRUE OR created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT $1;`,
    [capped],
  );
  return res.rows;
}

export async function clearAlert(id: number, clearedBy: string): Promise<AlertRow | null> {
  const res = await requirePool().query<AlertRow>(
    `UPDATE alerts SET active = FALSE, cleared_by = $2, cleared_at = now()
     WHERE id = $1 RETURNING ${ALERT_COLS};`,
    [id, clearedBy],
  );
  return res.rows[0] ?? null;
}

export async function clearEmergenciesFromUnit(unit: string, clearedBy: string): Promise<number> {
  const res = await requirePool().query(
    `UPDATE alerts SET active = FALSE, cleared_by = $2, cleared_at = now()
     WHERE kind = 'emergency' AND active = TRUE AND from_unit = $1;`,
    [unit, clearedBy],
  );
  return res.rowCount ?? 0;
}

/** Alerts addressed to a radio (direct, its channel, or broadcast) newer than `sinceId`. */
export async function listInboxAlerts(unit: string, channel: string | null, sinceId: number): Promise<AlertRow[]> {
  const res = await requirePool().query<AlertRow>(
    `SELECT ${ALERT_COLS} FROM alerts
     WHERE id > $1
       AND ( target_unit = $2
             OR ( target_unit IS NULL
                  AND ( channel_name IS NULL OR lower(channel_name) = lower($3) ) ) )
     ORDER BY id ASC LIMIT 50;`,
    [sinceId, unit, channel ?? ""],
  );
  return res.rows;
}

/** Creates the first administrator on a fresh database so the admin portal is reachable. */
export async function seedInitialAdmin(): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }
  const res = await p.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users;`);
  if (Number(res.rows[0]?.c ?? "0") > 0) {
    return;
  }
  const password = process.env.ADMIN_INITIAL_PASSWORD?.trim() || "radio-admin";
  await createUser({ username: "admin", displayName: "Administrator", password, role: "admin", unitId: null });
  console.log(`Seeded initial admin — username "admin", password "${password}". Change it after first login.`);
}
