import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, requirePool, DEFAULT_AGENCY_SLUG } from "./db.js";
import { hashPassword, type Role } from "./auth.js";

export type Permission = "talk_priority" | "talk" | "listen_only";

/** Every role the platform recognizes. `owner` is platform-level (no agency). */
export const ROLES: Role[] = ["owner", "admin", "dispatcher", "radio"];
/** Roles an agency administrator (or the owner) may assign within an agency. */
export const AGENCY_ROLES: Role[] = ["admin", "dispatcher", "radio"];
export const PERMISSIONS: Permission[] = ["talk_priority", "talk", "listen_only"];

/** Radio tones an agency may replace with its own uploaded audio. */
export const SOUND_KINDS = [
  "permit",
  "channel_switch",
  "emergency",
  "busy",
  "volume_check",
  "marker_1033",
] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export function isSoundKind(value: unknown): value is SoundKind {
  return (SOUND_KINDS as readonly string[]).includes(value as string);
}

/** Device category an agency assigns to an account. */
export const DEVICE_TYPES = ["unit_radio", "handheld", "dispatch_console", "phone", "radio_bridge"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export function isDeviceType(value: unknown): value is DeviceType {
  return (DEVICE_TYPES as readonly string[]).includes(value as string);
}

// --- agencies (tenants) --------------------------------------------------

export interface AgencyRow {
  id: number;
  name: string;
  slug: string;
  radio_key: string | null;
  disabled: boolean;
  created_at: string;
}

export interface AgencySummary extends AgencyRow {
  user_count: number;
  channel_count: number;
}

const AGENCY_COLS = "id, name, slug, radio_key, disabled, created_at";

/** A URL-safe shared key handsets present to bind to their agency. */
export function generateRadioKey(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Derives a stable URL slug from a free-text agency name. */
function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "agency";
}

/**
 * A slug derived from `name` that no agency uses yet — suffixed (`-2`, `-3`, …)
 * when distinct names normalize to the same base, so tenant creation does not
 * fail spuriously on a derived-slug clash. The unique index remains the backstop
 * against the rare check-then-insert race.
 */
export async function uniqueAgencySlug(name: string): Promise<string> {
  const base = slugify(name);
  if (!(await getAgencyBySlug(base))) {
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await getAgencyBySlug(candidate))) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function listAgencies(): Promise<AgencySummary[]> {
  const res = await requirePool().query<AgencySummary>(
    `SELECT a.id, a.name, a.slug, a.radio_key, a.disabled, a.created_at,
            (SELECT COUNT(*)::int FROM users u WHERE u.agency_id = a.id) AS user_count,
            (SELECT COUNT(*)::int FROM radio_channels c WHERE c.agency_id = a.id) AS channel_count
       FROM agencies a
      ORDER BY a.name ASC;`,
  );
  return res.rows;
}

export async function getAgencyById(id: number): Promise<AgencyRow | null> {
  const res = await requirePool().query<AgencyRow>(`SELECT ${AGENCY_COLS} FROM agencies WHERE id = $1;`, [id]);
  return res.rows[0] ?? null;
}

export async function getAgencyBySlug(slug: string): Promise<AgencyRow | null> {
  const res = await requirePool().query<AgencyRow>(`SELECT ${AGENCY_COLS} FROM agencies WHERE slug = $1;`, [slug]);
  return res.rows[0] ?? null;
}

/** Resolves the agency a handset belongs to from the radio key it presents. */
export async function getAgencyByRadioKey(key: string): Promise<AgencyRow | null> {
  if (!key.trim()) {
    return null;
  }
  const res = await requirePool().query<AgencyRow>(
    `SELECT ${AGENCY_COLS} FROM agencies WHERE radio_key = $1 AND disabled = FALSE;`,
    [key.trim()],
  );
  return res.rows[0] ?? null;
}

/**
 * Resolves the agency for a handset request from its radio key. A per-agency
 * key wins; the legacy global `RADIO_API_KEY` (`legacyEnvKey`) maps to the
 * default agency; absent any key, requests fall through to the default agency
 * only when no global key is configured.
 */
export async function resolveAgencyByKey(
  key: string | null,
  legacyEnvKey: string | undefined,
): Promise<AgencyRow | null> {
  if (key && key.trim()) {
    const byKey = await getAgencyByRadioKey(key);
    if (byKey) {
      return byKey;
    }
    if (legacyEnvKey && key === legacyEnvKey) {
      const def = await getAgencyBySlug(DEFAULT_AGENCY_SLUG);
      return def && !def.disabled ? def : null;
    }
    return null;
  }
  if (legacyEnvKey) {
    return null;
  }
  const def = await getAgencyBySlug(DEFAULT_AGENCY_SLUG);
  return def && !def.disabled ? def : null;
}

/**
 * Creates an agency, seeds it with three starter channels, and creates its
 * first administrator — all in one transaction, so a mid-way failure never
 * leaves an orphaned agency with no admin.
 */
export async function createAgencyWithAdmin(input: {
  name: string;
  slug: string;
  radioKey: string;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
}): Promise<{ agency: AgencyRow; admin: UserRow }> {
  const passwordHash = await hashPassword(input.adminPassword);
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    const agencyRes = await client.query<AgencyRow>(
      `INSERT INTO agencies (name, slug, radio_key) VALUES ($1, $2, $3) RETURNING ${AGENCY_COLS};`,
      [input.name.trim(), input.slug, input.radioKey],
    );
    const agency = agencyRes.rows[0]!;
    await client.query(
      `INSERT INTO radio_channels (agency_id, sort_order, name) VALUES
         ($1, 1, 'Green 1'),
         ($1, 2, 'Green 2'),
         ($1, 3, 'Green 3');`,
      [agency.id],
    );
    const adminRes = await client.query<UserRow>(
      `INSERT INTO users (username, display_name, password_hash, role, unit_id, agency_id)
       VALUES ($1, $2, $3, 'admin', NULL, $4)
       RETURNING ${USER_COLS};`,
      [input.adminUsername.trim(), input.adminDisplayName.trim(), passwordHash, agency.id],
    );
    await client.query("COMMIT");
    return { agency, admin: adminRes.rows[0]! };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAgency(
  id: number,
  patch: { name?: string; disabled?: boolean; radioKey?: string },
): Promise<AgencyRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name.trim()); }
  if (patch.disabled !== undefined) { sets.push(`disabled = $${i++}`); vals.push(patch.disabled); }
  if (patch.radioKey !== undefined) { sets.push(`radio_key = $${i++}`); vals.push(patch.radioKey); }
  if (sets.length === 0) {
    return getAgencyById(id);
  }
  vals.push(id);
  const res = await requirePool().query<AgencyRow>(
    `UPDATE agencies SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${AGENCY_COLS};`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function deleteAgency(id: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM agencies WHERE id = $1;`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Agency branding logo bytes, or null when the agency has not uploaded one. */
export async function getAgencyLogo(agencyId: number): Promise<{ logo: Buffer; mime: string } | null> {
  const res = await requirePool().query<{ logo: Buffer | null; logo_mime: string | null }>(
    `SELECT logo, logo_mime FROM agencies WHERE id = $1;`,
    [agencyId],
  );
  const row = res.rows[0];
  if (!row || !row.logo || !row.logo_mime) {
    return null;
  }
  return { logo: row.logo, mime: row.logo_mime };
}

export async function setAgencyLogo(agencyId: number, logo: Buffer, mime: string): Promise<void> {
  await requirePool().query(`UPDATE agencies SET logo = $2, logo_mime = $3 WHERE id = $1;`, [agencyId, logo, mime]);
}

export async function deleteAgencyLogo(agencyId: number): Promise<void> {
  await requirePool().query(`UPDATE agencies SET logo = NULL, logo_mime = NULL WHERE id = $1;`, [agencyId]);
}

// --- users ---------------------------------------------------------------

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  unit_id: string | null;
  device_type: string | null;
  disabled: boolean;
  agency_id: number | null;
  created_at: string;
  token_generation: number;
}

export interface UserWithHash extends UserRow {
  password_hash: string;
  agency_name: string | null;
  agency_disabled: boolean | null;
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

const USER_COLS = "id, username, display_name, role, unit_id, device_type, disabled, agency_id, created_at, token_generation";

/** Accounts within one agency. */
export async function listUsers(agencyId: number): Promise<UserRow[]> {
  const res = await requirePool().query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE agency_id = $1 ORDER BY username ASC;`,
    [agencyId],
  );
  return res.rows;
}

/** Looks up one account. When `agencyId` is given the row must belong to that agency. */
export async function getUserById(id: number, agencyId?: number): Promise<UserRow | null> {
  const res =
    agencyId === undefined
      ? await requirePool().query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1;`, [id])
      : await requirePool().query<UserRow>(
          `SELECT ${USER_COLS} FROM users WHERE id = $1 AND agency_id = $2;`,
          [id, agencyId],
        );
  return res.rows[0] ?? null;
}

/** Login lookup — usernames are globally unique, so this carries the agency to the token. */
export async function getUserByUsername(username: string): Promise<UserWithHash | null> {
  const res = await requirePool().query<UserWithHash>(
    `SELECT u.id, u.username, u.display_name, u.role, u.unit_id, u.device_type, u.disabled, u.agency_id,
            u.created_at, u.token_generation, u.password_hash,
            a.name AS agency_name, a.disabled AS agency_disabled
       FROM users u
       LEFT JOIN agencies a ON a.id = u.agency_id
      WHERE lower(u.username) = lower($1);`,
    [username],
  );
  return res.rows[0] ?? null;
}

/**
 * Increments and returns the user's session generation. Each successful login
 * calls this so prior tokens (carrying the old `gen` claim) fail the freshness
 * check on their next authenticated request.
 */
export async function bumpTokenGeneration(userId: number): Promise<number> {
  const res = await requirePool().query<{ token_generation: number }>(
    `UPDATE users SET token_generation = token_generation + 1
       WHERE id = $1 RETURNING token_generation;`,
    [userId],
  );
  return res.rows[0]?.token_generation ?? 0;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
  unitId: string | null;
  agencyId: number | null;
  deviceType?: string | null;
}): Promise<UserRow> {
  const hash = await hashPassword(input.password);
  const res = await requirePool().query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role, unit_id, agency_id, device_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${USER_COLS};`,
    [
      input.username.trim(),
      input.displayName.trim(),
      hash,
      input.role,
      input.unitId,
      input.agencyId,
      input.deviceType ?? null,
    ],
  );
  return res.rows[0]!;
}

export async function updateUser(
  id: number,
  patch: {
    displayName?: string;
    role?: Role;
    unitId?: string | null;
    deviceType?: string | null;
    disabled?: boolean;
    password?: string;
  },
): Promise<UserRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(patch.displayName.trim()); }
  if (patch.role !== undefined) { sets.push(`role = $${i++}`); vals.push(patch.role); }
  if (patch.unitId !== undefined) { sets.push(`unit_id = $${i++}`); vals.push(patch.unitId); }
  if (patch.deviceType !== undefined) { sets.push(`device_type = $${i++}`); vals.push(patch.deviceType); }
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

/** Active admins in one agency — used to block deleting/demoting the final administrator. */
export async function countActiveAdmins(agencyId: number): Promise<number> {
  const res = await requirePool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM users WHERE role = 'admin' AND disabled = FALSE AND agency_id = $1;`,
    [agencyId],
  );
  return Number(res.rows[0]?.c ?? "0");
}

// --- channels ------------------------------------------------------------

export async function listChannels(agencyId: number): Promise<ChannelRow[]> {
  const res = await requirePool().query<ChannelRow>(
    `SELECT id, name, sort_order, color, zone FROM radio_channels
     WHERE agency_id = $1
     ORDER BY zone NULLS FIRST, sort_order ASC, id ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function createChannel(agencyId: number, name: string): Promise<ChannelRow> {
  const res = await requirePool().query<ChannelRow>(
    `INSERT INTO radio_channels (agency_id, name, sort_order)
     VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM radio_channels WHERE agency_id = $1), 1))
     RETURNING id, name, sort_order, color, zone;`,
    [agencyId, name.trim()],
  );
  return res.rows[0]!;
}

export async function updateChannel(
  id: number,
  agencyId: number,
  patch: { name?: string; color?: string | null; zone?: string | null },
): Promise<ChannelRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name.trim()); }
  if (patch.color !== undefined) { sets.push(`color = $${i++}`); vals.push(patch.color); }
  if (patch.zone !== undefined) { sets.push(`zone = $${i++}`); vals.push(patch.zone); }
  if (sets.length === 0) {
    return getChannelById(id, agencyId);
  }
  vals.push(id, agencyId);
  const res = await requirePool().query<ChannelRow>(
    `UPDATE radio_channels SET ${sets.join(", ")} WHERE id = $${i++} AND agency_id = $${i}
     RETURNING id, name, sort_order, color, zone;`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function deleteChannel(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_channels WHERE id = $1 AND agency_id = $2;`, [
    id,
    agencyId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export async function getChannelById(id: number, agencyId: number): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRow>(
    `SELECT id, name, sort_order, color, zone FROM radio_channels WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

/** Case-insensitive channel lookup within an agency (used by the voice relay on join). */
export async function getChannelByName(agencyId: number, name: string): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRow>(
    `SELECT id, name, sort_order, color, zone FROM radio_channels
     WHERE agency_id = $1 AND lower(name) = lower($2);`,
    [agencyId, name.trim()],
  );
  return res.rows[0] ?? null;
}

// --- simulcast channels --------------------------------------------------

export interface SimulcastRow {
  id: number;
  name: string;
  member_channel_ids: number[];
}

/** Simulcast channels for one agency, each with the real channels it fans out to. */
export async function listSimulcasts(agencyId: number): Promise<SimulcastRow[]> {
  const res = await requirePool().query<SimulcastRow>(
    `SELECT s.id, s.name,
            COALESCE(array_agg(m.channel_id) FILTER (WHERE m.channel_id IS NOT NULL), '{}') AS member_channel_ids
     FROM simulcast_channels s
     LEFT JOIN simulcast_members m ON m.simulcast_id = s.id
     WHERE s.agency_id = $1
     GROUP BY s.id, s.name
     ORDER BY s.name ASC;`,
    [agencyId],
  );
  return res.rows;
}

/** A simulcast channel and its member channels, resolved by name (used by the voice relay). */
export async function getSimulcastByName(
  agencyId: number,
  name: string,
): Promise<{ id: number; name: string; memberChannels: { id: number; name: string }[] } | null> {
  const p = requirePool();
  const sim = await p.query<{ id: number; name: string }>(
    `SELECT id, name FROM simulcast_channels WHERE agency_id = $1 AND lower(name) = lower($2);`,
    [agencyId, name.trim()],
  );
  const row = sim.rows[0];
  if (!row) {
    return null;
  }
  const members = await p.query<{ id: number; name: string }>(
    `SELECT c.id, c.name FROM simulcast_members m
     JOIN radio_channels c ON c.id = m.channel_id
     WHERE m.simulcast_id = $1
     ORDER BY c.sort_order ASC, c.id ASC;`,
    [row.id],
  );
  return { id: row.id, name: row.name, memberChannels: members.rows };
}

/** Replaces a simulcast's member set; only channels in the agency are kept. */
async function setSimulcastMembers(
  client: PoolClient,
  simulcastId: number,
  agencyId: number,
  channelIds: number[],
): Promise<void> {
  await client.query(`DELETE FROM simulcast_members WHERE simulcast_id = $1;`, [simulcastId]);
  for (const channelId of channelIds) {
    await client.query(
      `INSERT INTO simulcast_members (simulcast_id, channel_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM radio_channels WHERE id = $2 AND agency_id = $3)
       ON CONFLICT DO NOTHING;`,
      [simulcastId, channelId, agencyId],
    );
  }
}

export async function createSimulcast(
  agencyId: number,
  name: string,
  channelIds: number[],
): Promise<{ id: number; name: string }> {
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ id: number; name: string }>(
      `INSERT INTO simulcast_channels (agency_id, name) VALUES ($1, $2) RETURNING id, name;`,
      [agencyId, name.trim()],
    );
    const sim = res.rows[0]!;
    await setSimulcastMembers(client, sim.id, agencyId, channelIds);
    await client.query("COMMIT");
    return sim;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSimulcast(
  id: number,
  agencyId: number,
  patch: { name?: string; channelIds?: number[] },
): Promise<boolean> {
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    const owns = await client.query(
      `SELECT 1 FROM simulcast_channels WHERE id = $1 AND agency_id = $2;`,
      [id, agencyId],
    );
    if (owns.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    if (patch.name !== undefined) {
      await client.query(`UPDATE simulcast_channels SET name = $2 WHERE id = $1;`, [id, patch.name.trim()]);
    }
    if (patch.channelIds !== undefined) {
      await setSimulcastMembers(client, id, agencyId, patch.channelIds);
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSimulcast(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM simulcast_channels WHERE id = $1 AND agency_id = $2;`, [
    id,
    agencyId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

// --- radio bridges -------------------------------------------------------

export const BRIDGE_SOURCE_TYPES = ["stream_url", "audio_device"] as const;
export const BRIDGE_DIRECTIONS = ["inbound", "bidirectional"] as const;
export const BRIDGE_TX_MODES = ["passthrough", "vocoder"] as const;

export interface BridgeRow {
  id: number;
  name: string;
  source_type: string;
  source_url: string | null;
  device_hint: string | null;
  target_channel: string;
  direction: string;
  yield_to_units: boolean;
  tx_mode: string;
  vox_threshold: number;
  vox_hang_ms: number;
  enabled: boolean;
  created_at: string;
}

export interface BridgeInput {
  name: string;
  sourceType: string;
  sourceUrl: string | null;
  deviceHint: string | null;
  targetChannel: string;
  direction: string;
  yieldToUnits: boolean;
  txMode: string;
  voxThreshold: number;
  voxHangMs: number;
  enabled: boolean;
}

const BRIDGE_COLS =
  "id, name, source_type, source_url, device_hint, target_channel, direction, " +
  "yield_to_units, tx_mode, vox_threshold, vox_hang_ms, enabled, created_at";

export async function listBridges(agencyId: number): Promise<BridgeRow[]> {
  const res = await requirePool().query<BridgeRow>(
    `SELECT ${BRIDGE_COLS} FROM radio_bridges WHERE agency_id = $1 ORDER BY name ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function createBridge(agencyId: number, input: BridgeInput): Promise<BridgeRow> {
  const res = await requirePool().query<BridgeRow>(
    `INSERT INTO radio_bridges
       (agency_id, name, source_type, source_url, device_hint, target_channel,
        direction, yield_to_units, tx_mode, vox_threshold, vox_hang_ms, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${BRIDGE_COLS};`,
    [
      agencyId,
      input.name.trim(),
      input.sourceType,
      input.sourceUrl,
      input.deviceHint,
      input.targetChannel.trim(),
      input.direction,
      input.yieldToUnits,
      input.txMode,
      input.voxThreshold,
      input.voxHangMs,
      input.enabled,
    ],
  );
  return res.rows[0]!;
}

export async function updateBridge(
  id: number,
  agencyId: number,
  patch: Partial<BridgeInput>,
): Promise<BridgeRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const col = (name: string, value: unknown) => {
    sets.push(`${name} = $${i++}`);
    vals.push(value);
  };
  if (patch.name !== undefined) col("name", patch.name.trim());
  if (patch.sourceType !== undefined) col("source_type", patch.sourceType);
  if (patch.sourceUrl !== undefined) col("source_url", patch.sourceUrl);
  if (patch.deviceHint !== undefined) col("device_hint", patch.deviceHint);
  if (patch.targetChannel !== undefined) col("target_channel", patch.targetChannel.trim());
  if (patch.direction !== undefined) col("direction", patch.direction);
  if (patch.yieldToUnits !== undefined) col("yield_to_units", patch.yieldToUnits);
  if (patch.txMode !== undefined) col("tx_mode", patch.txMode);
  if (patch.voxThreshold !== undefined) col("vox_threshold", patch.voxThreshold);
  if (patch.voxHangMs !== undefined) col("vox_hang_ms", patch.voxHangMs);
  if (patch.enabled !== undefined) col("enabled", patch.enabled);
  if (sets.length === 0) {
    const res = await requirePool().query<BridgeRow>(
      `SELECT ${BRIDGE_COLS} FROM radio_bridges WHERE id = $1 AND agency_id = $2;`,
      [id, agencyId],
    );
    return res.rows[0] ?? null;
  }
  vals.push(id, agencyId);
  const res = await requirePool().query<BridgeRow>(
    `UPDATE radio_bridges SET ${sets.join(", ")} WHERE id = $${i++} AND agency_id = $${i}
     RETURNING ${BRIDGE_COLS};`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function deleteBridge(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_bridges WHERE id = $1 AND agency_id = $2;`, [
    id,
    agencyId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** One bridge scoped to its agency, or null. Used to authorize bridge runners. */
export async function getBridgeById(id: number, agencyId: number): Promise<BridgeRow | null> {
  const res = await requirePool().query<BridgeRow>(
    `SELECT ${BRIDGE_COLS} FROM radio_bridges WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

/** A bridge row carrying its owning agency — used by the in-process bridge worker. */
export interface AgencyBridgeRow extends BridgeRow {
  agency_id: number;
}

/**
 * Every enabled stream-URL bridge across all tenants whose agency is active.
 * The bridge worker polls this to decide which ffmpeg ingests should run.
 */
export async function listEnabledStreamBridges(): Promise<AgencyBridgeRow[]> {
  const res = await requirePool().query<AgencyBridgeRow>(
    `SELECT b.agency_id, b.id, b.name, b.source_type, b.source_url, b.device_hint,
            b.target_channel, b.direction, b.yield_to_units, b.tx_mode,
            b.vox_threshold, b.vox_hang_ms, b.enabled, b.created_at
       FROM radio_bridges b
       JOIN agencies a ON a.id = b.agency_id
      WHERE b.enabled = TRUE
        AND b.source_type = 'stream_url'
        AND b.source_url IS NOT NULL
        AND a.disabled = FALSE
      ORDER BY b.id ASC;`,
  );
  return res.rows;
}

// --- memberships ---------------------------------------------------------

export async function listMemberships(agencyId: number): Promise<MembershipRow[]> {
  const res = await requirePool().query<MembershipRow>(
    `SELECT m.user_id, m.channel_id, m.permission
     FROM channel_members m
     JOIN users u ON u.id = m.user_id
     WHERE u.agency_id = $1;`,
    [agencyId],
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
  agencyId: number | null;
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
      `INSERT INTO audit_log (agency_id, actor_user_id, actor_name, action, target, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [
        entry.agencyId,
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

export async function listAudit(agencyId: number, limit = 200): Promise<AuditRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 200, 1), 1000);
  const res = await requirePool().query<AuditRow>(
    `SELECT id, ts, actor_user_id, actor_name, action, target, detail, ip
     FROM audit_log WHERE agency_id = $1 ORDER BY ts DESC LIMIT $2;`,
    [agencyId, capped],
  );
  return res.rows;
}

// --- unit aliases --------------------------------------------------------

export interface UnitAliasRow {
  unit_id: string;
  label: string;
  updated_at: string;
}

export async function listUnitAliases(agencyId: number): Promise<UnitAliasRow[]> {
  const res = await requirePool().query<UnitAliasRow>(
    `SELECT unit_id, label, updated_at FROM unit_aliases WHERE agency_id = $1 ORDER BY unit_id ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function setUnitAlias(agencyId: number, unitId: string, label: string): Promise<UnitAliasRow> {
  const res = await requirePool().query<UnitAliasRow>(
    `INSERT INTO unit_aliases (agency_id, unit_id, label, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (agency_id, unit_id) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
     RETURNING unit_id, label, updated_at;`,
    [agencyId, unitId.trim(), label.trim()],
  );
  return res.rows[0]!;
}

export async function deleteUnitAlias(agencyId: number, unitId: string): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM unit_aliases WHERE agency_id = $1 AND unit_id = $2;`, [
    agencyId,
    unitId.trim(),
  ]);
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
  agencyId: number;
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
       (agency_id, channel_id, channel_name, user_id, unit_id, display_name, started_at, ended_at,
        duration_ms, sample_rate, audio, audio_mime, transcript_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'audio/wav', 'pending')
     RETURNING id;`,
    [
      input.agencyId,
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
 * Recent transmissions for one agency (metadata only — never selects audio bytes).
 * `channelNames` further scopes the result to a role's accessible channels.
 */
export async function listTransmissions(opts: {
  agencyId: number;
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
  const where: string[] = ["agency_id = $1"];
  const vals: unknown[] = [opts.agencyId];
  let i = 2;
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
     WHERE ${where.join(" AND ")}
     ORDER BY ${order} LIMIT $${i};`,
    vals,
  );
  return res.rows;
}

/** Audio bytes for one transmission. When `agencyId` is given, the row must belong to it. */
export interface TransmissionDispatchContext {
  id: number;
  agency_id: number;
  channel_name: string;
  unit_id: string | null;
  display_name: string | null;
  started_at: string;
}

export async function getTransmissionDispatchContext(id: number): Promise<TransmissionDispatchContext | null> {
  const res = await requirePool().query<TransmissionDispatchContext>(
    `SELECT id, agency_id, channel_name, unit_id, display_name, started_at
       FROM transmissions WHERE id = $1;`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getChannelAiDispatchRow(
  agencyId: number,
  channelName: string,
): Promise<{ enabled: boolean; yields_to_units: boolean } | null> {
  const res = await requirePool().query<{ enabled: boolean; yields_to_units: boolean }>(
    `SELECT enabled, yields_to_units FROM channel_ai_dispatch WHERE agency_id = $1 AND channel_name = $2;`,
    [agencyId, channelName],
  );
  return res.rows[0] ?? null;
}

export async function getTransmissionAudio(
  id: number,
  agencyId?: number,
): Promise<{ audio: Buffer; mime: string } | null> {
  const res =
    agencyId === undefined
      ? await requirePool().query<{ audio: Buffer | null; audio_mime: string }>(
          `SELECT audio, audio_mime FROM transmissions WHERE id = $1;`,
          [id],
        )
      : await requirePool().query<{ audio: Buffer | null; audio_mime: string }>(
          `SELECT audio, audio_mime FROM transmissions WHERE id = $1 AND agency_id = $2;`,
          [id, agencyId],
        );
  const row = res.rows[0];
  if (!row || !row.audio) {
    return null;
  }
  return { audio: row.audio, mime: row.audio_mime };
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

/** Transmissions on AI-enabled channels that never got an ai_dispatch_log row (backfill). */
export async function listTransmissionIdsMissingAiDispatchLog(limit = 100): Promise<number[]> {
  const res = await requirePool().query<{ id: number }>(
    `SELECT t.id
       FROM transmissions t
       INNER JOIN channel_ai_dispatch c
         ON c.agency_id = t.agency_id AND c.channel_name = t.channel_name AND c.enabled = TRUE
       LEFT JOIN ai_dispatch_log l ON l.transmission_id = t.id
      WHERE l.id IS NULL
        AND t.transcript_status IN ('done', 'pending', 'failed', 'disabled')
        AND t.started_at > now() - interval '12 hours'
      ORDER BY t.started_at ASC
      LIMIT $1;`,
    [Math.min(Math.max(limit, 1), 300)],
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
  /** Device category of the reporting account (handheld, unit_radio, …), or null. */
  device_type: string | null;
  /** Platform the unit is reporting from: "ios" | "android" | "web" | "radio" | …
   *  Null until the client has been updated to send `client_type`. */
  client_type: string | null;
  updated_at: string;
}

export async function upsertPosition(input: {
  agencyId: number;
  unitId: string;
  userId: number | null;
  displayName: string | null;
  channelName: string | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
  heading: number | null;
  speedMps: number | null;
  /** ios | android | web | radio | etc. — null when the client hasn't reported one. */
  clientType: string | null;
}): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `INSERT INTO radio_positions
       (agency_id, unit_id, user_id, display_name, channel_name, lat, lon, accuracy_m, heading, speed_mps, client_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (agency_id, unit_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       display_name = COALESCE(EXCLUDED.display_name, radio_positions.display_name),
       channel_name = EXCLUDED.channel_name,
       lat = EXCLUDED.lat,
       lon = EXCLUDED.lon,
       accuracy_m = EXCLUDED.accuracy_m,
       heading = EXCLUDED.heading,
       speed_mps = EXCLUDED.speed_mps,
       -- Preserve previously-known client_type if the new report doesn't
       -- include one (e.g. legacy clients still talking to the same row).
       client_type = COALESCE(EXCLUDED.client_type, radio_positions.client_type),
       updated_at = now();`,
    [
      input.agencyId,
      input.unitId,
      input.userId,
      input.displayName,
      input.channelName,
      input.lat,
      input.lon,
      input.accuracyM,
      input.heading,
      input.speedMps,
      input.clientType,
    ],
  );
  // Append to the GPS log so the console can replay a unit's track.
  await pool.query(
    `INSERT INTO radio_position_history
       (agency_id, unit_id, lat, lon, accuracy_m, heading, speed_mps)
     VALUES ($1, $2, $3, $4, $5, $6, $7);`,
    [input.agencyId, input.unitId, input.lat, input.lon, input.accuracyM, input.heading, input.speedMps],
  );
  // Trim the log occasionally so history never grows without bound (~90-day window).
  if (Math.random() < 0.01) {
    await pool.query(
      `DELETE FROM radio_position_history WHERE recorded_at < now() - interval '90 days';`,
    );
  }
}

export async function listPositions(agencyId: number): Promise<RadioPosition[]> {
  const res = await requirePool().query<RadioPosition>(
    `SELECT p.unit_id, p.user_id, p.display_name, p.channel_name, p.lat, p.lon,
            p.accuracy_m, p.heading, p.speed_mps, p.client_type, p.updated_at,
            u.device_type
     FROM radio_positions p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.agency_id = $1 ORDER BY p.updated_at DESC;`,
    [agencyId],
  );
  return res.rows;
}

// --- GPS log (position history) -----------------------------------------

export interface PositionSample {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  recorded_at: string;
}

/**
 * A single radio's recorded GPS fixes, oldest first, optionally time-bounded.
 * A dense range is evenly down-sampled to roughly `targetSamples` points
 * (always keeping the first and last fix) so the track stays light to plot.
 */
export async function listPositionHistory(opts: {
  agencyId: number;
  unitId: string;
  from?: string;
  to?: string;
  targetSamples?: number;
}): Promise<PositionSample[]> {
  const target = Math.min(Math.max(Math.trunc(opts.targetSamples ?? 1500) || 1500, 50), 5000);
  const where: string[] = ["agency_id = $1", "unit_id = $2"];
  const vals: unknown[] = [opts.agencyId, opts.unitId];
  let i = 3;
  const from = opts.from?.trim();
  if (from) {
    where.push(`recorded_at >= $${i++}::timestamptz`);
    vals.push(from);
  }
  const to = opts.to?.trim();
  if (to) {
    where.push(`recorded_at <= $${i++}::timestamptz`);
    vals.push(to);
  }
  vals.push(target);
  const res = await requirePool().query<PositionSample>(
    `WITH log AS (
       SELECT lat, lon, accuracy_m, heading, speed_mps, recorded_at,
              row_number() OVER (ORDER BY recorded_at ASC) AS rn,
              count(*) OVER () AS total
       FROM radio_position_history
       WHERE ${where.join(" AND ")}
     )
     SELECT lat, lon, accuracy_m, heading, speed_mps, recorded_at
     FROM log
     WHERE rn = 1 OR rn = total OR (rn - 1) % GREATEST(1, (total / $${i})::int) = 0
     ORDER BY recorded_at ASC;`,
    vals,
  );
  return res.rows;
}

// --- geofences (map overlay zones) --------------------------------------

export interface GeofenceRow {
  id: number;
  name: string;
  shape: string;
  color: string | null;
  center_lat: number | null;
  center_lon: number | null;
  radius_m: number | null;
  /** Polygon vertices as [lat, lon] pairs; null for a circle geofence. */
  points: [number, number][] | null;
  created_by: string | null;
  created_at: string;
}

const GEOFENCE_COLS =
  "id, name, shape, color, center_lat, center_lon, radius_m, points, created_by, created_at";

export async function listGeofences(agencyId: number): Promise<GeofenceRow[]> {
  const res = await requirePool().query<GeofenceRow>(
    `SELECT ${GEOFENCE_COLS} FROM geofences WHERE agency_id = $1 ORDER BY created_at DESC;`,
    [agencyId],
  );
  return res.rows;
}

export async function createGeofence(input: {
  agencyId: number;
  name: string;
  shape: string;
  color: string | null;
  centerLat: number | null;
  centerLon: number | null;
  radiusM: number | null;
  points: [number, number][] | null;
  createdBy: string | null;
}): Promise<GeofenceRow> {
  const res = await requirePool().query<GeofenceRow>(
    `INSERT INTO geofences
       (agency_id, name, shape, color, center_lat, center_lon, radius_m, points, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${GEOFENCE_COLS};`,
    [
      input.agencyId,
      input.name,
      input.shape,
      input.color,
      input.centerLat,
      input.centerLon,
      input.radiusM,
      input.points ? JSON.stringify(input.points) : null,
      input.createdBy,
    ],
  );
  return res.rows[0]!;
}

export async function deleteGeofence(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM geofences WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
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
  agencyId: number;
  kind: AlertKind;
  channelName: string | null;
  targetUnit: string | null;
  fromUserId: number | null;
  fromName: string | null;
  fromUnit: string | null;
  message: string | null;
}): Promise<AlertRow> {
  const res = await requirePool().query<AlertRow>(
    `INSERT INTO alerts (agency_id, kind, channel_name, target_unit, from_user_id, from_name, from_unit, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ALERT_COLS};`,
    [
      input.agencyId,
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

/** Active alerts plus anything from the last 24h for one agency, newest first. */
export async function listAlerts(agencyId: number, limit = 100): Promise<AlertRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
  const res = await requirePool().query<AlertRow>(
    `SELECT ${ALERT_COLS} FROM alerts
     WHERE agency_id = $1 AND (active = TRUE OR created_at > now() - interval '24 hours')
     ORDER BY created_at DESC LIMIT $2;`,
    [agencyId, capped],
  );
  return res.rows;
}

/**
 * Appends an inactive emergency row so radios polling the inbox by an id
 * cursor learn the emergency ended — an in-place UPDATE to the original row
 * is invisible to that cursor. Broadcast (no channel/target) so every device
 * that saw the activation clears regardless of its current channel.
 */
async function appendEmergencyClearedMarker(
  agencyId: number,
  unit: string,
  clearedBy: string,
): Promise<void> {
  await requirePool().query(
    `INSERT INTO alerts (agency_id, kind, channel_name, target_unit, from_unit, message, active, cleared_by, cleared_at)
     VALUES ($1, 'emergency', NULL, NULL, $2, 'Emergency cleared', FALSE, $3, now());`,
    [agencyId, unit, clearedBy],
  );
}

export async function clearAlert(id: number, agencyId: number, clearedBy: string): Promise<AlertRow | null> {
  const res = await requirePool().query<AlertRow>(
    `UPDATE alerts SET active = FALSE, cleared_by = $3, cleared_at = now()
     WHERE id = $1 AND agency_id = $2 RETURNING ${ALERT_COLS};`,
    [id, agencyId, clearedBy],
  );
  const row = res.rows[0] ?? null;
  if (row && row.kind === "emergency" && row.from_unit) {
    await appendEmergencyClearedMarker(agencyId, row.from_unit, clearedBy);
  }
  return row;
}

export async function clearEmergenciesFromUnit(agencyId: number, unit: string, clearedBy: string): Promise<number> {
  const res = await requirePool().query(
    `UPDATE alerts SET active = FALSE, cleared_by = $3, cleared_at = now()
     WHERE agency_id = $1 AND kind = 'emergency' AND active = TRUE AND from_unit = $2;`,
    [agencyId, unit, clearedBy],
  );
  const cleared = res.rowCount ?? 0;
  if (cleared > 0) {
    await appendEmergencyClearedMarker(agencyId, unit, clearedBy);
  }
  return cleared;
}

/** Alerts addressed to a radio (direct, its channel, or broadcast) newer than `sinceId`. */
export async function listInboxAlerts(
  agencyId: number,
  unit: string,
  channel: string | null,
  sinceId: number,
): Promise<AlertRow[]> {
  const res = await requirePool().query<AlertRow>(
    `SELECT ${ALERT_COLS} FROM alerts
     WHERE agency_id = $1
       AND id > $2
       AND ( target_unit = $3
             OR ( target_unit IS NULL
                  AND ( channel_name IS NULL OR lower(channel_name) = lower($4) ) ) )
     ORDER BY id ASC LIMIT 50;`,
    [agencyId, sinceId, unit, channel ?? ""],
  );
  return res.rows;
}

/** Sets or clears the 10-33 marker for one channel of an agency. */
export async function setChannelTen33(
  agencyId: number,
  channelName: string,
  active: boolean,
): Promise<void> {
  await requirePool().query(
    `INSERT INTO channel_markers (agency_id, channel_name, active)
       VALUES ($1, $2, $3)
     ON CONFLICT (agency_id, channel_name)
       DO UPDATE SET active = EXCLUDED.active, updated_at = now();`,
    [agencyId, channelName, active],
  );
}

/** Whether a channel is currently flagged 10-33. */
export async function getChannelTen33Active(agencyId: number, channelName: string): Promise<boolean> {
  const res = await requirePool().query<{ active: boolean }>(
    `SELECT active FROM channel_markers WHERE agency_id = $1 AND channel_name = $2;`,
    [agencyId, channelName],
  );
  return res.rows[0]?.active === true;
}

/** Channel names currently flagged 10-33 for an agency. */
export async function listTen33Channels(agencyId: number): Promise<string[]> {
  const res = await requirePool().query<{ channel_name: string }>(
    `SELECT channel_name FROM channel_markers WHERE agency_id = $1 AND active = TRUE;`,
    [agencyId],
  );
  return res.rows.map((r) => r.channel_name);
}

// --- agency sounds (custom radio tones) ----------------------------------

export interface AgencySoundMeta {
  kind: string;
  mime: string;
  byte_size: number;
  updated_at: string;
}

/** Metadata for the tones an agency has customized (never selects the audio bytes). */
export async function listAgencySounds(agencyId: number): Promise<AgencySoundMeta[]> {
  const res = await requirePool().query<AgencySoundMeta>(
    `SELECT kind, mime, byte_size, updated_at FROM agency_sounds WHERE agency_id = $1 ORDER BY kind ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function getAgencySound(
  agencyId: number,
  kind: string,
): Promise<{ audio: Buffer; mime: string } | null> {
  const res = await requirePool().query<{ audio: Buffer; mime: string }>(
    `SELECT audio, mime FROM agency_sounds WHERE agency_id = $1 AND kind = $2;`,
    [agencyId, kind],
  );
  return res.rows[0] ?? null;
}

export async function setAgencySound(
  agencyId: number,
  kind: string,
  audio: Buffer,
  mime: string,
): Promise<void> {
  await requirePool().query(
    `INSERT INTO agency_sounds (agency_id, kind, audio, mime, byte_size, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agency_id, kind) DO UPDATE SET
       audio = EXCLUDED.audio, mime = EXCLUDED.mime, byte_size = EXCLUDED.byte_size, updated_at = now();`,
    [agencyId, kind, audio, mime, audio.length],
  );
}

export async function deleteAgencySound(agencyId: number, kind: string): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM agency_sounds WHERE agency_id = $1 AND kind = $2;`,
    [agencyId, kind],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * A token that changes whenever any of an agency's custom tones is added,
 * replaced or removed. Clients poll it to know when to re-pull their tones —
 * the row count covers removals, the latest timestamp covers adds/replacements.
 */
export async function getAgencySoundsVersion(agencyId: number): Promise<string> {
  const res = await requirePool().query<{ n: string; ts: string | null }>(
    `SELECT COUNT(*)::text AS n, MAX(updated_at)::text AS ts
       FROM agency_sounds WHERE agency_id = $1;`,
    [agencyId],
  );
  const row = res.rows[0];
  return `${row?.n ?? "0"}:${row?.ts ?? "-"}`;
}

// --- custom soundboard tone-outs ----------------------------------------

export const TONE_OUT_PLAY_MODES = ["once", "loop"] as const;
export type ToneOutPlayMode = (typeof TONE_OUT_PLAY_MODES)[number];

/** Metadata for one soundboard tone-out (never selects the audio/icon bytes). */
export interface ToneOutMeta {
  id: number;
  name: string;
  play_mode: string;
  icon_kind: string;
  icon_color: string;
  has_image: boolean;
  has_audio: boolean;
  sort_order: number;
}

const TONE_OUT_META_COLS =
  "id, name, play_mode, icon_kind, icon_color, " +
  "(icon_image IS NOT NULL) AS has_image, (audio IS NOT NULL) AS has_audio, sort_order";

export async function listToneOuts(agencyId: number): Promise<ToneOutMeta[]> {
  const res = await requirePool().query<ToneOutMeta>(
    `SELECT ${TONE_OUT_META_COLS} FROM agency_tone_outs
     WHERE agency_id = $1 ORDER BY sort_order ASC, id ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function createToneOut(
  agencyId: number,
  input: { name: string; playMode: string; iconKind: string; iconColor: string },
): Promise<ToneOutMeta> {
  const res = await requirePool().query<ToneOutMeta>(
    `INSERT INTO agency_tone_outs (agency_id, name, play_mode, icon_kind, icon_color, sort_order)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX(sort_order) + 1 FROM agency_tone_outs WHERE agency_id = $1), 0))
     RETURNING ${TONE_OUT_META_COLS};`,
    [agencyId, input.name, input.playMode, input.iconKind, input.iconColor],
  );
  return res.rows[0]!;
}

export async function updateToneOut(
  id: number,
  agencyId: number,
  patch: { name?: string; playMode?: string; iconKind?: string; iconColor?: string },
): Promise<ToneOutMeta | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(patch.name);
  }
  if (patch.playMode !== undefined) {
    sets.push(`play_mode = $${i++}`);
    vals.push(patch.playMode);
  }
  if (patch.iconKind !== undefined) {
    sets.push(`icon_kind = $${i++}`);
    vals.push(patch.iconKind);
  }
  if (patch.iconColor !== undefined) {
    sets.push(`icon_color = $${i++}`);
    vals.push(patch.iconColor);
  }
  if (sets.length === 0) {
    const res = await requirePool().query<ToneOutMeta>(
      `SELECT ${TONE_OUT_META_COLS} FROM agency_tone_outs WHERE id = $1 AND agency_id = $2;`,
      [id, agencyId],
    );
    return res.rows[0] ?? null;
  }
  vals.push(id, agencyId);
  const res = await requirePool().query<ToneOutMeta>(
    `UPDATE agency_tone_outs SET ${sets.join(", ")}
     WHERE id = $${i++} AND agency_id = $${i}
     RETURNING ${TONE_OUT_META_COLS};`,
    vals,
  );
  return res.rows[0] ?? null;
}

export async function setToneOutAudio(
  id: number,
  agencyId: number,
  audio: Buffer,
  mime: string,
): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE agency_tone_outs SET audio = $1, audio_mime = $2, audio_bytes = $3
     WHERE id = $4 AND agency_id = $5;`,
    [audio, mime, audio.length, id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setToneOutIcon(
  id: number,
  agencyId: number,
  image: Buffer,
  mime: string,
): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE agency_tone_outs SET icon_image = $1, icon_mime = $2 WHERE id = $3 AND agency_id = $4;`,
    [image, mime, id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function clearToneOutIcon(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(
    `UPDATE agency_tone_outs SET icon_image = NULL, icon_mime = NULL
     WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getToneOutAudio(
  id: number,
  agencyId: number,
): Promise<{ audio: Buffer; mime: string } | null> {
  const res = await requirePool().query<{ audio: Buffer; mime: string }>(
    `SELECT audio, COALESCE(audio_mime, 'audio/wav') AS mime
     FROM agency_tone_outs WHERE id = $1 AND agency_id = $2 AND audio IS NOT NULL;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

export async function getToneOutIcon(
  id: number,
  agencyId: number,
): Promise<{ image: Buffer; mime: string } | null> {
  const res = await requirePool().query<{ image: Buffer; mime: string }>(
    `SELECT icon_image AS image, COALESCE(icon_mime, 'image/png') AS mime
     FROM agency_tone_outs WHERE id = $1 AND agency_id = $2 AND icon_image IS NOT NULL;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

export async function deleteToneOut(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM agency_tone_outs WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** First candidate username not already taken; falls back to a unique suffix. */
async function firstAvailableUsername(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    const name = candidate.trim();
    if (name && !(await getUserByUsername(name))) {
      return name;
    }
  }
  return `owner-${Date.now().toString(36)}`;
}

/**
 * Ensures the owner portal and the admin portal are both reachable:
 * - a platform `owner` account exists (created on fresh databases and on
 *   existing single-tenant databases that predate multi-agency support);
 * - the default agency has an administrator on a brand-new database.
 */
export async function seedInitialAccounts(): Promise<void> {
  const p = getPool();
  if (!p) {
    return;
  }

  const owners = await p.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users WHERE role = 'owner';`);
  if (Number(owners.rows[0]?.c ?? "0") === 0) {
    const ownerPassword = process.env.OWNER_INITIAL_PASSWORD?.trim() || "platform-owner";
    // "owner" may already be taken by a tenant account on a pre-multi-tenant
    // install, so fall back to another name rather than failing to seed.
    const ownerUsername = await firstAvailableUsername([
      process.env.OWNER_USERNAME?.trim() ?? "",
      "owner",
      "platform-owner",
      "platform-admin",
    ]);
    await createUser({
      username: ownerUsername,
      displayName: "Platform Owner",
      password: ownerPassword,
      role: "owner",
      unitId: null,
      agencyId: null,
    });
    console.log(
      `Seeded platform owner — username "${ownerUsername}", password "${ownerPassword}". Change it after first login.`,
    );
  }

  const agencyUsers = await p.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users WHERE role <> 'owner';`);
  if (Number(agencyUsers.rows[0]?.c ?? "0") === 0) {
    const defaultAgency = await getAgencyBySlug(DEFAULT_AGENCY_SLUG);
    const adminPassword = process.env.ADMIN_INITIAL_PASSWORD?.trim() || "radio-admin";
    await createUser({
      username: "admin",
      displayName: "Administrator",
      password: adminPassword,
      role: "admin",
      unitId: null,
      agencyId: defaultAgency?.id ?? null,
    });
    console.log(`Seeded initial admin — username "admin", password "${adminPassword}". Change it after first login.`);
  }
}

// --- agency integrations (per-tenant API keys, webhooks) -----------------

export interface AgencyIntegrationRow {
  integration_key: string;
  value: string;
  updated_at: string;
}

export async function listAgencyIntegrationRows(agencyId: number): Promise<AgencyIntegrationRow[]> {
  const res = await requirePool().query<AgencyIntegrationRow>(
    `SELECT integration_key, value, updated_at
       FROM agency_integrations
      WHERE agency_id = $1;`,
    [agencyId],
  );
  return res.rows;
}

export async function getAgencyIntegrationValue(
  agencyId: number,
  integrationKey: string,
): Promise<string | null> {
  const res = await requirePool().query<{ value: string }>(
    `SELECT value FROM agency_integrations WHERE agency_id = $1 AND integration_key = $2;`,
    [agencyId, integrationKey],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  const v = row.value?.trim() ?? "";
  return v.length > 0 ? v : null;
}

export async function setAgencyIntegrationValue(
  agencyId: number,
  integrationKey: string,
  value: string,
  updatedByUserId: number | null,
): Promise<void> {
  await requirePool().query(
    `INSERT INTO agency_integrations (agency_id, integration_key, value, updated_by_user_id)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (agency_id, integration_key)
       DO UPDATE SET value = EXCLUDED.value,
                     updated_at = now(),
                     updated_by_user_id = EXCLUDED.updated_by_user_id;`,
    [agencyId, integrationKey, value, updatedByUserId],
  );
}

export async function deleteAgencyIntegration(agencyId: number, integrationKey: string): Promise<void> {
  await requirePool().query(`DELETE FROM agency_integrations WHERE agency_id = $1 AND integration_key = $2;`, [
    agencyId,
    integrationKey,
  ]);
}

// --- per-channel AI dispatch toggle --------------------------------------

export async function isChannelAiDispatchEnabled(agencyId: number, channelName: string): Promise<boolean> {
  const res = await requirePool().query<{ enabled: boolean }>(
    `SELECT enabled FROM channel_ai_dispatch WHERE agency_id = $1 AND channel_name = $2;`,
    [agencyId, channelName],
  );
  return res.rows[0]?.enabled === true;
}

export async function setChannelAiDispatch(
  agencyId: number,
  channelName: string,
  enabled: boolean,
  yieldsToUnits?: boolean,
): Promise<void> {
  const yields = yieldsToUnits ?? true;
  await requirePool().query(
    `INSERT INTO channel_ai_dispatch (agency_id, channel_name, enabled, yields_to_units)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (agency_id, channel_name)
       DO UPDATE SET enabled = EXCLUDED.enabled,
                     yields_to_units = EXCLUDED.yields_to_units,
                     updated_at = now();`,
    [agencyId, channelName, enabled, yields],
  );
}

export async function listAllChannelAiDispatchEnabledRows(): Promise<
  Array<{ agency_id: number; channel_name: string }>
> {
  const res = await requirePool().query<{ agency_id: number; channel_name: string }>(
    `SELECT agency_id, channel_name FROM channel_ai_dispatch WHERE enabled = TRUE;`,
  );
  return res.rows;
}

export async function listChannelAiDispatchEnabled(agencyId: number): Promise<string[]> {
  const res = await requirePool().query<{ channel_name: string }>(
    `SELECT channel_name FROM channel_ai_dispatch WHERE agency_id = $1 AND enabled = TRUE;`,
    [agencyId],
  );
  return res.rows.map((r) => r.channel_name);
}

// --- AI dispatcher knowledge base (RAG) ----------------------------------

export const KB_CATEGORY_SECTIONS = [
  {
    id: "radio_operations",
    label: "Radio operations",
    description: "Radio procedures, channel plans, route information, codes, and call classifications.",
    categories: [
      {
        id: "post_order",
        label: "Post orders",
        description: "Site-specific guard instructions and standing orders.",
      },
      {
        id: "route_sheet",
        label: "Route sheets",
        description: "Patrol routes, checkpoint sequences, and tour instructions.",
      },
      {
        id: "radio_procedure",
        label: "Radio procedures",
        description: "How units should call in, acknowledge, escalate, and use channels.",
      },
      {
        id: "radio_codes",
        label: "Radio codes",
        description: "10-codes, signal codes, disposition codes, and local radio shorthand.",
      },
      {
        id: "call_types",
        label: "Call types",
        description: "CAD/event types and how dispatch should classify incoming traffic.",
      },
    ],
  },
  {
    id: "safety_response",
    label: "Safety and response",
    description: "Safety rules, emergency actions, and incident response references.",
    categories: [
      {
        id: "safety_procedure",
        label: "Safety procedures",
        description: "Officer safety, site hazards, PPE, and safe-work instructions.",
      },
      {
        id: "emergency_procedure",
        label: "Emergency procedures",
        description: "Fire, medical, evacuation, lockdown, and critical incident steps.",
      },
      {
        id: "incident_response",
        label: "Incident response plans",
        description: "Response playbooks for alarms, trespassers, disturbances, and other events.",
      },
    ],
  },
  {
    id: "policy_law",
    label: "Policy and legal",
    description: "Agency policy, SOPs, legal references, and compliance material.",
    categories: [
      {
        id: "policy",
        label: "Policies and SOPs",
        description: "Agency rules, standard operating procedures, and internal policy.",
      },
      {
        id: "law_reference",
        label: "Laws and legal references",
        description: "Statutes, ordinances, enforcement limits, and legal guidance.",
      },
    ],
  },
  {
    id: "client_site",
    label: "Client and site information",
    description: "Client preferences, property details, contacts, and escalation information.",
    categories: [
      {
        id: "client_info",
        label: "Client information",
        description: "Client expectations, preferences, reporting rules, and special instructions.",
      },
      {
        id: "property_info",
        label: "Property information",
        description: "Access points, landmarks, maps, tenants, suites, and local site details.",
      },
      {
        id: "contact_directory",
        label: "Contacts and escalation",
        description: "Who to call, after-hours contacts, supervisors, vendors, and escalation paths.",
      },
    ],
  },
  {
    id: "general_reference",
    label: "General reference",
    description: "Training material and documents that do not fit another category.",
    categories: [
      {
        id: "training",
        label: "Training material",
        description: "Training guides, onboarding material, and dispatcher reference examples.",
      },
      {
        id: "other",
        label: "Other reference",
        description: "General material that does not fit a more specific category.",
      },
    ],
  },
] as const;

export type KbCategory = (typeof KB_CATEGORY_SECTIONS)[number]["categories"][number]["id"];

export const KB_CATEGORIES: KbCategory[] = KB_CATEGORY_SECTIONS.flatMap((section) =>
  section.categories.map((category) => category.id),
);

export function isKbCategory(value: unknown): value is KbCategory {
  return typeof value === "string" && (KB_CATEGORIES as readonly string[]).includes(value);
}

export function getKbCategoryLabel(value: string): string {
  for (const section of KB_CATEGORY_SECTIONS) {
    const category = section.categories.find((item) => item.id === value);
    if (category) {
      return category.label;
    }
  }
  return "Reference";
}

/** Document metadata for the admin list (never selects the PDF bytes or extracted text). */
export interface KbDocumentMeta {
  id: number;
  title: string;
  category: string;
  property_code: string | null;
  filename: string | null;
  mime: string;
  byte_size: number;
  status: string;
  error: string | null;
  chunk_count: number;
  embed_model: string | null;
  created_at: string;
  updated_at: string;
}

const KB_DOC_META_COLS =
  "id, title, category, property_code, filename, mime, byte_size, status, error, chunk_count, embed_model, created_at, updated_at";

export async function listKbDocuments(agencyId: number): Promise<KbDocumentMeta[]> {
  const res = await requirePool().query<KbDocumentMeta>(
    `SELECT ${KB_DOC_META_COLS} FROM agency_kb_documents
      WHERE agency_id = $1 ORDER BY created_at DESC, id DESC;`,
    [agencyId],
  );
  return res.rows;
}

export async function createKbDocument(
  agencyId: number,
  input: {
    title: string;
    category: string;
    propertyCode: string | null;
    filename: string | null;
    mime: string;
    content: Buffer;
    uploadedByUserId: number | null;
  },
): Promise<KbDocumentMeta> {
  const res = await requirePool().query<KbDocumentMeta>(
    `INSERT INTO agency_kb_documents
       (agency_id, title, category, property_code, filename, mime, byte_size, content, status, uploaded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', $9)
     RETURNING ${KB_DOC_META_COLS};`,
    [
      agencyId,
      input.title,
      input.category,
      input.propertyCode,
      input.filename,
      input.mime,
      input.content.length,
      input.content,
      input.uploadedByUserId,
    ],
  );
  return res.rows[0]!;
}

/** Loads a document's original bytes for download or re-indexing (agency-scoped). */
export async function getKbDocumentContent(
  agencyId: number,
  id: number,
): Promise<{ content: Buffer; mime: string; filename: string | null } | null> {
  const res = await requirePool().query<{ content: Buffer; mime: string; filename: string | null }>(
    `SELECT content, mime, filename FROM agency_kb_documents WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

/** Document row used by the ingest worker — includes the bytes, not agency-scoped. */
export async function getKbDocumentForIngest(
  id: number,
): Promise<{ id: number; agency_id: number; content: Buffer } | null> {
  const res = await requirePool().query<{ id: number; agency_id: number; content: Buffer }>(
    `SELECT id, agency_id, content FROM agency_kb_documents WHERE id = $1;`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function setKbDocumentStatus(
  id: number,
  status: string,
  patch: {
    error?: string | null;
    chunkCount?: number;
    extractedText?: string | null;
    embedModel?: string | null;
  } = {},
): Promise<void> {
  await requirePool().query(
    `UPDATE agency_kb_documents
        SET status = $2,
            error = $3,
            chunk_count = COALESCE($4, chunk_count),
            extracted_text = COALESCE($5, extracted_text),
            embed_model = COALESCE($6, embed_model),
            updated_at = now()
      WHERE id = $1;`,
    [
      id,
      status,
      patch.error ?? null,
      patch.chunkCount ?? null,
      patch.extractedText ?? null,
      patch.embedModel ?? null,
    ],
  );
}

/** Documents left mid-ingest by a crash/restart — re-queued on boot. */
export async function listProcessingKbDocumentIds(): Promise<number[]> {
  const res = await requirePool().query<{ id: number }>(
    `SELECT id FROM agency_kb_documents WHERE status = 'processing' ORDER BY id ASC LIMIT 200;`,
  );
  return res.rows.map((r) => r.id);
}

/** Lightweight agency-scoped existence check (avoids fetching the PDF bytes). */
export async function kbDocumentExists(agencyId: number, id: number): Promise<boolean> {
  const res = await requirePool().query(
    `SELECT 1 FROM agency_kb_documents WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteKbDocument(agencyId: number, id: number): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM agency_kb_documents WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Replaces all chunks for a document in one transaction (used by ingest / reindex). */
export async function replaceKbChunks(
  documentId: number,
  agencyId: number,
  chunks: Array<{ content: string; embedding: number[] }>,
): Promise<void> {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM agency_kb_chunks WHERE document_id = $1;`, [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await client.query(
        `INSERT INTO agency_kb_chunks (document_id, agency_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5);`,
        [documentId, agencyId, i, chunk.content, chunk.embedding],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface KbChunkRow {
  id: string;
  document_id: number;
  title: string;
  category: string;
  property_code: string | null;
  content: string;
  embedding: number[];
}

/**
 * Ready chunks for an agency, joined to their document for source labelling.
 * Only chunks embedded with the current model are returned: a model swap leaves
 * old vectors in a different space/dimension, so they must not be ranked against
 * a query embedded with the new model (the document is flagged for re-index in
 * the admin UI instead). Legacy rows with a NULL stamp are assumed current.
 */
export async function listKbChunksForAgency(
  agencyId: number,
  embedModel: string,
): Promise<KbChunkRow[]> {
  const res = await requirePool().query<KbChunkRow>(
    `SELECT c.id::text AS id, c.document_id, d.title, d.category, d.property_code,
            c.content, c.embedding
       FROM agency_kb_chunks c
       JOIN agency_kb_documents d ON d.id = c.document_id
      WHERE c.agency_id = $1
        AND d.status = 'ready'
        AND (d.embed_model = $2 OR d.embed_model IS NULL);`,
    [agencyId, embedModel],
  );
  return res.rows;
}
