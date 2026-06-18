import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, requirePool, DEFAULT_AGENCY_SLUG } from "./db.js";
import { hashPassword, type Role } from "./auth.js";
import { EMERGENCY_CHANNEL_NAME_SQL_REGEX } from "./emergencyChannels.js";
import {
  isEmergencyLifecycleState,
  nextEmergencyState,
  type EmergencyTransition,
  type EmergencyTransitionError,
} from "./emergencyLifecycle.js";
import { coerceVoiceCodec, type VoiceCodec } from "./voiceCodecs.js";
import type { PlanTier, SubscriptionStatus } from "./billing/types.js";

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
  /** Codec applied to new channels created in this agency. Existing
   *  channels keep whatever codec they were set to — the default only
   *  kicks in on POST /admin/channels and on agency seed. */
  default_codec: VoiceCodec;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  plan_tier: PlanTier;
  trial_ends_at: string | null;
  /** Days to retain transmissions; null = unlimited. */
  transmission_retention_days: number | null;
  logs_unlimited: boolean;
  billing_email: string | null;
  signup_completed_at: string | null;
  trial_email_used: boolean;
}

export interface AgencySummary extends AgencyRow {
  user_count: number;
  channel_count: number;
}

const AGENCY_COLS =
  "id, name, slug, radio_key, disabled, created_at, default_codec, stripe_customer_id, stripe_subscription_id, subscription_status, plan_tier, trial_ends_at, transmission_retention_days, logs_unlimited, billing_email, signup_completed_at, trial_email_used";

type AgencyRowRaw = Omit<AgencyRow, "default_codec" | "subscription_status" | "plan_tier"> & {
  default_codec: string;
  subscription_status: string;
  plan_tier: string;
};

function asSubscriptionStatus(raw: string): SubscriptionStatus {
  const v = raw as SubscriptionStatus;
  if (v === "trialing" || v === "active" || v === "past_due" || v === "canceled" || v === "comped") {
    return v;
  }
  return "comped";
}

function asPlanTier(raw: string): PlanTier {
  return raw === "basic" ? "basic" : "pro";
}

function asAgencyRow(raw: AgencyRowRaw): AgencyRow {
  return {
    ...raw,
    default_codec: coerceVoiceCodec(raw.default_codec),
    subscription_status: asSubscriptionStatus(raw.subscription_status),
    plan_tier: asPlanTier(raw.plan_tier),
  };
}

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
  type Raw = Omit<AgencySummary, "default_codec"> & { default_codec: string };
  const res = await requirePool().query<Raw & AgencyRowRaw>(
    `SELECT a.id, a.name, a.slug, a.radio_key, a.disabled, a.created_at, a.default_codec,
            a.stripe_customer_id, a.stripe_subscription_id, a.subscription_status, a.plan_tier,
            a.trial_ends_at, a.transmission_retention_days, a.logs_unlimited, a.billing_email,
            a.signup_completed_at, a.trial_email_used,
            (SELECT COUNT(*)::int FROM users u WHERE u.agency_id = a.id) AS user_count,
            (SELECT COUNT(*)::int FROM radio_channels c WHERE c.agency_id = a.id) AS channel_count
       FROM agencies a
      ORDER BY a.name ASC;`,
  );
  return res.rows.map((r) => ({
    ...asAgencyRow(r),
    user_count: r.user_count,
    channel_count: r.channel_count,
  }));
}

export async function getAgencyById(id: number): Promise<AgencyRow | null> {
  const res = await requirePool().query<AgencyRowRaw>(`SELECT ${AGENCY_COLS} FROM agencies WHERE id = $1;`, [id]);
  return res.rows[0] ? asAgencyRow(res.rows[0]) : null;
}

export async function getAgencyBySlug(slug: string): Promise<AgencyRow | null> {
  const res = await requirePool().query<AgencyRowRaw>(`SELECT ${AGENCY_COLS} FROM agencies WHERE slug = $1;`, [slug]);
  return res.rows[0] ? asAgencyRow(res.rows[0]) : null;
}

/** Resolves the agency a handset belongs to from the radio key it presents. */
export async function getAgencyByRadioKey(key: string): Promise<AgencyRow | null> {
  if (!key.trim()) {
    return null;
  }
  const res = await requirePool().query<AgencyRowRaw>(
    `SELECT ${AGENCY_COLS} FROM agencies WHERE radio_key = $1 AND disabled = FALSE;`,
    [key.trim()],
  );
  return res.rows[0] ? asAgencyRow(res.rows[0]) : null;
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
  billing?: {
    email: string;
    planTier: PlanTier;
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: string | null;
    transmissionRetentionDays: number | null;
    logsUnlimited: boolean;
    trialEmailUsed: boolean;
    signupCompletedAt: string;
  };
}): Promise<{ agency: AgencyRow; admin: UserRow }> {
  const passwordHash = await hashPassword(input.adminPassword);
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    const b = input.billing;
    const agencyRes = await client.query<AgencyRowRaw>(
      b
        ? `INSERT INTO agencies (
             name, slug, radio_key, billing_email, plan_tier, subscription_status,
             trial_ends_at, transmission_retention_days, logs_unlimited,
             trial_email_used, signup_completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING ${AGENCY_COLS};`
        : `INSERT INTO agencies (name, slug, radio_key) VALUES ($1, $2, $3) RETURNING ${AGENCY_COLS};`,
      b
        ? [
            input.name.trim(),
            input.slug,
            input.radioKey,
            b.email,
            b.planTier,
            b.subscriptionStatus,
            b.trialEndsAt,
            b.transmissionRetentionDays,
            b.logsUnlimited,
            b.trialEmailUsed,
            b.signupCompletedAt,
          ]
        : [input.name.trim(), input.slug, input.radioKey],
    );
    const agency = asAgencyRow(agencyRes.rows[0]!);
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

export async function getAgencyBillingById(id: number): Promise<AgencyRow | null> {
  return getAgencyById(id);
}

export async function countBillableRadioUsers(agencyId: number): Promise<number> {
  const res = await requirePool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM users WHERE agency_id = $1 AND role = 'radio' AND disabled = FALSE;`,
    [agencyId],
  );
  return Number(res.rows[0]?.n ?? "0");
}

export async function updateAgencyBilling(
  id: number,
  patch: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: SubscriptionStatus;
    planTier?: PlanTier;
    trialEndsAt?: string | null;
    transmissionRetentionDays?: number | null;
    logsUnlimited?: boolean;
    billingEmail?: string;
    disabled?: boolean;
  },
): Promise<AgencyRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.stripeCustomerId !== undefined) {
    sets.push(`stripe_customer_id = $${i++}`);
    vals.push(patch.stripeCustomerId);
  }
  if (patch.stripeSubscriptionId !== undefined) {
    sets.push(`stripe_subscription_id = $${i++}`);
    vals.push(patch.stripeSubscriptionId);
  }
  if (patch.subscriptionStatus !== undefined) {
    sets.push(`subscription_status = $${i++}`);
    vals.push(patch.subscriptionStatus);
  }
  if (patch.planTier !== undefined) {
    sets.push(`plan_tier = $${i++}`);
    vals.push(patch.planTier);
  }
  if (patch.trialEndsAt !== undefined) {
    sets.push(`trial_ends_at = $${i++}`);
    vals.push(patch.trialEndsAt);
  }
  if (patch.transmissionRetentionDays !== undefined) {
    sets.push(`transmission_retention_days = $${i++}`);
    vals.push(patch.transmissionRetentionDays);
  }
  if (patch.logsUnlimited !== undefined) {
    sets.push(`logs_unlimited = $${i++}`);
    vals.push(patch.logsUnlimited);
  }
  if (patch.billingEmail !== undefined) {
    sets.push(`billing_email = $${i++}`);
    vals.push(patch.billingEmail);
  }
  if (patch.disabled !== undefined) {
    sets.push(`disabled = $${i++}`);
    vals.push(patch.disabled);
  }
  if (sets.length === 0) {
    return getAgencyById(id);
  }
  vals.push(id);
  const res = await requirePool().query<AgencyRowRaw>(
    `UPDATE agencies SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${AGENCY_COLS};`,
    vals,
  );
  return res.rows[0] ? asAgencyRow(res.rows[0]) : null;
}

export async function agencyAllowsAiDispatch(agencyId: number): Promise<boolean> {
  const agency = await getAgencyById(agencyId);
  if (!agency) {
    return false;
  }
  if (agency.subscription_status === "comped") {
    return true;
  }
  return agency.plan_tier === "pro";
}

export async function updateAgency(
  id: number,
  patch: { name?: string; disabled?: boolean; radioKey?: string; defaultCodec?: VoiceCodec },
): Promise<AgencyRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name.trim()); }
  if (patch.disabled !== undefined) { sets.push(`disabled = $${i++}`); vals.push(patch.disabled); }
  if (patch.radioKey !== undefined) { sets.push(`radio_key = $${i++}`); vals.push(patch.radioKey); }
  if (patch.defaultCodec !== undefined) { sets.push(`default_codec = $${i++}`); vals.push(patch.defaultCodec); }
  if (sets.length === 0) {
    return getAgencyById(id);
  }
  vals.push(id);
  const res = await requirePool().query<AgencyRowRaw>(
    `UPDATE agencies SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${AGENCY_COLS};`,
    vals,
  );
  return res.rows[0] ? asAgencyRow(res.rows[0]) : null;
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
  /** Template this user follows; their channel memberships mirror it. Null = none. */
  assigned_template_id: number | null;
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
  /** Zone NAME from the joined radio_zones row (legacy column is no longer read). */
  zone: string | null;
  zone_id: number | null;
  zone_number: number | null;
  codec: VoiceCodec;
}

export interface ZoneRow {
  id: number;
  zone_number: number;
  name: string;
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
  zone_number: number | null;
  codec: VoiceCodec;
}

/** Raw channel row shape as it comes off pg before codec coercion. */
type ChannelRowRaw = Omit<ChannelRow, "codec"> & { codec: string };
type UserChannelRowRaw = Omit<UserChannelRow, "codec"> & { codec: string };

function asChannelRow(raw: ChannelRowRaw): ChannelRow {
  return { ...raw, codec: coerceVoiceCodec(raw.codec) };
}

function asUserChannelRow(raw: UserChannelRowRaw): UserChannelRow {
  return { ...raw, codec: coerceVoiceCodec(raw.codec) };
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

const USER_COLS = "id, username, display_name, role, unit_id, device_type, disabled, agency_id, created_at, token_generation, assigned_template_id";

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
            u.created_at, u.token_generation, u.assigned_template_id, u.password_hash,
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

/** Channel columns with the zone joined in: `zone` is the zone NAME. */
const CHANNEL_COLS = `c.id, c.name, c.sort_order, c.color, z.name AS zone, c.zone_id, z.zone_number, c.codec`;
const CHANNEL_FROM = `radio_channels c LEFT JOIN radio_zones z ON z.id = c.zone_id`;

export async function listChannels(agencyId: number): Promise<ChannelRow[]> {
  const res = await requirePool().query<ChannelRowRaw>(
    `SELECT ${CHANNEL_COLS} FROM ${CHANNEL_FROM}
     WHERE c.agency_id = $1
     ORDER BY z.zone_number ASC NULLS FIRST, c.sort_order ASC, c.id ASC;`,
    [agencyId],
  );
  return res.rows.map(asChannelRow);
}

// --- zones ---------------------------------------------------------------

export async function listZones(agencyId: number): Promise<ZoneRow[]> {
  const res = await requirePool().query<ZoneRow>(
    `SELECT id, zone_number, name FROM radio_zones WHERE agency_id = $1 ORDER BY zone_number ASC;`,
    [agencyId],
  );
  return res.rows;
}

export async function getZoneById(id: number, agencyId: number): Promise<ZoneRow | null> {
  const res = await requirePool().query<ZoneRow>(
    `SELECT id, zone_number, name FROM radio_zones WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return res.rows[0] ?? null;
}

/** Duplicate zone numbers per agency raise 23505 (mapped to 409 by the API). */
export async function createZone(agencyId: number, zoneNumber: number, name: string): Promise<ZoneRow> {
  const res = await requirePool().query<ZoneRow>(
    `INSERT INTO radio_zones (agency_id, zone_number, name)
     VALUES ($1, $2, $3) RETURNING id, zone_number, name;`,
    [agencyId, zoneNumber, name.trim()],
  );
  return res.rows[0]!;
}

export async function updateZone(
  id: number,
  agencyId: number,
  patch: { zoneNumber?: number; name?: string },
): Promise<ZoneRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.zoneNumber !== undefined) { sets.push(`zone_number = $${i++}`); vals.push(patch.zoneNumber); }
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name.trim()); }
  if (sets.length === 0) {
    return getZoneById(id, agencyId);
  }
  vals.push(id, agencyId);
  const res = await requirePool().query<ZoneRow>(
    `UPDATE radio_zones SET ${sets.join(", ")} WHERE id = $${i++} AND agency_id = $${i}
     RETURNING id, zone_number, name;`,
    vals,
  );
  return res.rows[0] ?? null;
}

/** Channels in the zone fall back to unzoned (FK ON DELETE SET NULL). */
export async function deleteZone(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_zones WHERE id = $1 AND agency_id = $2;`, [
    id,
    agencyId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export async function createChannel(agencyId: number, name: string): Promise<ChannelRow> {
  // New channels inherit the agency's default_codec. The COALESCE guards
  // against an agency row missing the column (only the legacy default
  // tenant ever lacked it after the ALTER TABLE ... ADD COLUMN IF NOT
  // EXISTS backfill, but cheap insurance).
  const res = await requirePool().query<ChannelRowRaw>(
    `INSERT INTO radio_channels (agency_id, name, sort_order, codec)
     VALUES (
       $1,
       $2,
       COALESCE((SELECT MAX(sort_order) + 1 FROM radio_channels WHERE agency_id = $1), 1),
       COALESCE((SELECT default_codec FROM agencies WHERE id = $1), 'imbe')
     )
     RETURNING id, name, sort_order, color, NULL::text AS zone, zone_id, NULL::int AS zone_number, codec;`,
    [agencyId, name.trim()],
  );
  return asChannelRow(res.rows[0]!);
}

export async function updateChannel(
  id: number,
  agencyId: number,
  patch: { name?: string; color?: string | null; zoneId?: number | null; codec?: VoiceCodec },
): Promise<ChannelRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name.trim()); }
  if (patch.color !== undefined) { sets.push(`color = $${i++}`); vals.push(patch.color); }
  if (patch.zoneId !== undefined) { sets.push(`zone_id = $${i++}`); vals.push(patch.zoneId); }
  if (patch.codec !== undefined) { sets.push(`codec = $${i++}`); vals.push(patch.codec); }
  if (sets.length === 0) {
    return getChannelById(id, agencyId);
  }
  vals.push(id, agencyId);
  const res = await requirePool().query<{ id: number }>(
    `UPDATE radio_channels SET ${sets.join(", ")} WHERE id = $${i++} AND agency_id = $${i}
     RETURNING id;`,
    vals,
  );
  // Re-select through the zone join so the returned row carries zone name/number.
  return res.rows[0] ? getChannelById(id, agencyId) : null;
}

export async function deleteChannel(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(`DELETE FROM radio_channels WHERE id = $1 AND agency_id = $2;`, [
    id,
    agencyId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Deletes a channel only when its current name is still an emergency channel.
 * This prevents a stale UI action from deleting a channel that has since been
 * renamed to a normal operational channel.
 */
export async function deleteEmergencyChannel(
  id: number,
  agencyId: number,
): Promise<
  | { status: "deleted"; name: string }
  | { status: "not_found" }
  | { status: "not_emergency"; name: string }
> {
  const p = requirePool();
  const deleted = await p.query<{ name: string }>(
    `DELETE FROM radio_channels
     WHERE id = $1
       AND agency_id = $2
       AND name ~* $3
     RETURNING name;`,
    [id, agencyId, EMERGENCY_CHANNEL_NAME_SQL_REGEX],
  );
  if ((deleted.rowCount ?? 0) > 0) {
    return { status: "deleted", name: deleted.rows[0]!.name };
  }
  const existing = await p.query<{ name: string }>(
    `SELECT name FROM radio_channels WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    return { status: "not_found" };
  }
  return { status: "not_emergency", name: existing.rows[0]!.name };
}

export async function getChannelById(id: number, agencyId: number): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRowRaw>(
    `SELECT ${CHANNEL_COLS} FROM ${CHANNEL_FROM} WHERE c.id = $1 AND c.agency_id = $2;`,
    [id, agencyId],
  );
  return res.rows[0] ? asChannelRow(res.rows[0]) : null;
}

/** Case-insensitive channel lookup within an agency (used by the voice relay on join). */
export async function getChannelByName(agencyId: number, name: string): Promise<ChannelRow | null> {
  const res = await requirePool().query<ChannelRowRaw>(
    `SELECT ${CHANNEL_COLS} FROM ${CHANNEL_FROM}
     WHERE c.agency_id = $1 AND lower(c.name) = lower($2);`,
    [agencyId, name.trim()],
  );
  return res.rows[0] ? asChannelRow(res.rows[0]) : null;
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
/** Static/hiss filtering applied to a bridge's ingest. */
export const BRIDGE_NOISE_LEVELS = ["off", "light", "strong"] as const;

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
  noise_suppression: string;
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
  noiseSuppression: string;
}

const BRIDGE_COLS =
  "id, name, source_type, source_url, device_hint, target_channel, direction, " +
  "yield_to_units, tx_mode, vox_threshold, vox_hang_ms, enabled, noise_suppression, created_at";

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
        direction, yield_to_units, tx_mode, vox_threshold, vox_hang_ms, enabled, noise_suppression)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      input.noiseSuppression,
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
  if (patch.noiseSuppression !== undefined) col("noise_suppression", patch.noiseSuppression);
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
            b.vox_threshold, b.vox_hang_ms, b.enabled, b.noise_suppression, b.created_at
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
  const res = await requirePool().query<UserChannelRowRaw>(
    `SELECT c.id, c.name, c.color, z.name AS zone, z.zone_number, c.codec, m.permission
     FROM channel_members m
     JOIN radio_channels c ON c.id = m.channel_id
     LEFT JOIN radio_zones z ON z.id = c.zone_id
     WHERE m.user_id = $1
     ORDER BY z.zone_number ASC NULLS FIRST, c.sort_order ASC, c.id ASC;`,
    [userId],
  );
  return res.rows.map(asUserChannelRow);
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

// --- user permission templates -------------------------------------------

export interface TemplateMembershipEntry {
  channel_id: number;
  permission: Permission;
}

export interface UserPermissionTemplateRow {
  id: number;
  agency_id: number;
  name: string;
  memberships: TemplateMembershipEntry[];
  created_at: string;
  updated_at: string;
}

function parseTemplateMemberships(raw: unknown): TemplateMembershipEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TemplateMembershipEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const channelId = Number((row as { channel_id?: unknown }).channel_id);
    const permission = (row as { permission?: unknown }).permission;
    if (!Number.isFinite(channelId) || !PERMISSIONS.includes(permission as Permission)) {
      continue;
    }
    out.push({ channel_id: channelId, permission: permission as Permission });
  }
  return out;
}

export async function listUserPermissionTemplates(agencyId: number): Promise<UserPermissionTemplateRow[]> {
  const res = await requirePool().query<{
    id: number;
    agency_id: number;
    name: string;
    memberships: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, agency_id, name, memberships, created_at, updated_at
     FROM user_permission_templates
     WHERE agency_id = $1
     ORDER BY name ASC;`,
    [agencyId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    agency_id: row.agency_id,
    name: row.name,
    memberships: parseTemplateMemberships(row.memberships),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

export async function getUserPermissionTemplate(
  id: number,
  agencyId: number,
): Promise<UserPermissionTemplateRow | null> {
  const res = await requirePool().query<{
    id: number;
    agency_id: number;
    name: string;
    memberships: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, agency_id, name, memberships, created_at, updated_at
     FROM user_permission_templates
     WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    agency_id: row.agency_id,
    name: row.name,
    memberships: parseTemplateMemberships(row.memberships),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function createUserPermissionTemplate(
  agencyId: number,
  name: string,
  memberships: TemplateMembershipEntry[],
): Promise<UserPermissionTemplateRow> {
  const res = await requirePool().query<{
    id: number;
    agency_id: number;
    name: string;
    memberships: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO user_permission_templates (agency_id, name, memberships)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, agency_id, name, memberships, created_at, updated_at;`,
    [agencyId, name, JSON.stringify(memberships)],
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    agency_id: row.agency_id,
    name: row.name,
    memberships: parseTemplateMemberships(row.memberships),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function updateUserPermissionTemplate(
  id: number,
  agencyId: number,
  patch: { name?: string; memberships?: TemplateMembershipEntry[] },
): Promise<UserPermissionTemplateRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(patch.name);
  }
  if (patch.memberships !== undefined) {
    sets.push(`memberships = $${i++}::jsonb`);
    vals.push(JSON.stringify(patch.memberships));
  }
  if (sets.length === 0) {
    return getUserPermissionTemplate(id, agencyId);
  }
  sets.push(`updated_at = now()`);
  vals.push(id, agencyId);
  const res = await requirePool().query<{
    id: number;
    agency_id: number;
    name: string;
    memberships: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `UPDATE user_permission_templates
     SET ${sets.join(", ")}
     WHERE id = $${i++} AND agency_id = $${i}
     RETURNING id, agency_id, name, memberships, created_at, updated_at;`,
    vals,
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  // The template's channels changed — push the new set to every user bound to it.
  if (patch.memberships !== undefined) {
    await resyncTemplateAssignedUsers(id, agencyId);
  }
  return {
    id: row.id,
    agency_id: row.agency_id,
    name: row.name,
    memberships: parseTemplateMemberships(row.memberships),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function deleteUserPermissionTemplate(id: number, agencyId: number): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM user_permission_templates WHERE id = $1 AND agency_id = $2;`,
    [id, agencyId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Full-sync a user's channel memberships to their assigned template: the user
 * ends up a member of exactly the template's still-existing channels, at the
 * template's permissions — memberships outside the template are removed. Runs
 * in a transaction so a partial failure can't leave a half-applied set. No-op
 * when the user has no template.
 */
export async function syncUserToAssignedTemplate(userId: number, agencyId: number): Promise<void> {
  const user = await getUserById(userId, agencyId);
  if (!user?.assigned_template_id) {
    return;
  }
  const template = await getUserPermissionTemplate(user.assigned_template_id, agencyId);
  if (!template) {
    return;
  }
  const valid: TemplateMembershipEntry[] = [];
  for (const entry of template.memberships) {
    if (await getChannelById(entry.channel_id, agencyId)) {
      valid.push(entry);
    }
  }
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM channel_members WHERE user_id = $1;`, [userId]);
    for (const entry of valid) {
      await client.query(
        `INSERT INTO channel_members (user_id, channel_id, permission)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = EXCLUDED.permission;`,
        [userId, entry.channel_id, entry.permission],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Bind (or unbind, with `null`) a user to a template. Binding immediately
 * full-syncs the user's memberships to the template; unbinding leaves their
 * current memberships untouched (they just stop tracking the template).
 */
export async function assignUserTemplate(
  userId: number,
  templateId: number | null,
  agencyId: number,
): Promise<UserRow | null> {
  const user = await getUserById(userId, agencyId);
  if (!user) {
    return null;
  }
  if (templateId !== null && !(await getUserPermissionTemplate(templateId, agencyId))) {
    throw new Error("not_found");
  }
  await requirePool().query(
    `UPDATE users SET assigned_template_id = $1 WHERE id = $2 AND agency_id = $3;`,
    [templateId, userId, agencyId],
  );
  if (templateId !== null) {
    await syncUserToAssignedTemplate(userId, agencyId);
  }
  return getUserById(userId, agencyId);
}

/** Re-sync every user bound to a template (after its channels/permissions change). */
export async function resyncTemplateAssignedUsers(templateId: number, agencyId: number): Promise<number> {
  const res = await requirePool().query<{ id: number }>(
    `SELECT id FROM users WHERE agency_id = $1 AND assigned_template_id = $2;`,
    [agencyId, templateId],
  );
  for (const row of res.rows) {
    await syncUserToAssignedTemplate(row.id, agencyId);
  }
  return res.rows.length;
}

/** Applies a template's channel permissions to one user (skips channels that no longer exist). */
export async function applyUserPermissionTemplate(
  templateId: number,
  userId: number,
  agencyId: number,
): Promise<{ applied: number; skipped: number }> {
  const [template, user] = await Promise.all([
    getUserPermissionTemplate(templateId, agencyId),
    getUserById(userId, agencyId),
  ]);
  if (!template || !user) {
    throw new Error("not_found");
  }
  let applied = 0;
  let skipped = 0;
  for (const entry of template.memberships) {
    const channel = await getChannelById(entry.channel_id, agencyId);
    if (!channel) {
      skipped++;
      continue;
    }
    await setMembership(userId, entry.channel_id, entry.permission);
    applied++;
  }
  return { applied, skipped };
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

/** Recent device-command acks for one unit (newest first) — backs the
 *  safeT Control "remote diagnostics" view. Reads the audit rows the voice
 *  relay writes when a handset acknowledges an admin command. */
export async function listDeviceAcks(
  agencyId: number,
  unitId: string,
  limit = 20,
): Promise<AuditRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const res = await requirePool().query<AuditRow>(
    `SELECT id, ts, actor_user_id, actor_name, action, target, detail, ip
     FROM audit_log
     WHERE agency_id = $1 AND action = 'device_command_ack' AND target LIKE $2
     ORDER BY ts DESC LIMIT $3;`,
    [agencyId, `unit:${unitId.toUpperCase()} %`, capped],
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

/**
 * Deletes transmission rows (including stored audio) older than `retentionMs`.
 * Only runs when `TRANSMISSION_RETENTION_DAYS` is set on the host — see
 * `runDataRetentionSweeps` in `dataRetention.ts`.
 */
/** Global fallback when TRANSMISSION_RETENTION_DAYS env is set. */
export async function sweepTransmissions(retentionMs: number): Promise<number> {
  const p = getPool();
  if (!p) {
    return 0;
  }
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const res = await p.query(`DELETE FROM transmissions WHERE started_at < $1;`, [cutoff]);
  return res.rowCount ?? 0;
}

/** Per-agency retention sweep for subscription tiers (3-day default, unlimited = skip). */
export async function sweepTransmissionsPerAgency(): Promise<number> {
  const p = getPool();
  if (!p) {
    return 0;
  }
  const agencies = await p.query<{ id: number; transmission_retention_days: number }>(
    `SELECT id, transmission_retention_days FROM agencies
      WHERE transmission_retention_days IS NOT NULL AND transmission_retention_days > 0;`,
  );
  let total = 0;
  for (const row of agencies.rows) {
    const cutoff = new Date(Date.now() - row.transmission_retention_days * 24 * 60 * 60 * 1000).toISOString();
    const res = await p.query(
      `DELETE FROM transmissions WHERE agency_id = $1 AND started_at < $2;`,
      [row.id, cutoff],
    );
    total += res.rowCount ?? 0;
  }
  return total;
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

export async function listPendingTranscriptionIds(limit = 200): Promise<number[]> {
  const res = await requirePool().query<{ id: number }>(
    `SELECT id FROM transmissions WHERE transcript_status = 'pending' ORDER BY started_at ASC LIMIT $1;`,
    [Math.min(Math.max(limit, 1), 5000)],
  );
  return res.rows.map((r) => r.id);
}

/**
 * Fails transmissions that have been stuck at 'pending' longer than
 * `olderThanMs`. The console renders 'pending' as a perpetual "Transcribing…",
 * so a backlog the worker can't drain (or rows orphaned by a restart before
 * the in-memory queue could reach them) would otherwise show "Transcribing…"
 * forever. Marking them 'failed' is the same terminal state the worker uses on
 * a transcription error — the recording itself is untouched and still playable.
 * Returns the number reaped (for logging).
 */
export async function reapStalePendingTranscriptions(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await requirePool().query(
    `UPDATE transmissions
        SET transcript_status = 'failed'
      WHERE transcript_status = 'pending' AND started_at < $1;`,
    [cutoff],
  );
  return res.rowCount ?? 0;
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
  /** Emergency lifecycle: 'active' | 'acknowledged' | 'resolved' (pages stay 'active'). */
  lifecycle_state: string;
  ack_by_user_id: number | null;
  ack_at: string | null;
  resolved_by_user_id: number | null;
  resolved_at: string | null;
}

const ALERT_COLS =
  "id, kind, channel_name, target_unit, from_user_id, from_name, from_unit, message, " +
  "active, created_at, cleared_by, cleared_at, " +
  "lifecycle_state, ack_by_user_id, ack_at, resolved_by_user_id, resolved_at";

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

/**
 * Auto-clears emergencies that nobody ever resolved. A handset that crashes or
 * loses power mid-emergency leaves an `active` emergency row, which then haunts
 * every radio's status line (and the dispatch board) indefinitely. Expiring rows
 * older than `olderThanMs` lets the system self-heal. Agency-agnostic and
 * idempotent — safe to run on a timer from any/all Node instances.
 */
export async function expireStaleEmergencies(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await requirePool().query(
    `UPDATE alerts
        SET active = FALSE, cleared_by = 'auto-expire', cleared_at = now()
      WHERE kind = 'emergency' AND active = TRUE AND created_at < $1;`,
    [cutoff],
  );
  return res.rowCount ?? 0;
}

/**
 * Outcome of an emergency lifecycle transition (acknowledge / resolve).
 * `not_found` and `conflict` map to HTTP 404 / 409 at the route layer.
 */
export type EmergencyTransitionOutcome =
  | { status: "ok"; alert: AlertRow }
  | { status: "not_found" }
  | { status: "conflict"; reason: EmergencyTransitionError; current: string };

/**
 * Explains why a conditional lifecycle UPDATE matched no rows: the emergency
 * either doesn't exist in this agency (404) or is in a state the transition
 * isn't legal from (409). Best-effort — the atomic UPDATE is the real guard;
 * this only shapes the error a beaten caller sees.
 */
async function classifyEmergencyMiss(
  id: number,
  agencyId: number,
  transition: EmergencyTransition,
): Promise<EmergencyTransitionOutcome> {
  const res = await requirePool().query<{ lifecycle_state: string }>(
    `SELECT lifecycle_state FROM alerts WHERE id = $1 AND agency_id = $2 AND kind = 'emergency';`,
    [id, agencyId],
  );
  const current = res.rows[0]?.lifecycle_state;
  if (current === undefined) {
    return { status: "not_found" };
  }
  const decision = isEmergencyLifecycleState(current)
    ? nextEmergencyState(current, transition)
    : ({ ok: false, reason: "invalid_state_transition" } as const);
  // If the decision says the move is legal yet the UPDATE still matched nothing,
  // another request transitioned the row between our UPDATE and this read — treat
  // it as a conflict rather than reporting success we didn't actually perform.
  const reason: EmergencyTransitionError = decision.ok
    ? "invalid_state_transition"
    : decision.reason;
  return { status: "conflict", reason, current };
}

/**
 * Acknowledge an active emergency — first acknowledger wins. The `WHERE
 * lifecycle_state = 'active'` clause makes this atomic: a concurrent second ACK
 * matches zero rows and is reported as a conflict.
 */
export async function acknowledgeEmergency(
  id: number,
  agencyId: number,
  ackByUserId: number,
): Promise<EmergencyTransitionOutcome> {
  const res = await requirePool().query<AlertRow>(
    `UPDATE alerts SET lifecycle_state = 'acknowledged', ack_by_user_id = $3, ack_at = now()
     WHERE id = $1 AND agency_id = $2 AND kind = 'emergency' AND lifecycle_state = 'active'
     RETURNING ${ALERT_COLS};`,
    [id, agencyId, ackByUserId],
  );
  const row = res.rows[0];
  if (row) {
    return { status: "ok", alert: row };
  }
  return classifyEmergencyMiss(id, agencyId, "acknowledge");
}

/**
 * Resolve an acknowledged emergency. Requires `lifecycle_state = 'acknowledged'`
 * (you cannot resolve one nobody owns, nor re-resolve a closed one), and also
 * flips the legacy `active`/`cleared_*` columns + appends a cleared marker so
 * polling radios learn the emergency ended — same as a manual clear.
 */
export async function resolveEmergency(
  id: number,
  agencyId: number,
  resolvedByUserId: number,
  resolvedByName: string,
): Promise<EmergencyTransitionOutcome> {
  const res = await requirePool().query<AlertRow>(
    `UPDATE alerts SET lifecycle_state = 'resolved', resolved_by_user_id = $3,
       resolved_at = now(), active = FALSE, cleared_by = $4, cleared_at = now()
     WHERE id = $1 AND agency_id = $2 AND kind = 'emergency' AND lifecycle_state = 'acknowledged'
     RETURNING ${ALERT_COLS};`,
    [id, agencyId, resolvedByUserId, resolvedByName],
  );
  const row = res.rows[0];
  if (row) {
    if (row.from_unit) {
      await appendEmergencyClearedMarker(agencyId, row.from_unit, resolvedByName);
    }
    return { status: "ok", alert: row };
  }
  return classifyEmergencyMiss(id, agencyId, "resolve");
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

// ---------------------------------------------------------------------------
// Global audio config — agency-wide setting applied to all RX pipelines
// ---------------------------------------------------------------------------

export interface GlobalAudioConfigRow {
  config: unknown;
  updated_at: string;
  updated_by_username: string | null;
}

/**
 * Returns the stored global audio config for an agency, or null if none has
 * been pushed yet.
 */
export async function getGlobalAudioConfig(agencyId: number): Promise<GlobalAudioConfigRow | null> {
  const res = await requirePool().query<GlobalAudioConfigRow>(
    `SELECT config, updated_at, updated_by_username
       FROM global_audio_config
      WHERE agency_id = $1;`,
    [agencyId],
  );
  return res.rows[0] ?? null;
}

/**
 * Upserts the global audio config for an agency.  `config` is an opaque JSON
 * object — the shape is validated by the admin UI (AudioLabPanel) before it
 * reaches here.
 */
export async function setGlobalAudioConfig(
  agencyId: number,
  config: unknown,
  userId: number,
  username: string,
): Promise<GlobalAudioConfigRow> {
  const res = await requirePool().query<GlobalAudioConfigRow>(
    `INSERT INTO global_audio_config (agency_id, config, updated_at, updated_by_user_id, updated_by_username)
       VALUES ($1, $2::jsonb, now(), $3, $4)
     ON CONFLICT (agency_id) DO UPDATE
       SET config = EXCLUDED.config,
           updated_at = EXCLUDED.updated_at,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_by_username = EXCLUDED.updated_by_username
     RETURNING config, updated_at, updated_by_username;`,
    [agencyId, JSON.stringify(config), userId, username],
  );
  return res.rows[0]!;
}

// ---------------------------------------------------------------------------
// Audio Lab presets — per-agency named snapshots of an AudioLabConfig.
// Loading a preset writes the body back through `setGlobalAudioConfig` so the
// existing live-apply path stays the single source of truth.
// ---------------------------------------------------------------------------

export interface AudioLabPresetRow {
  name: string;
  config: unknown;
  updated_at: string;
}

export interface AudioLabPresetSummaryRow {
  name: string;
  config: unknown;
  updated_at: string;
}

/** Lists every preset for an agency, newest-touched first. The config body
 *  IS returned so the route can compute a one-line summary in a single
 *  query (instead of issuing N follow-up reads). Callers that need only the
 *  metadata can ignore `config`. */
export async function listAudioLabPresets(
  agencyId: number,
): Promise<AudioLabPresetSummaryRow[]> {
  const res = await requirePool().query<AudioLabPresetSummaryRow>(
    `SELECT name, config, updated_at
       FROM audio_lab_presets
      WHERE agency_id = $1
      ORDER BY updated_at DESC;`,
    [agencyId],
  );
  return res.rows;
}

/** Returns the full preset for the given (agency, case-insensitive name). */
export async function getAudioLabPreset(
  agencyId: number,
  name: string,
): Promise<AudioLabPresetRow | null> {
  const res = await requirePool().query<AudioLabPresetRow>(
    `SELECT name, config, updated_at
       FROM audio_lab_presets
      WHERE agency_id = $1 AND lower(name) = lower($2);`,
    [agencyId, name],
  );
  return res.rows[0] ?? null;
}

/** Upserts a preset for an agency. Case-insensitive on name (matches the
 *  underlying unique index). Returns the freshly-stored row. */
export async function upsertAudioLabPreset(
  agencyId: number,
  name: string,
  config: unknown,
): Promise<AudioLabPresetRow> {
  const res = await requirePool().query<AudioLabPresetRow>(
    `INSERT INTO audio_lab_presets (agency_id, name, config, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (agency_id, lower(name)) DO UPDATE
       SET name = EXCLUDED.name,
           config = EXCLUDED.config,
           updated_at = now()
     RETURNING name, config, updated_at;`,
    [agencyId, name, JSON.stringify(config)],
  );
  return res.rows[0]!;
}

/** Removes a preset by case-insensitive name. Returns true when a row was
 *  actually deleted, false when no such preset existed. */
export async function deleteAudioLabPreset(
  agencyId: number,
  name: string,
): Promise<boolean> {
  const res = await requirePool().query(
    `DELETE FROM audio_lab_presets
      WHERE agency_id = $1 AND lower(name) = lower($2);`,
    [agencyId, name],
  );
  return (res.rowCount ?? 0) > 0;
}
