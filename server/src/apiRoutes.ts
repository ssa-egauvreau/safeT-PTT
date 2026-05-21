import { Router, raw } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  requireAdmin,
  requireAuth,
  requireOwner,
  signToken,
  verifyPassword,
  type AuthUser,
  type Role,
} from "./auth.js";
import {
  dropAgencyVoiceConnections,
  dropUserVoiceConnections,
  listAgencyRosters,
  listChannelRoster,
  peekVoiceTransmittingUnit,
  sendMoveCommand,
  type PresenceStatus,
  type RosterMember,
} from "./voiceRelay.js";
import { getBridgeStatus } from "./bridgeWorker.js";
import {
  AGENCY_ROLES,
  bumpTokenGeneration,
  countActiveAdmins,
  clearAlert,
  clearEmergenciesFromUnit,
  createAgencyWithAdmin,
  createAlert,
  createChannel,
  createUser,
  deleteAgency,
  deleteChannel,
  deleteUnitAlias,
  deleteUser,
  generateRadioKey,
  getAgencyById,
  getAgencyBySlug,
  getChannelById,
  getChannelByName,
  getSimulcastByName,
  createSimulcast,
  deleteSimulcast,
  listSimulcasts,
  updateSimulcast,
  BRIDGE_SOURCE_TYPES,
  BRIDGE_DIRECTIONS,
  BRIDGE_TX_MODES,
  createBridge,
  deleteBridge,
  getBridgeById,
  listBridges,
  updateBridge,
  type BridgeInput,
  getTransmissionAudio,
  getUserById,
  getUserByUsername,
  listAgencies,
  listAlerts,
  listAudit,
  listChannels,
  listChannelsForUser,
  listInboxAlerts,
  listTen33Channels,
  getChannelTen33Active,
  setChannelAiDispatch,
  listChannelAiDispatchEnabled,
  getChannelAiDispatchRow,
  getAgencyIntegrationValue,
  listMemberships,
  listPositions,
  listPositionHistory,
  listGeofences,
  createGeofence,
  deleteGeofence,
  listTransmissions,
  listUnitAliases,
  listUsers,
  PERMISSIONS,
  deleteAgencyLogo,
  deleteAgencySound,
  getAgencyLogo,
  getAgencySound,
  getAgencySoundsVersion,
  isDeviceType,
  isSoundKind,
  listAgencySounds,
  TONE_OUT_PLAY_MODES,
  listToneOuts,
  createToneOut,
  updateToneOut,
  setToneOutAudio,
  setToneOutIcon,
  clearToneOutIcon,
  getToneOutAudio,
  getToneOutIcon,
  deleteToneOut,
  resolveAgencyByKey,
  setAgencyLogo,
  setAgencySound,
  removeMembership,
  setMembership,
  setUnitAlias,
  uniqueAgencySlug,
  updateAgency,
  updateChannel,
  updateUser,
  upsertPosition,
  writeAudit,
  type Permission,
  type TransmissionSort,
} from "./store.js";
import { getPool } from "./db.js";
import { getCachedAuth, invalidateCachedAuth, setCachedAuth } from "./sessionCache.js";
import {
  handleIntegrationHealth,
  handleListIntegrations,
  handleSetIntegration,
} from "./integrations/adminApi.js";
import { getAiDispatchLoopbackPort } from "./aiDispatch/engine.js";
import {
  agencyPromptSource,
  getAiDispatchPlatformConfig,
  getAiDispatchPlatformStatus,
} from "./aiDispatch/platformConfig.js";
import { applyChannelTen33Marker } from "./aiDispatch/ten33Marker.js";
import { listAiDispatchLog } from "./aiDispatch/activityLog.js";
import { handleTen8Webhook, handleTen8WebhookGet } from "./ten8/webhook.js";
import { handleAndroidUpdateApk, handleAndroidUpdateManifest } from "./appUpdate.js";
import { listTen8ActiveIncidents, listTen8WebhookLog } from "./ten8/store.js";

/** Legacy global radio key — lets a handset fetch its agency's custom tones. */
const radioApiKey = process.env.RADIO_API_KEY?.trim();

/** Upper bound for an uploaded tone (short clips; keeps a clip well under this). */
const SOUND_MAX_BYTES = "1mb";

/** Upper bound for an uploaded agency logo. */
const LOGO_MAX_BYTES = "512kb";

/** Upper bound for an uploaded soundboard tone-out clip. */
const TONE_OUT_AUDIO_MAX = "4mb";

/** Reads a device-category value from request input, or null when absent/invalid. */
function asDeviceType(value: unknown): string | null {
  return isDeviceType(value) ? value : null;
}

/**
 * Agency id for a sound request — from a console JWT, else the handset radio
 * key (header or `?key=`). Returns null when neither resolves an agency.
 */
async function resolveSoundAgencyId(req: Request): Promise<number | null> {
  if (req.authUser?.agencyId != null) {
    return req.authUser.agencyId;
  }
  const headerRaw = req.headers["x-radio-key"];
  const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const key = headerVal ?? (typeof req.query.key === "string" ? req.query.key : null);
  const agency = await resolveAgencyByKey(key ?? null, radioApiKey).catch(() => null);
  return agency?.id ?? null;
}

/** Picks `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Clamps request input to a numeric range, falling back when it is not a number. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "").trim();
}

function fail(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "database_unavailable") {
    res.status(503).json({ error: "database_unavailable" });
    return;
  }
  if ((error as { code?: string } | null)?.code === "23505") {
    res.status(409).json({ error: "duplicate" });
    return;
  }
  console.error("API error", error);
  res.status(500).json({ error: "server_error" });
}

/** Only roles an agency may contain — never the platform `owner`. */
function asAgencyRole(value: unknown): Role | null {
  return AGENCY_ROLES.includes(value as Role) ? (value as Role) : null;
}

function asPermission(value: unknown): Permission | null {
  return PERMISSIONS.includes(value as Permission) ? (value as Permission) : null;
}

/** Requires a signed-in account that belongs to an agency (blocks platform owners). */
function requireAgencyMember(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.authUser.agencyId == null) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/** Agency a key-authenticated handset request belongs to (0 only in DB-less local dev). */
function radioAgencyId(req: Request): number {
  return req.agency?.id ?? 0;
}

/** ISO-8601 UTC for handset clients (pg may return Date or string). */
function formatTransmissionStartedAt(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return new Date().toISOString();
}

/** Requires a signed-in admin or dispatcher within an agency (command-level operators). */
function requireAgencyOperator(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (
    req.authUser.agencyId == null ||
    (req.authUser.role !== "admin" && req.authUser.role !== "dispatcher")
  ) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/** GPS speed (m/s) above which a moving unit is treated as "driving" (~11 km/h). */
const DRIVING_SPEED_MPS = 3;
/** Ignore GPS fixes older than this when deriving "driving" — stale speed lies. */
const POSITION_FRESH_MS = 3 * 60_000;

/**
 * Attaches an auto-derived activity status to each roster member from live
 * signals only: an active emergency from the unit, the current channel talker,
 * or recent GPS speed. Everything else is "idle" (connected but quiet). No
 * manual input and no extra device telemetry is involved.
 */
async function annotateRosterStatus(
  agencyId: number,
  channel: string,
  members: RosterMember[],
): Promise<RosterMember[]> {
  if (members.length === 0) {
    return members;
  }
  const talker = peekVoiceTransmittingUnit(agencyId, channel);
  const [positions, alerts] = await Promise.all([
    listPositions(agencyId),
    listAlerts(agencyId, 200),
  ]);
  const now = Date.now();
  // listPositions is ordered newest-first, so the first row per unit is its latest fix.
  const latestSpeed = new Map<string, { speed: number; ageMs: number }>();
  for (const p of positions) {
    const unit = p.unit_id.toUpperCase();
    if (!latestSpeed.has(unit)) {
      latestSpeed.set(unit, { speed: p.speed_mps ?? 0, ageMs: now - Date.parse(p.updated_at) });
    }
  }
  const emergencyUnits = new Set<string>();
  for (const a of alerts) {
    if (a.kind === "emergency" && a.active && a.from_unit) {
      emergencyUnits.add(a.from_unit.toUpperCase());
    }
  }
  const talkerUnit = talker ? talker.toUpperCase() : null;
  return members.map((m) => {
    const unit = m.unit_id.toUpperCase();
    const fix = latestSpeed.get(unit);
    let status: PresenceStatus = "idle";
    if (emergencyUnits.has(unit)) {
      status = "emergency";
    } else if (talkerUnit && unit === talkerUnit) {
      status = "transmitting";
    } else if (fix && fix.ageMs <= POSITION_FRESH_MS && fix.speed >= DRIVING_SPEED_MPS) {
      status = "driving";
    }
    return { ...m, status };
  });
}

/** Router for account/auth, admin, owner, and radio endpoints, mounted at `/v1`. */
export function createApiRouter(): Router {
  const router = Router();

  router.get("/webhooks/10-8", handleTen8WebhookGet);
  router.post("/webhooks/10-8", handleTen8Webhook);

  // Public, unauthenticated: the sideloaded Android fleet polls these to self-update.
  router.get("/app/android/version", handleAndroidUpdateManifest);
  router.get("/app/android/apk", handleAndroidUpdateApk);

  // Reject API calls from an account whose agency was disabled (or deleted)
  // after its token was issued, or whose own account row has been disabled or
  // removed on the portal. The JWT stays cryptographically valid until it
  // expires, so this DB check is what actually locks a disabled radio out.
  router.use(async (req, res, next) => {
    try {
      const auth = req.authUser;
      if (auth == null) {
        next();
        return;
      }
      // Fast path: a 15 s in-process cache (sessionCache.ts) lets us skip the user/agency
      // lookups on the hot Android polling path. Login invalidates the cache explicitly so
      // "newest sign-in wins" still takes effect on the next request from the old device;
      // admin-driven disables propagate within TTL.
      const cached = getCachedAuth(auth.id);
      if (cached) {
        if (cached.userDisabled) {
          res.status(401).json({ error: "account_disabled" });
          return;
        }
        if (auth.gen !== cached.tokenGeneration) {
          res.status(401).json({ error: "session_superseded" });
          return;
        }
        if (cached.agencyDisabled) {
          res.status(403).json({ error: "agency_disabled" });
          return;
        }
        next();
        return;
      }
      const user = await getUserById(auth.id);
      if (!user || user.disabled) {
        res.status(401).json({ error: "account_disabled" });
        return;
      }
      // Newest sign-in wins. A token whose `gen` lags the user row was issued
      // for an earlier session that a later login has since superseded.
      if (auth.gen !== user.token_generation) {
        res.status(401).json({ error: "session_superseded" });
        return;
      }
      let agencyDisabled = false;
      if (auth.agencyId != null) {
        const agency = await getAgencyById(auth.agencyId);
        if (!agency || agency.disabled) {
          agencyDisabled = true;
          setCachedAuth(auth.id, {
            tokenGeneration: user.token_generation,
            userDisabled: false,
            agencyDisabled: true,
          });
          res.status(403).json({ error: "agency_disabled" });
          return;
        }
      }
      setCachedAuth(auth.id, {
        tokenGeneration: user.token_generation,
        userDisabled: false,
        agencyDisabled,
      });
      next();
    } catch (error) {
      fail(res, error);
    }
  });

  // --- authentication ----------------------------------------------------

  router.post("/auth/login", async (req, res) => {
    try {
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");
      const agencySlugRaw = String(req.body?.agency_slug ?? "").trim().toLowerCase();
      if (!username || !password) {
        res.status(400).json({ error: "missing_credentials" });
        return;
      }
      const user = await getUserByUsername(username);
      const blocked = !user || user.disabled || user.agency_disabled === true;
      if (blocked || !(await verifyPassword(password, user!.password_hash))) {
        await writeAudit({
          agencyId: user?.agency_id ?? null,
          actorUserId: user?.id ?? null,
          actorName: username,
          action: "login_failed",
          ip: clientIp(req),
        });
        res.status(401).json({ error: "invalid_login" });
        return;
      }
      if (agencySlugRaw && user!.role !== "owner") {
        const agency = await getAgencyBySlug(agencySlugRaw);
        if (!agency || agency.disabled) {
          res.status(401).json({ error: "unknown_agency" });
          return;
        }
        if (user!.agency_id !== agency.id) {
          await writeAudit({
            agencyId: user?.agency_id ?? null,
            actorUserId: user?.id ?? null,
            actorName: username,
            action: "login_failed",
            ip: clientIp(req),
          });
          res.status(401).json({ error: "agency_mismatch" });
          return;
        }
      }
      // Mint a fresh session generation so any token still floating around for
      // this account immediately fails the freshness check on its next call.
      const newGen = getPool() ? await bumpTokenGeneration(user!.id) : 0;
      // Drop the cached "auth is fine" entry for this user so the next request from any prior
      // device sees the new token_generation and gets a 401 immediately, instead of waiting
      // up to TTL for the cache to expire.
      invalidateCachedAuth(user!.id);
      const evictedSockets = dropUserVoiceConnections(user!.id);
      const authUser: AuthUser = {
        id: user!.id,
        username: user!.username,
        displayName: user!.display_name,
        role: user!.role,
        unitId: user!.unit_id,
        agencyId: user!.agency_id,
        agencyName: user!.agency_name,
        gen: newGen,
      };
      await writeAudit({
        agencyId: user!.agency_id,
        actorUserId: user!.id,
        actorName: user!.username,
        action: "login",
        ip: clientIp(req),
      });
      if (evictedSockets > 0) {
        await writeAudit({
          agencyId: user!.agency_id,
          actorUserId: user!.id,
          actorName: user!.username,
          action: "session_evicted",
          detail: { dropped_voice_sockets: evictedSockets, new_ip: clientIp(req) },
          ip: clientIp(req),
        });
      }
      res.json({ token: signToken(authUser), user: authUser });
    } catch (error) {
      fail(res, error);
    }
  });

  // Live profile read for handsets — they poll this so display-name / unit-id
  // edits made on the portal land on the radios without waiting for a restart.
  // The auth middleware above already rejects disabled accounts.
  router.get("/auth/me", requireAuth, async (req, res) => {
    try {
      const me = req.authUser!;
      const row = await getUserById(me.id);
      if (!row) {
        res.status(401).json({ error: "account_disabled" });
        return;
      }
      res.json({
        user: {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role,
          unitId: row.unit_id,
          agencyId: row.agency_id,
          agencyName: me.agencyName,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- channels the caller may use (console + radios) --------------------

  router.get("/me/channels", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      if (me.role === "admin" || me.role === "dispatcher") {
        const all = await listChannels(me.agencyId!);
        const sims = await listSimulcasts(me.agencyId!);
        const aiEnabled = new Set(await listChannelAiDispatchEnabled(me.agencyId!));
        res.json({
          channels: [
            ...all.map((c) => ({
              id: c.id,
              name: c.name,
              color: c.color,
              zone: c.zone,
              permission: "talk_priority",
              simulcast: false,
              ai_dispatch_enabled: aiEnabled.has(c.name),
            })),
            // Simulcast channels carry a negative id so they never collide with
            // a real channel id in the console's open-channel set.
            ...sims.map((s) => ({
              id: -s.id,
              name: s.name,
              color: null,
              zone: "Simulcast",
              permission: "talk_priority",
              simulcast: true,
            })),
          ],
        });
        return;
      }
      res.json({ channels: await listChannelsForUser(me.id) });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- owner: agencies (platform tenants) --------------------------------

  router.get("/owner/agencies", requireOwner, async (_req, res) => {
    try {
      res.json({ agencies: await listAgencies() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/owner/agencies", requireOwner, async (req, res) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      const adminUsername = String(req.body?.adminUsername ?? "").trim();
      const adminPassword = String(req.body?.adminPassword ?? "");
      const adminDisplayName = String(req.body?.adminDisplayName ?? "").trim() || adminUsername;
      if (!name || !adminUsername || !adminPassword) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      if (await getUserByUsername(adminUsername)) {
        res.status(409).json({ error: "username_taken" });
        return;
      }
      // Agency, its starter channels and its first admin are created atomically.
      const { agency, admin } = await createAgencyWithAdmin({
        name,
        slug: await uniqueAgencySlug(name),
        radioKey: generateRadioKey(),
        adminUsername,
        adminDisplayName,
        adminPassword,
      });
      await writeAudit({
        agencyId: agency.id,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "agency_create",
        target: agency.name,
        detail: { slug: agency.slug, admin: adminUsername },
        ip: clientIp(req),
      });
      res.status(201).json({ agency, admin });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/owner/agencies/:id", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getAgencyById(id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch: { name?: string; disabled?: boolean; radioKey?: string } = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        patch.name = name;
      }
      if (req.body?.disabled !== undefined) {
        patch.disabled = Boolean(req.body.disabled);
      }
      if (req.body?.regenerateRadioKey === true) {
        patch.radioKey = generateRadioKey();
      }
      const agency = await updateAgency(id, patch);
      // Disabling the agency or rotating its radio key revokes access — drop any
      // live voice sockets so they cannot outlast the change.
      if (patch.disabled === true || patch.radioKey !== undefined) {
        dropAgencyVoiceConnections(id);
      }
      await writeAudit({
        agencyId: id,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "agency_update",
        target: existing.name,
        detail: { fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ agency });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/owner/agencies/:id", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getAgencyById(id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await deleteAgency(id);
      dropAgencyVoiceConnections(id);
      // Audit row carries no agency id — the agency (and its audit rows) are gone.
      await writeAudit({
        agencyId: null,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "agency_delete",
        target: existing.name,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/owner/agencies/:id/users", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const agency = await getAgencyById(id);
      if (!agency) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ users: await listUsers(id) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/owner/agencies/:id/users", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const agency = await getAgencyById(id);
      if (!agency) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const username = String(req.body?.username ?? "").trim();
      const displayName = String(req.body?.displayName ?? "").trim() || username;
      const password = String(req.body?.password ?? "");
      const role = asAgencyRole(req.body?.role) ?? "radio";
      const unitId = req.body?.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      const deviceType = asDeviceType(req.body?.deviceType);
      if (!username || !password) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      if (await getUserByUsername(username)) {
        res.status(409).json({ error: "username_taken" });
        return;
      }
      const user = await createUser({ username, displayName, password, role, unitId, agencyId: id, deviceType });
      await writeAudit({
        agencyId: id,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_create",
        target: username,
        detail: { role, unitId, byOwner: true },
        ip: clientIp(req),
      });
      res.status(201).json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/owner/agencies/:id/users/:uid", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const uid = Number(req.params.uid);
      const existing = await getUserById(uid, id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch: {
        displayName?: string;
        role?: Role;
        unitId?: string | null;
        deviceType?: string | null;
        disabled?: boolean;
        password?: string;
      } = {};
      if (req.body?.displayName !== undefined) patch.displayName = String(req.body.displayName);
      if (req.body?.role !== undefined) {
        const role = asAgencyRole(req.body.role);
        if (!role) {
          res.status(400).json({ error: "bad_role" });
          return;
        }
        patch.role = role;
      }
      if (req.body?.unitId !== undefined) {
        patch.unitId = req.body.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      }
      if (req.body?.deviceType !== undefined) {
        patch.deviceType = asDeviceType(req.body.deviceType);
      }
      if (req.body?.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
      if (req.body?.password) patch.password = String(req.body.password);

      const demotesAdmin = existing.role === "admin" && patch.role !== undefined && patch.role !== "admin";
      const disablesAdmin = existing.role === "admin" && patch.disabled === true;
      if ((demotesAdmin || disablesAdmin) && (await countActiveAdmins(id)) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }

      const user = await updateUser(uid, patch);
      await writeAudit({
        agencyId: id,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_update",
        target: existing.username,
        detail: { fields: Object.keys(patch), byOwner: true },
        ip: clientIp(req),
      });
      res.json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/owner/agencies/:id/users/:uid", requireOwner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const uid = Number(req.params.uid);
      const existing = await getUserById(uid, id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (existing.role === "admin" && (await countActiveAdmins(id)) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
      await deleteUser(uid);
      await writeAudit({
        agencyId: id,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_delete",
        target: existing.username,
        detail: { byOwner: true },
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: accounts ---------------------------------------------------

  router.get("/admin/users", requireAdmin, async (req, res) => {
    try {
      res.json({ users: await listUsers(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/users", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const username = String(req.body?.username ?? "").trim();
      const displayName = String(req.body?.displayName ?? "").trim() || username;
      const password = String(req.body?.password ?? "");
      const role = asAgencyRole(req.body?.role) ?? "radio";
      const unitId = req.body?.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      const deviceType = asDeviceType(req.body?.deviceType);
      if (!username || !password) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      if (await getUserByUsername(username)) {
        res.status(409).json({ error: "username_taken" });
        return;
      }
      const user = await createUser({ username, displayName, password, role, unitId, agencyId, deviceType });
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_create",
        target: username,
        detail: { role, unitId },
        ip: clientIp(req),
      });
      res.status(201).json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const existing = await getUserById(id, agencyId);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch: {
        displayName?: string;
        role?: Role;
        unitId?: string | null;
        deviceType?: string | null;
        disabled?: boolean;
        password?: string;
      } = {};
      if (req.body?.displayName !== undefined) patch.displayName = String(req.body.displayName);
      if (req.body?.role !== undefined) {
        const role = asAgencyRole(req.body.role);
        if (!role) {
          res.status(400).json({ error: "bad_role" });
          return;
        }
        patch.role = role;
      }
      if (req.body?.unitId !== undefined) {
        patch.unitId = req.body.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      }
      if (req.body?.deviceType !== undefined) {
        patch.deviceType = asDeviceType(req.body.deviceType);
      }
      if (req.body?.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
      if (req.body?.password) patch.password = String(req.body.password);

      const demotesAdmin = existing.role === "admin" && patch.role !== undefined && patch.role !== "admin";
      const disablesAdmin = existing.role === "admin" && patch.disabled === true;
      if ((demotesAdmin || disablesAdmin) && (await countActiveAdmins(agencyId)) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }

      const user = await updateUser(id, patch);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_update",
        target: existing.username,
        detail: { fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const existing = await getUserById(id, agencyId);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (existing.id === req.authUser!.id) {
        res.status(409).json({ error: "cannot_delete_self" });
        return;
      }
      if (existing.role === "admin" && (await countActiveAdmins(agencyId)) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
      await deleteUser(id);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_delete",
        target: existing.username,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: channels ---------------------------------------------------

  router.get("/admin/channels", requireAdmin, async (req, res) => {
    try {
      res.json({ channels: await listChannels(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/channels", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      // A channel name must not collide with a simulcast channel (relay resolves by name).
      if (await getSimulcastByName(agencyId, name)) {
        res.status(409).json({ error: "duplicate" });
        return;
      }
      const channel = await createChannel(agencyId, name);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_create",
        target: name,
        ip: clientIp(req),
      });
      res.status(201).json({ channel });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/channels/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const patch: { name?: string; color?: string | null; zone?: string | null } = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        // A channel name must not collide with a simulcast (relay resolves by name).
        if (await getSimulcastByName(agencyId, name)) {
          res.status(409).json({ error: "duplicate" });
          return;
        }
        patch.name = name;
      }
      if (req.body?.color !== undefined) {
        patch.color = req.body.color ? String(req.body.color) : null;
      }
      if (req.body?.zone !== undefined) {
        patch.zone = req.body.zone ? String(req.body.zone).trim() : null;
      }
      const channel = await updateChannel(id, agencyId, patch);
      if (!channel) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_update",
        target: channel.name,
        detail: { id, fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ channel });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/channels/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const ok = await deleteChannel(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_delete",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- simulcast channels (admin + dispatcher) ---------------------------

  router.get("/simulcast", requireAgencyOperator, async (req, res) => {
    try {
      res.json({ simulcasts: await listSimulcasts(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/simulcast", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const name = String(req.body?.name ?? "").trim();
      const channelIds = Array.isArray(req.body?.channelIds)
        ? (req.body.channelIds as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : [];
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      // The relay resolves channels by name — a simulcast must not shadow a real one.
      if (await getChannelByName(agencyId, name)) {
        res.status(409).json({ error: "duplicate" });
        return;
      }
      const simulcast = await createSimulcast(agencyId, name, channelIds);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "simulcast_create",
        target: name,
        detail: { channels: channelIds.length },
        ip: clientIp(req),
      });
      res.status(201).json({ simulcast });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put("/simulcast/:id", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const patch: { name?: string; channelIds?: number[] } = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        if (await getChannelByName(agencyId, name)) {
          res.status(409).json({ error: "duplicate" });
          return;
        }
        patch.name = name;
      }
      if (Array.isArray(req.body?.channelIds)) {
        patch.channelIds = (req.body.channelIds as unknown[])
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n));
      }
      const ok = await updateSimulcast(id, agencyId, patch);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "simulcast_update",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/simulcast/:id", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const ok = await deleteSimulcast(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "simulcast_delete",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- radio bridges (admin) ---------------------------------------------

  router.get("/admin/bridges", requireAdmin, async (req, res) => {
    try {
      res.json({ bridges: await listBridges(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Live ingest level + gate state per stream bridge — drives the audio meter.
  router.get("/admin/bridges/status", requireAdmin, async (req, res) => {
    try {
      const bridges = await listBridges(req.authUser!.agencyId!);
      res.json({
        statuses: bridges.map((bridge) => ({ id: bridge.id, ...getBridgeStatus(bridge.id) })),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/bridges", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      const targetChannel = String(body.targetChannel ?? "").trim();
      if (!name || !targetChannel) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const sourceType = oneOf(body.sourceType, BRIDGE_SOURCE_TYPES, "stream_url");
      // A stream URL is a listen-only feed; only an audio device can be bidirectional.
      const direction =
        sourceType === "stream_url"
          ? "inbound"
          : oneOf(body.direction, BRIDGE_DIRECTIONS, "inbound");
      const input: BridgeInput = {
        name,
        sourceType,
        sourceUrl: body.sourceUrl ? String(body.sourceUrl).trim() : null,
        deviceHint: body.deviceHint ? String(body.deviceHint).trim() : null,
        targetChannel,
        direction,
        yieldToUnits:
          body.yieldToUnits === undefined ? direction !== "bidirectional" : Boolean(body.yieldToUnits),
        txMode: oneOf(body.txMode, BRIDGE_TX_MODES, "passthrough"),
        voxThreshold: clampNumber(body.voxThreshold, 0, 1, 0.02),
        voxHangMs: Math.round(clampNumber(body.voxHangMs, 100, 10000, 1500)),
        enabled: Boolean(body.enabled),
      };
      // An enabled stream bridge with no URL has nothing to ingest — the worker
      // would skip it, leaving it "enabled" in the UI but never keying anything.
      if (input.sourceType === "stream_url" && input.enabled && !input.sourceUrl) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const bridge = await createBridge(agencyId, input);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "bridge_create",
        target: name,
        detail: { sourceType: input.sourceType, targetChannel },
        ip: clientIp(req),
      });
      res.status(201).json({ bridge });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/bridges/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Partial<BridgeInput> = {};
      // A bridge needs a stable label and a routable target — reject blanks
      // rather than letting updateBridge trim them to empty strings.
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_fields" });
          return;
        }
        patch.name = name;
      }
      if (body.targetChannel !== undefined) {
        const targetChannel = String(body.targetChannel).trim();
        if (!targetChannel) {
          res.status(400).json({ error: "missing_fields" });
          return;
        }
        patch.targetChannel = targetChannel;
      }
      if (body.sourceType !== undefined) patch.sourceType = oneOf(body.sourceType, BRIDGE_SOURCE_TYPES, "stream_url");
      if (body.sourceUrl !== undefined) patch.sourceUrl = body.sourceUrl ? String(body.sourceUrl).trim() : null;
      if (body.deviceHint !== undefined) patch.deviceHint = body.deviceHint ? String(body.deviceHint).trim() : null;
      if (body.direction !== undefined) patch.direction = oneOf(body.direction, BRIDGE_DIRECTIONS, "inbound");
      if (body.yieldToUnits !== undefined) patch.yieldToUnits = Boolean(body.yieldToUnits);
      if (body.txMode !== undefined) patch.txMode = oneOf(body.txMode, BRIDGE_TX_MODES, "passthrough");
      if (body.voxThreshold !== undefined) patch.voxThreshold = clampNumber(body.voxThreshold, 0, 1, 0.02);
      if (body.voxHangMs !== undefined) patch.voxHangMs = Math.round(clampNumber(body.voxHangMs, 100, 10000, 1500));
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      const current = await getBridgeById(id, agencyId);
      if (!current) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Reject any patch that would leave an enabled stream bridge with no URL.
      const effSourceType = patch.sourceType ?? current.source_type;
      const effSourceUrl = patch.sourceUrl !== undefined ? patch.sourceUrl : current.source_url;
      const effEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
      if (effSourceType === "stream_url" && effEnabled && !effSourceUrl) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const bridge = await updateBridge(id, agencyId, patch);
      if (!bridge) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "bridge_update",
        target: bridge.name,
        detail: { fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ bridge });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/bridges/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const ok = await deleteBridge(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "bridge_delete",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Audio-device bridges this agency can run from the desktop console. Unlike
   * the admin CRUD above, any agency member may read this — the bridge host
   * operator is not necessarily an admin.
   */
  router.get("/bridges/runnable", requireAgencyMember, async (req, res) => {
    try {
      const bridges = await listBridges(req.authUser!.agencyId!);
      res.json({ bridges: bridges.filter((b) => b.enabled && b.source_type === "audio_device") });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- unit aliases (friendly labels for radio unit IDs) -----------------

  router.get("/unit-aliases", requireAgencyMember, async (req, res) => {
    try {
      res.json({ aliases: await listUnitAliases(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put("/admin/unit-aliases", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const unitId = String(req.body?.unitId ?? "").trim();
      const label = String(req.body?.label ?? "").trim();
      if (!unitId || !label) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const alias = await setUnitAlias(agencyId, unitId, label);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "unit_alias_set",
        target: unitId,
        detail: { label },
        ip: clientIp(req),
      });
      res.json({ alias });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/unit-aliases/:unitId", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const unitId = String(req.params.unitId ?? "").trim();
      const ok = await deleteUnitAlias(agencyId, unitId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "unit_alias_delete",
        target: unitId,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- agency integrations (API keys, webhooks — per tenant) ---------------

  router.get("/admin/integrations", requireAdmin, async (req, res) => {
    try {
      await handleListIntegrations(req, res);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/admin/integrations/health", requireAdmin, async (req, res) => {
    try {
      await handleIntegrationHealth(req, res);
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/integrations/:key", requireAdmin, async (req, res) => {
    try {
      await handleSetIntegration(req, res);
    } catch (error) {
      fail(res, error);
    }
  });

  // --- agency sounds (custom radio tones) --------------------------------

  router.get("/admin/sounds", requireAdmin, async (req, res) => {
    try {
      res.json({ sounds: await listAgencySounds(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put(
    "/admin/sounds/:kind",
    requireAdmin,
    raw({ type: () => true, limit: SOUND_MAX_BYTES }),
    async (req, res) => {
      try {
        const kind = String(req.params.kind);
        if (!isSoundKind(kind)) {
          res.status(404).json({ error: "unknown_sound" });
          return;
        }
        const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!mime.startsWith("audio/") && mime !== "application/octet-stream") {
          res.status(415).json({ error: "bad_audio_type" });
          return;
        }
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "missing_audio" });
          return;
        }
        const agencyId = req.authUser!.agencyId!;
        await setAgencySound(agencyId, kind, body, mime);
        await writeAudit({
          agencyId,
          actorUserId: req.authUser!.id,
          actorName: req.authUser!.username,
          action: "sound_set",
          target: kind,
          detail: { mime, bytes: body.length },
          ip: clientIp(req),
        });
        res.json({ ok: true, kind, mime, byte_size: body.length });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.delete("/admin/sounds/:kind", requireAdmin, async (req, res) => {
    try {
      const kind = String(req.params.kind);
      const agencyId = req.authUser!.agencyId!;
      const ok = await deleteAgencySound(agencyId, kind);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "sound_clear",
        target: kind,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // Tone-set version probe. Consoles and handsets poll this and re-pull their
  // custom tones whenever the returned version changes.
  router.get("/sounds", async (req, res) => {
    try {
      const agencyId = await resolveSoundAgencyId(req);
      if (agencyId == null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.json({ version: await getAgencySoundsVersion(agencyId) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Serves an agency's custom tone to consoles (JWT) and handsets (radio key).
  // A 404 simply means "no custom tone" — the client falls back to its bundled one.
  router.get("/sounds/:kind", async (req, res) => {
    try {
      const kind = String(req.params.kind);
      if (!isSoundKind(kind)) {
        res.status(404).json({ error: "unknown_sound" });
        return;
      }
      const agencyId = await resolveSoundAgencyId(req);
      if (agencyId == null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const sound = await getAgencySound(agencyId, kind);
      if (!sound) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", sound.mime);
      res.setHeader("Cache-Control", "no-cache");
      res.send(sound.audio);
    } catch (error) {
      fail(res, error);
    }
  });

  // --- agency logo (branding) --------------------------------------------

  router.put(
    "/admin/agency/logo",
    requireAdmin,
    raw({ type: () => true, limit: LOGO_MAX_BYTES }),
    async (req, res) => {
      try {
        const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!mime.startsWith("image/")) {
          res.status(415).json({ error: "bad_image_type" });
          return;
        }
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "missing_image" });
          return;
        }
        const agencyId = req.authUser!.agencyId!;
        await setAgencyLogo(agencyId, body, mime);
        await writeAudit({
          agencyId,
          actorUserId: req.authUser!.id,
          actorName: req.authUser!.username,
          action: "agency_logo_set",
          detail: { mime, bytes: body.length },
          ip: clientIp(req),
        });
        res.json({ ok: true, mime, byte_size: body.length });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.delete("/admin/agency/logo", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      await deleteAgencyLogo(agencyId);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "agency_logo_clear",
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // Serves an agency's logo to consoles (JWT) and handsets (radio key).
  // 404 simply means "no logo" — the client falls back to the safeT mark.
  router.get("/agency/logo", async (req, res) => {
    try {
      let agencyId = req.authUser?.agencyId ?? null;
      if (agencyId == null) {
        const headerRaw = req.headers["x-radio-key"];
        const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
        const key = headerVal ?? (typeof req.query.key === "string" ? req.query.key : null);
        const agency = await resolveAgencyByKey(key ?? null, radioApiKey).catch(() => null);
        agencyId = agency?.id ?? null;
      }
      if (agencyId == null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const logo = await getAgencyLogo(agencyId);
      if (!logo) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", logo.mime);
      res.setHeader("Cache-Control", "no-cache");
      res.send(logo.logo);
    } catch (error) {
      fail(res, error);
    }
  });

  // --- custom soundboard tone-outs ---------------------------------------

  router.get("/tone-outs", requireAgencyMember, async (req, res) => {
    try {
      res.json({ toneOuts: await listToneOuts(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/tone-outs/:id/audio", requireAgencyMember, async (req, res) => {
    try {
      const record = await getToneOutAudio(Number(req.params.id), req.authUser!.agencyId!);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.send(record.audio);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/tone-outs/:id/icon", requireAgencyMember, async (req, res) => {
    try {
      const record = await getToneOutIcon(Number(req.params.id), req.authUser!.agencyId!);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.setHeader("Cache-Control", "no-cache");
      res.send(record.image);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/tone-outs", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      const colorRaw = String(body.iconColor ?? "").trim();
      const toneOut = await createToneOut(agencyId, {
        name: name.slice(0, 60),
        playMode: oneOf(body.playMode, TONE_OUT_PLAY_MODES, "once"),
        iconKind: String(body.iconKind ?? "waveform").trim().slice(0, 32) || "waveform",
        iconColor: /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : "#22c5e5",
      });
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "tone_out_create",
        target: name,
        ip: clientIp(req),
      });
      res.status(201).json({ toneOut });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/tone-outs/:id", requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; playMode?: string; iconKind?: string; iconColor?: string } = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        patch.name = name.slice(0, 60);
      }
      if (body.playMode !== undefined) {
        patch.playMode = oneOf(body.playMode, TONE_OUT_PLAY_MODES, "once");
      }
      if (body.iconKind !== undefined) {
        patch.iconKind = String(body.iconKind).trim().slice(0, 32) || "waveform";
      }
      if (body.iconColor !== undefined) {
        const color = String(body.iconColor).trim();
        patch.iconColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#22c5e5";
      }
      const toneOut = await updateToneOut(Number(req.params.id), req.authUser!.agencyId!, patch);
      if (!toneOut) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ toneOut });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put(
    "/admin/tone-outs/:id/audio",
    requireAdmin,
    raw({ type: () => true, limit: TONE_OUT_AUDIO_MAX }),
    async (req, res) => {
      try {
        const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!mime.startsWith("audio/") && mime !== "application/octet-stream") {
          res.status(415).json({ error: "bad_audio_type" });
          return;
        }
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "missing_audio" });
          return;
        }
        const ok = await setToneOutAudio(
          Number(req.params.id),
          req.authUser!.agencyId!,
          body,
          mime,
        );
        if (!ok) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.json({ ok: true, byte_size: body.length });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.put(
    "/admin/tone-outs/:id/icon",
    requireAdmin,
    raw({ type: () => true, limit: LOGO_MAX_BYTES }),
    async (req, res) => {
      try {
        const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!mime.startsWith("image/")) {
          res.status(415).json({ error: "bad_image_type" });
          return;
        }
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "missing_image" });
          return;
        }
        const ok = await setToneOutIcon(Number(req.params.id), req.authUser!.agencyId!, body, mime);
        if (!ok) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.delete("/admin/tone-outs/:id/icon", requireAdmin, async (req, res) => {
    try {
      const ok = await clearToneOutIcon(Number(req.params.id), req.authUser!.agencyId!);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/tone-outs/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const ok = await deleteToneOut(Number(req.params.id), agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "tone_out_delete",
        target: String(req.params.id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: channel assignments / permissions --------------------------

  router.get("/admin/memberships", requireAdmin, async (req, res) => {
    try {
      res.json({ memberships: await listMemberships(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put("/admin/memberships", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const userId = Number(req.body?.userId);
      const channelId = Number(req.body?.channelId);
      const permission = asPermission(req.body?.permission);
      if (!Number.isFinite(userId) || !Number.isFinite(channelId) || !permission) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      // Both sides of the assignment must belong to the caller's agency.
      const [user, channel] = await Promise.all([
        getUserById(userId, agencyId),
        getChannelById(channelId, agencyId),
      ]);
      if (!user || !channel) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await setMembership(userId, channelId, permission);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "membership_set",
        target: `user:${userId} channel:${channelId}`,
        detail: { permission },
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/memberships", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const userId = Number(req.query.userId);
      const channelId = Number(req.query.channelId);
      if (!Number.isFinite(userId) || !Number.isFinite(channelId)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const user = await getUserById(userId, agencyId);
      if (!user) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const ok = await removeMembership(userId, channelId);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "membership_remove",
        target: `user:${userId} channel:${channelId}`,
        ip: clientIp(req),
      });
      res.json({ ok });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: audit log --------------------------------------------------

  router.get("/admin/audit", requireAdmin, async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 200);
      res.json({ entries: await listAudit(req.authUser!.agencyId!, Number.isFinite(limit) ? limit : 200) });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- transmissions (recorded audio + transcripts) ----------------------

  router.get("/transmissions", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() !== "" ? v : undefined;
      const opts = {
        agencyId,
        limit: Number(req.query.limit ?? 100),
        search: str(req.query.search),
        channel: str(req.query.channel),
        user: str(req.query.user),
        from: str(req.query.from),
        to: str(req.query.to),
        sort: str(req.query.sort) as TransmissionSort | undefined,
      };
      if (me.role === "admin" || me.role === "dispatcher") {
        res.json({ transmissions: await listTransmissions(opts) });
        return;
      }
      const channels = await listChannelsForUser(me.id);
      res.json({
        transmissions: await listTransmissions({ ...opts, channelNames: channels.map((c) => c.name) }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/transmissions/:id/audio", requireAgencyMember, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const record = await getTransmissionAudio(id, req.authUser!.agencyId!);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.setHeader("Content-Disposition", `inline; filename="transmission-${id}.wav"`);
      res.send(record.audio);
    } catch (error) {
      fail(res, error);
    }
  });

  // --- radio endpoints (handsets, radio-key auth) ------------------------

  router.post("/radio/location", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unitId = String(body.unit_id ?? "").trim().toUpperCase();
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      if (!unitId || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const optionalNumber = (value: unknown): number | null => {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };
      await upsertPosition({
        agencyId: radioAgencyId(req),
        unitId,
        userId: req.authUser?.id ?? null,
        displayName: body.display_name ? String(body.display_name) : req.authUser?.displayName ?? null,
        channelName: body.channel ? String(body.channel) : null,
        lat,
        lon,
        accuracyM: optionalNumber(body.accuracy_m),
        heading: optionalNumber(body.heading),
        speedMps: optionalNumber(body.speed_mps),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/radio/transmissions", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 80);
      const transmissions = await listTransmissions({
        agencyId: radioAgencyId(req),
        sort: "newest",
        limit,
      });
      res.json({
        transmissions: transmissions.map((t) => ({
          id: t.id,
          channel_name: t.channel_name,
          started_at: formatTransmissionStartedAt(t.started_at),
          duration_ms: t.duration_ms,
          transcript: t.transcript,
          transcript_status: t.transcript_status,
          unit_id: t.unit_id,
          display_name: t.display_name,
        })),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/radio/inbox", async (req, res) => {
    try {
      const unit = String(req.query.unit ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const channel = req.query.channel ? String(req.query.channel) : null;
      const since = Number(req.query.since ?? 0);
      const alerts = await listInboxAlerts(radioAgencyId(req), unit, channel, Number.isFinite(since) ? since : 0);
      const lastId = alerts.length > 0 ? alerts[alerts.length - 1]!.id : Number.isFinite(since) ? since : 0;
      const ten33 = await listTen33Channels(radioAgencyId(req));
      res.json({ alerts, lastId, ten33 });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/radio/emergency", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unit = String(body.unit_id ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const agencyId = radioAgencyId(req);
      if (body.active === false) {
        const cleared = await clearEmergenciesFromUnit(agencyId, unit, unit);
        res.json({ ok: true, cleared });
        return;
      }
      const alert = await createAlert({
        agencyId,
        kind: "emergency",
        channelName: body.channel ? String(body.channel) : null,
        targetUnit: null,
        fromUserId: null,
        fromName: body.display_name ? String(body.display_name) : unit,
        fromUnit: unit,
        message: body.message ? String(body.message) : "Emergency activated",
      });
      res.status(201).json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- console: live map + alerts ----------------------------------------

  // Dispatcher toggles the 10-33 marker for a channel; radios poll this via
  // /radio/inbox and show a warning icon while their tuned channel is flagged.
  router.get("/ai-dispatch/status", requireAgencyMember, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const platform = getAiDispatchPlatformStatus();
      const elevenKey = await getAgencyIntegrationValue(agencyId, "elevenlabs_api_key");
      const voiceId = await getAgencyIntegrationValue(agencyId, "elevenlabs_voice_id");
      const promptSource = await agencyPromptSource(agencyId);
      res.json({
        platform_enabled: platform.enabled,
        platform_llm_configured: platform.llmConfigured,
        agency_tts_configured: !!elevenKey && !!voiceId,
        agency_prompt_configured: promptSource !== "railway_default",
        agency_prompt_source: promptSource,
        model: platform.model,
        dispatch_unit_id: platform.dispatchUnitId,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/channels/ai-dispatch", requireAgencyOperator, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const channel = String(body.channel ?? "").trim();
      if (!channel) {
        res.status(400).json({ error: "missing_channel" });
        return;
      }
      const enabled = body.enabled === true;
      await setChannelAiDispatch(req.authUser!.agencyId!, channel, enabled);
      await writeAudit({
        agencyId: req.authUser!.agencyId!,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: enabled ? "ai_dispatch_on" : "ai_dispatch_off",
        target: channel,
        ip: clientIp(req),
      });
      res.json({ ok: true, enabled });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/ai-dispatch/activity", requireAgencyMember, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const limit = Number(req.query.limit ?? 50);
      const entries = await listAiDispatchLog(agencyId, Number.isFinite(limit) ? limit : 50);
      const ten8_active = await listTen8ActiveIncidents(agencyId);
      const ten8_webhooks = await listTen8WebhookLog(agencyId, 25);
      res.json({
        count: entries.length,
        entries,
        ten8_active_incidents: ten8_active,
        ten8_recent_webhooks: ten8_webhooks,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/channels/ai-dispatch", requireAgencyOperator, async (req, res) => {
    try {
      const channel = String(req.query.channel ?? "").trim();
      if (!channel) {
        res.status(400).json({ error: "missing_channel" });
        return;
      }
      const row = await getChannelAiDispatchRow(req.authUser!.agencyId!, channel);
      res.json({ enabled: row?.enabled === true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/channels/ten33", requireAgencyOperator, async (req, res) => {
    try {
      const channel = String(req.query.channel ?? "").trim();
      if (!channel) {
        res.status(400).json({ error: "missing_channel" });
        return;
      }
      const active = await getChannelTen33Active(req.authUser!.agencyId!, channel);
      res.json({ active });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/channels/ten33", requireAgencyOperator, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const channel = String(body.channel ?? "").trim();
      if (!channel) {
        res.status(400).json({ error: "missing_channel" });
        return;
      }
      const active = body.active === true;
      const agencyId = req.authUser!.agencyId!;
      const platform = getAiDispatchPlatformConfig();
      await applyChannelTen33Marker({
        loopbackPort: getAiDispatchLoopbackPort(),
        agencyId,
        channelName: channel,
        active,
        markerUnitId: platform.dispatchUnitId,
        source: "manual",
      });
      res.json({ ok: true, active });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/locations", requireAgencyMember, async (req, res) => {
    try {
      res.json({ positions: await listPositions(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Selectable radio accounts (those with a unit id) for the GPS-log search picker.
  router.get("/agency/units", requireAgencyOperator, async (req, res) => {
    try {
      const users = await listUsers(req.authUser!.agencyId!);
      const units = users
        .filter((u) => u.unit_id && !u.disabled)
        .map((u) => ({ unit_id: u.unit_id as string, display_name: u.display_name }))
        .sort((a, b) =>
          (a.display_name || a.unit_id).localeCompare(b.display_name || b.unit_id),
        );
      res.json({ units });
    } catch (error) {
      fail(res, error);
    }
  });

  // Recorded GPS track for one radio — drives the map's "search GPS logs" tool.
  router.get("/locations/history", requireAgencyMember, async (req, res) => {
    try {
      const unit = String(req.query.unit ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const samples = await listPositionHistory({
        agencyId: req.authUser!.agencyId!,
        unitId: unit,
        from,
        to,
      });
      res.json({ unit, samples });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- console: map geofence overlays ------------------------------------

  router.get("/geofences", requireAgencyMember, async (req, res) => {
    try {
      res.json({ geofences: await listGeofences(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/geofences", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      const colorRaw = typeof body.color === "string" ? body.color.trim() : "";
      const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : null;
      const shape = body.shape === "polygon" ? "polygon" : "circle";

      let fields: {
        centerLat: number | null;
        centerLon: number | null;
        radiusM: number | null;
        points: [number, number][] | null;
        detail: Record<string, unknown>;
      };
      if (shape === "polygon") {
        const raw = Array.isArray(body.points) ? body.points : [];
        const points: [number, number][] = [];
        for (const pt of raw) {
          if (Array.isArray(pt) && pt.length === 2) {
            const lat = Number(pt[0]);
            const lon = Number(pt[1]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              points.push([lat, lon]);
            }
          }
        }
        // A polygon needs at least a triangle; cap the vertex count.
        if (points.length < 3) {
          res.status(400).json({ error: "missing_fields" });
          return;
        }
        fields = {
          centerLat: null,
          centerLon: null,
          radiusM: null,
          points: points.slice(0, 200),
          detail: { vertices: Math.min(points.length, 200) },
        };
      } else {
        const centerLat = Number(body.centerLat);
        const centerLon = Number(body.centerLon);
        const radiusM = Number(body.radiusM);
        if (
          !Number.isFinite(centerLat) ||
          !Number.isFinite(centerLon) ||
          !Number.isFinite(radiusM) ||
          radiusM <= 0
        ) {
          res.status(400).json({ error: "missing_fields" });
          return;
        }
        fields = {
          centerLat,
          centerLon,
          radiusM,
          points: null,
          detail: { radius_m: Math.round(radiusM) },
        };
      }

      const geofence = await createGeofence({
        agencyId,
        name: name.slice(0, 80),
        shape,
        color,
        centerLat: fields.centerLat,
        centerLon: fields.centerLon,
        radiusM: fields.radiusM,
        points: fields.points,
        createdBy: req.authUser!.displayName,
      });
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "geofence_create",
        target: geofence.name,
        detail: { shape, ...fields.detail },
        ip: clientIp(req),
      });
      res.status(201).json({ geofence });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/geofences/:id", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const ok = await deleteGeofence(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "geofence_delete",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/channels/roster", requireAgencyMember, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const channel = typeof req.query.channel === "string" ? req.query.channel : "";
      const members = listChannelRoster(agencyId, channel);
      res.json({ members: await annotateRosterStatus(agencyId, channel, members) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Live Channel Control: every channel with its currently-connected members.
  router.get("/channels/rosters", requireAgencyOperator, (req, res) => {
    try {
      res.json({ channels: listAgencyRosters(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Live Channel Control: spin up an emergency channel and pull units into it.
  router.post("/channels/emergency", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const rawName = String(req.body?.name ?? "").trim().slice(0, 60);
      const units: string[] = Array.isArray(req.body?.unit_ids)
        ? req.body.unit_ids.map((u: unknown) => String(u).trim().toUpperCase()).filter(Boolean)
        : [];
      const name = rawName || `EMERGENCY ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const existing = await listChannels(agencyId);
      // Reuse a channel with this name if it already exists, else create it.
      const channel = existing.find((c) => c.name === name) ?? (await createChannel(agencyId, name));
      let reached = 0;
      const moverName = req.authUser!.displayName.trim() || req.authUser!.username;
      for (const unit of units) {
        reached += sendMoveCommand(agencyId, unit, channel.name, moverName, null);
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "emergency_channel",
        target: channel.name,
        detail: { channel: channel.name, units, reached },
        ip: clientIp(req),
      });
      res.json({ ok: true, channel: channel.name, reached });
    } catch (error) {
      fail(res, error);
    }
  });

  // Live Channel Control: push a live "move to channel" command to a unit.
  router.post("/channels/move", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const unit = String(req.body?.unit_id ?? "").trim().toUpperCase();
      const toChannel = String(req.body?.toChannel ?? "").trim();
      const fromChannel = req.body?.fromChannel ? String(req.body.fromChannel).trim() : null;
      const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 80) : null;
      if (!unit || !toChannel) {
        res.status(400).json({ error: "missing_unit_or_channel" });
        return;
      }
      const channels = await listChannels(agencyId);
      if (!channels.some((c) => c.name === toChannel)) {
        res.status(404).json({ error: "unknown_channel" });
        return;
      }
      const moverName = req.authUser!.displayName.trim() || req.authUser!.username;
      const reached = sendMoveCommand(agencyId, unit, toChannel, moverName, fromChannel);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_move",
        target: `${unit} → ${toChannel}`,
        detail: { unit, fromChannel, toChannel, reason, reached },
        ip: clientIp(req),
      });
      res.json({ ok: true, reached });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/alerts", requireAgencyMember, async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      res.json({ alerts: await listAlerts(req.authUser!.agencyId!, Number.isFinite(limit) ? limit : 100) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/alerts", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const kind = req.body?.kind === "page" ? "page" : "emergency";
      if (kind === "page" && me.role !== "admin" && me.role !== "dispatcher") {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const channelName = req.body?.channelName ? String(req.body.channelName).trim() : null;
      const targetUnit = req.body?.targetUnit ? String(req.body.targetUnit).trim().toUpperCase() : null;
      const message = req.body?.message ? String(req.body.message).trim() : null;
      if (kind === "page" && !message) {
        res.status(400).json({ error: "missing_message" });
        return;
      }
      const alert = await createAlert({
        agencyId,
        kind,
        channelName,
        targetUnit,
        fromUserId: me.id,
        fromName: me.displayName,
        fromUnit: me.unitId,
        message: message ?? (kind === "emergency" ? "Emergency" : null),
      });
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: `alert_${kind}`,
        target: channelName ?? targetUnit ?? "all channels",
        detail: { message },
        ip: clientIp(req),
      });
      res.status(201).json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/alerts/:id/clear", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const id = Number(req.params.id);
      const alert = await clearAlert(id, agencyId, me.displayName);
      if (!alert) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "alert_clear",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
