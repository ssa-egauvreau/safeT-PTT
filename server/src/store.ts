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
    `SELECT id, name, sort_order FROM radio_channels ORDER BY sort_order ASC, id ASC;`,
  );
  return res.rows;
}

export async function createChannel(name: string): Promise<ChannelRow> {
  const res = await requirePool().query<ChannelRow>(
    `INSERT INTO radio_channels (name, sort_order)
     VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM radio_channels), 1))
     RETURNING id, name, sort_order;`,
    [name.trim()],
  );
  return res.rows[0]!;
}

export async function renameChannel(id: number, name: string): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRow>(
    `UPDATE radio_channels SET name = $1 WHERE id = $2 RETURNING id, name, sort_order;`,
    [name.trim(), id],
  );
  return res.rows[0] ?? null;
}

export async function deleteChannel(id: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_channels WHERE id = $1;`, [id]);
  return (res.rowCount ?? 0) > 0;
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
    `SELECT c.id, c.name, m.permission
     FROM channel_members m
     JOIN radio_channels c ON c.id = m.channel_id
     WHERE m.user_id = $1
     ORDER BY c.sort_order ASC, c.id ASC;`,
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
