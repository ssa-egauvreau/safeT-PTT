import { Router, raw } from "express";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  requireAdmin,
  requireAuth,
  requireOwner,
  signToken,
  verifyPassword,
  isSessionSuperseded,
  type AuthUser,
  type Role,
} from "./auth.js";
import { loginRateLimiter, loginRateLimitKeys } from "./loginRateLimit.js";
import {
  dropAgencyVoiceConnections,
  dropUserVoiceConnections,
  isUnitMoveLocked,
  listAgencyRosters,
  listChannelRoster,
  unitChannelCounts,
  withRosterMoveLock,
  peekVoiceTransmittingUnit,
  sendMoveCommand,
  sendDeviceCommand,
  listOnlineUnits,
  notifyChannelCodec,
  refreshSimulcastSockets,
  type PresenceStatus,
  type RosterMember,
} from "./voiceRelay.js";
import { coerceVoiceCodec, isVoiceCodec, type VoiceCodec } from "./voiceCodecs.js";
import { getBridgeStatus } from "./bridgeWorker.js";
import {
  AGENCY_ROLES,
  acknowledgeEmergency,
  bumpTokenGeneration,
  countActiveAdmins,
  clearAlert,
  clearEmergenciesFromUnit,
  resolveEmergency,
  createAgencyWithAdmin,
  createAlert,
  createChannel,
  createUser,
  deleteAgency,
  deleteChannel,
  deleteEmergencyChannel,
  deleteUnitAlias,
  deleteUser,
  generateRadioKey,
  getAgencyById,
  getAgencyByLocationKey,
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
  BRIDGE_NOISE_LEVELS,
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
  setAlertImage,
  setLocationReadKey,
  getAlertImage,
  addAlertResponse,
  listAlertResponses,
  listDeviceAcks,
  listAudit,
  listChannels,
  listChannelsForUser,
  listZones,
  createZone,
  updateZone,
  deleteZone,
  getZoneById,
  listInboxAlerts,
  listTen33Channels,
  getChannelTen33Active,
  setChannelAiDispatch,
  listChannelAiDispatchModes,
  getChannelAiDispatchRow,
  setAgencyIntegrationValue,
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
  isKbCategory,
  KB_CATEGORIES,
  KB_CATEGORY_SECTIONS,
  listKbDocuments,
  createKbDocument,
  getKbDocumentContent,
  kbDocumentExists,
  deleteKbDocument,
  resolveAgencyByKey,
  setAgencyLogo,
  setAgencySound,
  applyUserPermissionTemplate,
  createUserPermissionTemplate,
  deleteUserPermissionTemplate,
  getUserPermissionTemplate,
  listUserPermissionTemplates,
  removeMembership,
  setMembership,
  updateUserPermissionTemplate,
  assignUserTemplate,
  setUnitAlias,
  uniqueAgencySlug,
  agencyAllowsAiDispatch,
  updateAgency,
  updateChannel,
  updateUser,
  upsertPosition,
  writeAudit,
  getGlobalAudioConfig,
  setGlobalAudioConfig,
  listAudioLabPresets,
  getAudioLabPreset,
  upsertAudioLabPreset,
  deleteAudioLabPreset,
  type Permission,
  type TransmissionSort,
} from "./store.js";
import {
  getKpiSummary,
  getTimeSeries,
  getChannelUtilization,
  getTopUnits,
  getAiDispatchOutcomes,
  parseAnalyticsRange,
} from "./analytics.js";
import { normalizeClientType } from "./clientType.js";
import { deriveDeviceAudioConfig } from "./audioConfig.js";
import { isValidPresetName, summarizePreset } from "./audioLabPresets.js";
import { getPool } from "./db.js";
import { isPostgresDiskFullError } from "./postgresErrors.js";
import {
  insertVoiceLinkTelemetry,
  listVoiceLinkUnitSummaries,
  listLatestAppVersionsByUnit,
  listVoiceLinkUnitTimeseries,
  type VoiceLinkTelemetryInsert,
} from "./voiceLinkTelemetryStore.js";
import { getCachedAuth, invalidateCachedAuth, setCachedAuth } from "./sessionCache.js";
import {
  handleIntegrationHealth,
  handleListIntegrations,
  handleSetIntegration,
} from "./integrations/adminApi.js";
import { getAiDispatchLoopbackPort } from "./aiDispatch/engine.js";
import { runAiDispatchDryRun } from "./aiDispatch/dryRun.js";
import {
  agencyPromptSource,
  getAiDispatchPlatformConfig,
  getAiDispatchPlatformStatus,
  resolveAiDispatchWakeWord,
} from "./aiDispatch/platformConfig.js";
import { applyChannelTen33Marker } from "./aiDispatch/ten33Marker.js";
import { resolveElevenLabsApiKey, resolveElevenLabsVoiceId } from "./aiDispatch/elevenLabsCreds.js";
import { listAiDispatchLog } from "./aiDispatch/activityLog.js";
import { getAiActivity } from "./aiDispatch/aiActivity.js";
import {
  aiDispatchModeEnabled,
  normalizeAiDispatchMode,
  normalizeWakeWord,
} from "./aiDispatch/supervisedMode.js";
import { enqueueKbIngest } from "./aiDispatch/knowledgeBase/ingest.js";
import { getEmbeddingModelName } from "./aiDispatch/knowledgeBase/embeddings.js";
import { handleTen8Webhook, handleTen8WebhookGet } from "./ten8/webhook.js";
import { createBillingRouter } from "./billing/routes.js";
import { isAgencyBillingSuspended, syncSeatsForAgency } from "./billing/subscription.js";
import {
  androidUpdatePublishAuthError,
  handleAndroidUpdateApk,
  handleAndroidUpdateManifest,
  handleAndroidUpdatePublish,
  handleAndroidReleaseHistory,
} from "./appUpdate.js";
import { listTen8MapIncidents } from "./ten8/mapIncidents.js";
import { listTen8ActiveIncidents, listTen8WebhookLog } from "./ten8/store.js";
import {
  ten8Configured,
  ten8ResolvedHosts,
  ten8Health,
  ten8GetIncident,
  ten8ListIncidents,
  ten8SearchPersons,
  ten8SearchVehicles,
  ten8AddVehicle,
  ten8RemoveVehicle,
  ten8AddPerson,
  ten8RemovePerson,
  ten8AddTag,
  ten8RemoveTag,
  ten8AddComment,
  ten8UpdateComment,
  ten8CreateIncident,
} from "./ten8/client.js";

/** Legacy global radio key — lets a handset fetch its agency's custom tones. */
const radioApiKey = process.env.RADIO_API_KEY?.trim();

/** Upper bound for an uploaded tone (short clips; keeps a clip well under this). */
const SOUND_MAX_BYTES = "1mb";

/** Upper bound for an uploaded agency logo. */
const LOGO_MAX_BYTES = "512kb";

/** Upper bound for a page/message picture attachment. */
const ALERT_IMAGE_MAX_BYTES = "4mb";

/** Upper bound for an uploaded soundboard tone-out clip. */
const TONE_OUT_AUDIO_MAX = "4mb";

/** Upper bound for an uploaded knowledge-base document (PDF). */
const KB_MAX_DOC_BYTES = process.env.KB_MAX_DOC_BYTES?.trim() || "50mb";

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

/** Commands an admin may push to a handset via POST /admin/device-command.
 *  Kept as an allowlist so a new server→device capability is an explicit,
 *  auditable addition rather than an open remote-control surface. */
const DEVICE_COMMANDS = new Set<string>([
  "check_update", // check for a newer app build and (touchlessly) install it
  "apply_audio_settings", // push RX gain / EQ / volume to the device
  "report_diagnostics", // ask the handset to send back a diagnostics snapshot
]);

function fail(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "database_unavailable") {
    res.status(503).json({ error: "database_unavailable" });
    return;
  }
  if (isPostgresDiskFullError(error)) {
    console.error("API error (postgres disk full)", error);
    res.status(503).json({
      error: "database_disk_full",
      hint: "PostgreSQL volume is full. Free space or upgrade disk on Railway, then redeploy.",
    });
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

/** Maximum INT we'll accept for a single counter — caps a buggy / hostile
 *  client at the Postgres `INT4` ceiling so a single oversize value can't make
 *  the insert fail with a numeric-out-of-range error and burn a retry loop. */
const VOICE_LINK_TELEMETRY_COUNTER_MAX = 2_000_000_000;

/** Upper bound for one telemetry POST. Real client reports are ~200-400 bytes;
 *  cap at 4 KB so a buggy or hostile client can't smuggle a large blob through
 *  this endpoint. */
const VOICE_LINK_TELEMETRY_MAX_BODY_BYTES = 4 * 1024;

/** Hard cap on per-codec entries in one report so a buggy client can't smuggle
 *  thousands of synthetic codec keys (one per report = O(N) JSONB merge work on
 *  the aggregation query). 16 is comfortably larger than the 3 codecs we
 *  actually ship (`imbe`, `codec2_3200`, `opus`) with room for future entries. */
const VOICE_LINK_TELEMETRY_MAX_CODECS = 16;

function clampCounter(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > VOICE_LINK_TELEMETRY_COUNTER_MAX) return VOICE_LINK_TELEMETRY_COUNTER_MAX;
  return Math.floor(n);
}

/** Strict, side-effect-free parser for `POST /v1/telemetry/voice-link`. Returns
 *  either a normalized {counters, codecBreakdown, clientTs} or an `error` code
 *  for the route to surface with a 400. Validates body size, counter range,
 *  and codec-breakdown shape — no exceptions inside the route. Exported so
 *  the unit tests can pin the contract independently of the live router. */
export function parseVoiceLinkTelemetryBody(body: Record<string, unknown>): {
  ok: true;
  counters: {
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
  };
  codecBreakdown: Record<string, { framesReceived: number; framesDecoded: number }>;
  clientTs: string | null;
  appVersionName: string | null;
  appVersionCode: number | null;
} | { ok: false; error: string } {
  // Reject oversize JSON up front so a buggy/hostile client can't slip a large
  // blob through this endpoint. We measure the JSON size of the parsed body
  // rather than the raw Content-Length so the cap also covers cases where
  // express.json() accepted a larger payload than we want here.
  try {
    const serialized = JSON.stringify(body);
    if (serialized.length > VOICE_LINK_TELEMETRY_MAX_BODY_BYTES) {
      return { ok: false, error: "payload_too_large" };
    }
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const rawCounters = body.counters;
  if (!rawCounters || typeof rawCounters !== "object") {
    return { ok: false, error: "missing_counters" };
  }
  const c = rawCounters as Record<string, unknown>;
  const counters = {
    framesReceived: clampCounter(c.framesReceived),
    framesDecoded: clampCounter(c.framesDecoded),
    decodeFailures: clampCounter(c.decodeFailures),
    plcFramesSynthesized: clampCounter(c.plcFramesSynthesized),
    bufferUnderruns: clampCounter(c.bufferUnderruns),
    maxBufferDepthFrames: clampCounter(c.maxBufferDepthFrames),
    talkSpurtsStarted: clampCounter(c.talkSpurtsStarted),
    talkSpurtsEnded: clampCounter(c.talkSpurtsEnded),
    bytesReceived: clampCounter(c.bytesReceived),
    // Uplink bytes — optional; clients that predate the data-usage column
    // simply don't send it and clampCounter coerces the undefined to 0.
    bytesSent: clampCounter(c.bytesSent),
    wallMsObservation: clampCounter(c.wallMsObservation),
  };
  const codecBreakdown: Record<string, { framesReceived: number; framesDecoded: number }> = {};
  const raw = body.codecBreakdown;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    let count = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (count >= VOICE_LINK_TELEMETRY_MAX_CODECS) break;
      if (typeof k !== "string" || !k || k.length > 32) continue;
      if (!v || typeof v !== "object") continue;
      const entry = v as Record<string, unknown>;
      codecBreakdown[k.slice(0, 32)] = {
        framesReceived: clampCounter(entry.framesReceived),
        framesDecoded: clampCounter(entry.framesDecoded),
      };
      count += 1;
    }
  }
  let clientTs: string | null = null;
  if (typeof body.clientTs === "string" && body.clientTs.length > 0 && body.clientTs.length <= 64) {
    const parsed = Date.parse(body.clientTs);
    if (Number.isFinite(parsed)) {
      clientTs = new Date(parsed).toISOString();
    }
  }
  const appVersionName =
    typeof body.appVersionName === "string" && body.appVersionName.trim().length > 0
      ? body.appVersionName.trim().slice(0, 40)
      : null;
  const rawVersionCode = Number(body.appVersionCode);
  const appVersionCode =
    Number.isInteger(rawVersionCode) && rawVersionCode > 0 && rawVersionCode < 1_000_000_000
      ? rawVersionCode
      : null;
  return { ok: true, counters, codecBreakdown, clientTs, appVersionName, appVersionCode };
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

/**
 * Agency authorized to read the location feed, for an endpoint reachable two
 * ways: a signed-in agency member (console JWT), or a read-only location key
 * (header `X-SafeT-Location-Key` or `?location_key=`) issued to an external
 * map integration. The key grants ONLY the location read endpoints — it is
 * never accepted for PTT, admin, or any write. Resolves to `{ agencyId }`, or
 * `{ status, error }` describing how to reject.
 */
async function resolveLocationReadAgency(
  req: Request,
): Promise<{ agencyId: number } | { status: number; error: string }> {
  if (req.authUser) {
    if (req.authUser.agencyId == null) {
      return { status: 403, error: "forbidden" };
    }
    return { agencyId: req.authUser.agencyId };
  }
  const headerRaw = req.headers["x-safet-location-key"];
  const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const key = (headerVal ?? (typeof req.query.location_key === "string" ? req.query.location_key : null))?.trim();
  if (!key) {
    return { status: 401, error: "unauthorized" };
  }
  const agency = await getAgencyByLocationKey(key).catch(() => null);
  if (!agency || agency.disabled) {
    return { status: 401, error: "unauthorized" };
  }
  return { agencyId: agency.id };
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
  router.get("/app/android/releases", handleAndroidReleaseHistory);
  router.get("/app/android/apk", handleAndroidUpdateApk);
  // Reject unauthorized uploads before raw body parsing to avoid large-buffer DoS.
  function androidUpdatePublishPreAuth(req: Request, res: Response, next: NextFunction): void {
    const authError = androidUpdatePublishAuthError(req.headers);
    if (authError) {
      res.status(authError.status).json({ error: authError.error });
      return;
    }
    next();
  }
  // CI publishes new builds here (bearer-token auth inside the handler); raw APK body.
  router.post(
    "/app/android/publish",
    androidUpdatePublishPreAuth,
    raw({ type: () => true, limit: "200mb" }),
    handleAndroidUpdatePublish,
  );

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
        // Radio handsets are persistent, shared devices and "stay signed in
        // until manual sign-out" (their tokens carry no expiry) — so they are
        // exempt from "newest sign-in wins" supersession, which otherwise
        // silently 401s a handset whenever the token generation bumps and leaves
        // the radio stuck on "SYNC FAILED" until a manual re-login. Console /
        // admin / owner sessions still supersede normally. (See isSessionSuperseded.)
        if (isSessionSuperseded(auth.role, auth.gen, cached.tokenGeneration)) {
          res.status(401).json({ error: "session_superseded" });
          return;
        }
        if (cached.agencyDisabled) {
          res.status(403).json({ error: "agency_disabled", billing_suspend: cached.billingSuspend });
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
      // Newest sign-in wins — except for radio handsets, which are persistent
      // shared devices exempt from supersession (see the cached path above).
      if (isSessionSuperseded(auth.role, auth.gen, user.token_generation)) {
        res.status(401).json({ error: "session_superseded" });
        return;
      }
      let agencyDisabled = false;
      let billingSuspend = false;
      if (auth.agencyId != null) {
        const agency = await getAgencyById(auth.agencyId);
        if (!agency || agency.disabled) {
          agencyDisabled = true;
          billingSuspend = isAgencyBillingSuspended(agency);
          setCachedAuth(auth.id, {
            tokenGeneration: user.token_generation,
            userDisabled: false,
            agencyDisabled: true,
            billingSuspend,
          });
          res.status(403).json({
            error: billingSuspend ? "agency_suspended_billing" : "agency_disabled",
            billing_suspend: billingSuspend,
          });
          return;
        }
      }
      setCachedAuth(auth.id, {
        tokenGeneration: user.token_generation,
        userDisabled: false,
        agencyDisabled,
        billingSuspend: false,
      });
      next();
    } catch (error) {
      fail(res, error);
    }
  });

  // Billing has both public signup endpoints and admin-only billing actions.
  // Mounting it here ensures authenticated billing requests still pass through
  // the token-generation / disabled-account enforcement middleware above.
  router.use(createBillingRouter());

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
      const ip = clientIp(req);
      // Throttle by (ip, username) so credential-stuffing one account and
      // sweeping many accounts from one host both hit a lockout. Checked before
      // the password compare so a locked attacker never reaches bcrypt.
      const rateLimitKeys = loginRateLimitKeys(ip, username);
      const lockedMs = loginRateLimiter.retryAfterMsFor(rateLimitKeys);
      if (lockedMs > 0) {
        const retryAfterSeconds = Math.ceil(lockedMs / 1000);
        await writeAudit({
          agencyId: null,
          actorUserId: null,
          actorName: username,
          action: "login_rate_limited",
          ip,
        });
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({ error: "too_many_attempts", retryAfterSeconds });
        return;
      }
      const user = await getUserByUsername(username);
      const blocked = !user || user.disabled || user.agency_disabled === true;
      if (blocked || !(await verifyPassword(password, user!.password_hash))) {
        // Count only this pre-verification failure toward lockout: a wrong
        // username or password is the brute-force signal. Failures past this
        // point (agency mismatch, account disabled mid-login) imply the
        // password was already correct, so they must not throttle the user.
        for (const key of rateLimitKeys) {
          loginRateLimiter.recordFailure(key);
        }
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
      const hasDb = !!getPool();
      // Mint a fresh session generation so any token still floating around for
      // this account immediately fails the freshness check on its next call.
      const newGen = hasDb ? await bumpTokenGeneration(user!.id) : 0;
      // Drop the cached "auth is fine" entry for this user so the next request from any prior
      // device sees the new token_generation and gets a 401 immediately, instead of waiting
      // up to TTL for the cache to expire.
      invalidateCachedAuth(user!.id);
      const postBumpUser = hasDb ? await getUserById(user!.id) : user;
      // If the row vanished / was disabled between password verification and generation bump,
      // fail the login so we never seed a "healthy" cache state for a revoked account.
      if (
        hasDb &&
        (!postBumpUser ||
          postBumpUser.disabled ||
          postBumpUser.token_generation !== newGen)
      ) {
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
      if (hasDb && postBumpUser?.agency_id != null) {
        const postBumpAgency = await getAgencyById(postBumpUser.agency_id);
        if (!postBumpAgency || postBumpAgency.disabled) {
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
      }
      // Seed the cache with the bumped generation right away so a stale in-flight request that
      // read the old generation from Postgres cannot repopulate an older cache entry afterward.
      setCachedAuth(postBumpUser!.id, {
        tokenGeneration: newGen,
        userDisabled: false,
        agencyDisabled: false,
      });
      const evictedSockets = dropUserVoiceConnections(postBumpUser!.id);
      const authUser: AuthUser = {
        id: postBumpUser!.id,
        username: postBumpUser!.username,
        displayName: postBumpUser!.display_name,
        role: postBumpUser!.role,
        unitId: postBumpUser!.unit_id,
        agencyId: postBumpUser!.agency_id,
        agencyName: user!.agency_name,
        gen: newGen,
      };
      await writeAudit({
        agencyId: postBumpUser!.agency_id,
        actorUserId: postBumpUser!.id,
        actorName: postBumpUser!.username,
        action: "login",
        ip: clientIp(req),
      });
      if (evictedSockets > 0) {
        await writeAudit({
          agencyId: postBumpUser!.agency_id,
          actorUserId: postBumpUser!.id,
          actorName: postBumpUser!.username,
          action: "session_evicted",
          detail: { dropped_voice_sockets: evictedSockets, new_ip: clientIp(req) },
          ip: clientIp(req),
        });
      }
      // Valid credentials — clear the throttle so a legitimate user who fumbled
      // a few passwords isn't penalised on their next sign-in.
      for (const key of rateLimitKeys) {
        loginRateLimiter.recordSuccess(key);
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
      // Agency supervised wake phrase (default "hey ai"), delivered to handsets so the on-device
      // wake-word gate knows what to listen for; harmless extra field for the console.
      const wakeWord = await resolveAiDispatchWakeWord(me.agencyId!);
      if (me.role === "admin" || me.role === "dispatcher") {
        const agencyId = me.agencyId!;
        const all = await listChannels(agencyId);
        const sims = await listSimulcasts(agencyId);
        const aiModes = await listChannelAiDispatchModes(agencyId);
        const aiEnabled = new Set(aiModes.keys());
        const agency = await getAgencyById(agencyId);
        const simulcastCodec = coerceVoiceCodec(agency?.default_codec);
        res.json({
          channels: [
            ...all.map((c) => ({
              id: c.id,
              name: c.name,
              color: c.color,
              zone: c.zone,
              zone_number: c.zone_number,
              codec: c.codec,
              permission: "talk_priority",
              simulcast: false,
              ai_dispatch_enabled: aiEnabled.has(c.name),
              ai_dispatch_mode: aiModes.get(c.name) ?? "off",
            })),
            // Simulcast channels carry a negative id so they never collide with
            // a real channel id in the console's open-channel set.
            ...sims.map((s) => ({
              id: -s.id,
              name: s.name,
              color: null,
              zone: "Simulcast",
              zone_number: null,
              codec: simulcastCodec,
              permission: "talk_priority",
              simulcast: true,
            })),
          ],
          wake_word: wakeWord,
        });
        return;
      }
      const userChannels = await listChannelsForUser(me.id);
      const aiModes = await listChannelAiDispatchModes(me.agencyId!);
      res.json({
        channels: userChannels.map((c) => ({
          ...c,
          ai_dispatch_enabled: aiModes.has(c.name),
          ai_dispatch_mode: aiModes.get(c.name) ?? "off",
        })),
        wake_word: wakeWord,
      });
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
      const patch: { name?: string; disabled?: boolean; radioKey?: string; defaultCodec?: VoiceCodec } = {};
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
      if (req.body?.defaultCodec !== undefined) {
        if (!isVoiceCodec(req.body.defaultCodec)) {
          res.status(400).json({ error: "bad_codec" });
          return;
        }
        patch.defaultCodec = req.body.defaultCodec;
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
      if (role === "radio") {
        void syncSeatsForAgency(agencyId).catch((e) => console.warn("[billing] seat sync failed", e));
      }
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

      // Bind/unbind a permission template. Binding full-syncs the user's channel
      // memberships to it now; the template's own edits propagate from then on.
      let assignedTemplate = false;
      if (req.body?.assignedTemplateId !== undefined) {
        const raw = req.body.assignedTemplateId;
        const templateId = raw === null || raw === "" ? null : Number(raw);
        if (templateId !== null && !Number.isInteger(templateId)) {
          res.status(400).json({ error: "not_found" });
          return;
        }
        await assignUserTemplate(id, templateId, agencyId);
        assignedTemplate = true;
      }

      const user = await updateUser(id, patch);
      if (existing.role === "radio" || patch.role === "radio" || patch.disabled !== undefined) {
        void syncSeatsForAgency(agencyId).catch((e) => console.warn("[billing] seat sync failed", e));
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_update",
        target: existing.username,
        detail: { fields: [...Object.keys(patch), ...(assignedTemplate ? ["assignedTemplateId"] : [])] },
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
      if (existing.role === "radio") {
        void syncSeatsForAgency(agencyId).catch((e) => console.warn("[billing] seat sync failed", e));
      }
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

  // --- admin: zones --------------------------------------------------------
  // Numbered channel banks (zone 1, zone 2, …). The number is what radios show
  // in front of the channel name ("1 GREEN 1"); the name is the description.

  router.get("/admin/zones", requireAdmin, async (req, res) => {
    try {
      res.json({ zones: await listZones(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/zones", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const zoneNumber = Number(req.body?.zone_number);
      const name = String(req.body?.name ?? "").trim();
      if (!Number.isInteger(zoneNumber) || zoneNumber < 1 || zoneNumber > 999) {
        res.status(400).json({ error: "bad_zone_number" });
        return;
      }
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      const zone = await createZone(agencyId, zoneNumber, name);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "zone_create",
        target: `${zoneNumber} ${name}`,
        ip: clientIp(req),
      });
      res.status(201).json({ zone });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/zones/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const patch: { zoneNumber?: number; name?: string } = {};
      if (req.body?.zone_number !== undefined) {
        const zoneNumber = Number(req.body.zone_number);
        if (!Number.isInteger(zoneNumber) || zoneNumber < 1 || zoneNumber > 999) {
          res.status(400).json({ error: "bad_zone_number" });
          return;
        }
        patch.zoneNumber = zoneNumber;
      }
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        patch.name = name;
      }
      const zone = await updateZone(id, agencyId, patch);
      if (!zone) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "zone_update",
        target: `${zone.zone_number} ${zone.name}`,
        detail: { id, fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ zone });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/zones/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const ok = await deleteZone(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "zone_delete",
        target: String(id),
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
      const patch: {
        name?: string;
        color?: string | null;
        zoneId?: number | null;
        codec?: VoiceCodec;
      } = {};
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
      if (req.body?.zone_id !== undefined) {
        if (req.body.zone_id === null) {
          patch.zoneId = null;
        } else {
          const zoneId = Number(req.body.zone_id);
          // The FK is global — confirm the zone belongs to this agency before linking.
          if (!Number.isInteger(zoneId) || !(await getZoneById(zoneId, agencyId))) {
            res.status(400).json({ error: "bad_zone" });
            return;
          }
          patch.zoneId = zoneId;
        }
      }
      if (req.body?.codec !== undefined) {
        if (!isVoiceCodec(req.body.codec)) {
          res.status(400).json({ error: "bad_codec" });
          return;
        }
        patch.codec = req.body.codec;
      }
      const channel = await updateChannel(id, agencyId, patch);
      if (!channel) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Push the codec change to every voice socket on this channel so connected
      // clients flush their TX encoder and swap mid-session rather than waiting
      // for a reconnect. Safe to call unconditionally — the relay no-ops if the
      // value matches what each client already has.
      if (patch.codec !== undefined) {
        notifyChannelCodec(agencyId, channel.name, patch.codec);
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
      const prior = (await listSimulcasts(agencyId)).find((s) => s.id === id);
      const ok = await updateSimulcast(id, agencyId, patch);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Re-resolve cached fan-out targets on sockets already joined to this
      // simulcast — member-list edits and renames must take effect live, not
      // on the next reconnect.
      if (prior) {
        await refreshSimulcastSockets(agencyId, prior.name);
        if (patch.name && patch.name !== prior.name) {
          await refreshSimulcastSockets(agencyId, patch.name);
        }
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
      const prior = (await listSimulcasts(agencyId)).find((s) => s.id === id);
      const ok = await deleteSimulcast(id, agencyId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Sockets joined to the deleted simulcast cached its member channels at
      // join time and would keep transmitting onto them forever — clear the
      // fan-out now and tell those clients the channel is gone.
      if (prior) {
        await refreshSimulcastSockets(agencyId, prior.name);
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

  // In-memory roster of talkgroups the SDR bridge has HEARD on Scan All, per
  // agency. The SDR bridge is the only place that knows a call's numeric
  // talkgroup id (the transmission log stores only the alias + radio id), so it
  // POSTs what it hears here every ~30s and the console offers a "discovered →
  // add" picker from it. Ephemeral and best-effort: not persisted, pruned by
  // age, capped per agency — losing it just means waiting for the next report.
  interface ObservedTg {
    label: string;
    count: number;
    lastHeardMs: number;
  }
  const observedTalkgroups = new Map<number, Map<number, ObservedTg>>(); // agencyId -> tgid -> info
  const OBSERVED_TTL_MS = 60 * 60 * 1000; // forget a talkgroup not heard in an hour
  const OBSERVED_MAX = 500; // per-agency cap

  function recordObserved(agencyId: number, items: Array<Record<string, unknown>>) {
    let roster = observedTalkgroups.get(agencyId);
    if (!roster) {
      roster = new Map();
      observedTalkgroups.set(agencyId, roster);
    }
    const now = Date.now();
    for (const it of items) {
      const tgid = Number(it.tgid);
      if (!Number.isInteger(tgid) || tgid <= 0) continue;
      const prev = roster.get(tgid);
      const label = String(it.label ?? prev?.label ?? `TG ${tgid}`).slice(0, 80);
      const count = Math.max(1, Math.round(Number(it.count) || prev?.count || 1));
      const lastHeardMs = Number(it.lastHeardMs) || now;
      roster.set(tgid, { label, count, lastHeardMs });
    }
    for (const [tgid, info] of roster) if (now - info.lastHeardMs > OBSERVED_TTL_MS) roster.delete(tgid);
    if (roster.size > OBSERVED_MAX) {
      const keep = [...roster.entries()].sort((a, b) => b[1].lastHeardMs - a[1].lastHeardMs).slice(0, OBSERVED_MAX);
      roster.clear();
      for (const [tgid, info] of keep) roster.set(tgid, info);
    }
  }

  router.get("/admin/bridges", requireAdmin, async (req, res) => {
    try {
      res.json({ bridges: await listBridges(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  // The SDR bridge reports the talkgroups it has heard on Scan All here.
  router.post("/admin/bridges/observed", requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const list = Array.isArray(body.talkgroups) ? body.talkgroups : [];
      recordObserved(req.authUser!.agencyId!, list as Array<Record<string, unknown>>);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // Talkgroups heard on Scan All that DON'T already have a bridge — the console's
  // "discovered, click to add" list. Already-bridged ones (mount /tg<id>) are
  // filtered out so the picker shows only what you're missing.
  router.get("/admin/bridges/observed", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const now = Date.now();
      const bridged = new Set<number>();
      for (const bridge of await listBridges(agencyId)) {
        const match = String(bridge.source_url ?? "").match(/\/tg(\d+)\/?$/i);
        if (match) bridged.add(Number(match[1]));
      }
      const roster = observedTalkgroups.get(agencyId);
      const talkgroups = roster
        ? [...roster.entries()]
            .filter(([tgid, info]) => !bridged.has(tgid) && now - info.lastHeardMs <= OBSERVED_TTL_MS)
            .sort((a, b) => b[1].lastHeardMs - a[1].lastHeardMs)
            .map(([tgid, info]) => ({ tgid, label: info.label, count: info.count, lastHeard: info.lastHeardMs }))
        : [];
      res.json({ talkgroups });
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
        noiseSuppression: oneOf(body.noiseSuppression, BRIDGE_NOISE_LEVELS, "off"),
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
      if (body.noiseSuppression !== undefined)
        patch.noiseSuppression = oneOf(body.noiseSuppression, BRIDGE_NOISE_LEVELS, "off");
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

  // --- AI dispatcher knowledge base (admin-uploaded reference docs) ------

  router.get("/admin/kb/documents", requireAdmin, async (req, res) => {
    try {
      res.json({
        documents: await listKbDocuments(req.authUser!.agencyId!),
        categories: KB_CATEGORIES,
        category_sections: KB_CATEGORY_SECTIONS,
        embed_model: getEmbeddingModelName(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post(
    "/admin/kb/documents",
    requireAdmin,
    raw({ type: () => true, limit: KB_MAX_DOC_BYTES }),
    async (req, res) => {
      try {
        const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (mime !== "application/pdf") {
          res.status(415).json({ error: "pdf_only" });
          return;
        }
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "missing_file" });
          return;
        }
        const filename =
          typeof req.query.filename === "string" ? req.query.filename.trim().slice(0, 255) : null;
        const title =
          (typeof req.query.title === "string" ? req.query.title.trim() : "").slice(0, 255) ||
          filename ||
          "Untitled document";
        const categoryRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";
        const category = isKbCategory(categoryRaw) ? categoryRaw : "other";
        const propertyCode =
          typeof req.query.property_code === "string" && req.query.property_code.trim()
            ? req.query.property_code.trim().slice(0, 32)
            : null;

        const agencyId = req.authUser!.agencyId!;
        const doc = await createKbDocument(agencyId, {
          title,
          category,
          propertyCode,
          filename,
          mime,
          content: body,
          uploadedByUserId: req.authUser!.id,
        });
        enqueueKbIngest(doc.id);
        await writeAudit({
          agencyId,
          actorUserId: req.authUser!.id,
          actorName: req.authUser!.username,
          action: "kb_document_upload",
          target: String(doc.id),
          detail: { title, category, property_code: propertyCode, bytes: body.length },
          ip: clientIp(req),
        });
        res.status(201).json({ document: doc });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.get("/admin/kb/documents/:id/file", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const doc = await getKbDocumentContent(req.authUser!.agencyId!, id);
      if (!doc) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", doc.mime);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(doc.filename ?? `document-${id}.pdf`).replace(/"/g, "")}"`,
      );
      res.send(doc.content);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/kb/documents/:id/reindex", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const agencyId = req.authUser!.agencyId!;
      if (!Number.isInteger(id) || !(await kbDocumentExists(agencyId, id))) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      enqueueKbIngest(id);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "kb_document_reindex",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/kb/documents/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const agencyId = req.authUser!.agencyId!;
      const ok = await deleteKbDocument(agencyId, id);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "kb_document_delete",
        target: String(id),
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

  /**
   * GET /admin/agency — current agency settings the admin role can read
   * (default codec for new channels, etc.). Sister of the owner-only
   * PATCH /owner/agencies/:id endpoint, scoped to the caller's own agency.
   */
  router.get("/admin/agency", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const agency = await getAgencyById(agencyId);
      if (!agency) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Only return the fields an agency admin should see — the radio
      // key + disabled flag stay owner-only.
      res.json({
        agency: {
          id: agency.id,
          name: agency.name,
          slug: agency.slug,
          defaultCodec: agency.default_codec,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * PATCH /admin/agency — let an agency admin change their own agency's
   * default codec (applied to newly-created channels). Mirrors the
   * channel PATCH validation pattern from PR #210.
   */
  router.patch("/admin/agency", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const patch: { defaultCodec?: VoiceCodec } = {};
      if (req.body?.defaultCodec !== undefined) {
        if (!isVoiceCodec(req.body.defaultCodec)) {
          res.status(400).json({ error: "bad_codec" });
          return;
        }
        patch.defaultCodec = req.body.defaultCodec;
      }
      const agency = await updateAgency(agencyId, patch);
      if (!agency) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "agency_settings_update",
        target: agency.name,
        detail: { fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({
        agency: {
          id: agency.id,
          name: agency.name,
          slug: agency.slug,
          defaultCodec: agency.default_codec,
        },
      });
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

  // --- admin: user permission templates ----------------------------------

  function parseTemplateMembershipBody(raw: unknown): { channel_id: number; permission: Permission }[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: { channel_id: number; permission: Permission }[] = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const channelId = Number((row as { channelId?: unknown; channel_id?: unknown }).channelId
        ?? (row as { channel_id?: unknown }).channel_id);
      const permission = asPermission((row as { permission?: unknown }).permission);
      if (!Number.isFinite(channelId) || !permission) {
        continue;
      }
      out.push({ channel_id: channelId, permission });
    }
    return out;
  }

  router.get("/admin/user-templates", requireAdmin, async (req, res) => {
    try {
      res.json({ templates: await listUserPermissionTemplates(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/user-templates", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const name = String(req.body?.name ?? "").trim();
      const memberships = parseTemplateMembershipBody(req.body?.memberships);
      if (!name) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const template = await createUserPermissionTemplate(agencyId, name, memberships);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_template_create",
        target: name,
        detail: { templateId: template.id, channels: memberships.length },
        ip: clientIp(req),
      });
      res.status(201).json({ template });
    } catch (error) {
      if (error instanceof Error && error.message.includes("duplicate key")) {
        res.status(409).json({ error: "template_name_taken" });
        return;
      }
      fail(res, error);
    }
  });

  router.patch("/admin/user-templates/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const patch: { name?: string; memberships?: { channel_id: number; permission: Permission }[] } = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) {
          res.status(400).json({ error: "missing_fields" });
          return;
        }
        patch.name = name;
      }
      if (req.body?.memberships !== undefined) {
        patch.memberships = parseTemplateMembershipBody(req.body.memberships);
      }
      const template = await updateUserPermissionTemplate(id, agencyId, patch);
      if (!template) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_template_update",
        target: template.name,
        detail: { templateId: template.id },
        ip: clientIp(req),
      });
      res.json({ template });
    } catch (error) {
      if (error instanceof Error && error.message.includes("duplicate key")) {
        res.status(409).json({ error: "template_name_taken" });
        return;
      }
      fail(res, error);
    }
  });

  router.delete("/admin/user-templates/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const existing = await getUserPermissionTemplate(id, agencyId);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await deleteUserPermissionTemplate(id, agencyId);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_template_delete",
        target: existing.name,
        detail: { templateId: id },
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/user-templates/:id/apply", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const templateId = Number(req.params.id);
      const userId = Number(req.body?.userId);
      if (!Number.isFinite(templateId) || !Number.isFinite(userId)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const template = await getUserPermissionTemplate(templateId, agencyId);
      if (!template) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const result = await applyUserPermissionTemplate(templateId, userId, agencyId);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_template_apply",
        target: `user:${userId}`,
        detail: { templateId, templateName: template.name, ...result },
        ip: clientIp(req),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof Error && error.message === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
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

  // --- voice-link telemetry ------------------------------------------------
  //
  // Counters-only report a client emits roughly every 30 s describing its
  // inbound voice link quality (jitter buffer underruns, PLC frames
  // synthesized, decode failures, frames received per codec, talk-spurt
  // count). The admin "Link Health" dashboard reads aggregates back so an
  // operator can answer "is unit 42 having voice problems?" with data
  // instead of trusting an end-user report. The POST body is intentionally
  // tiny (≤ ~500 bytes typical; capped at 4 KB by the validator) so the
  // telemetry channel itself doesn't add measurable cellular cost — the
  // whole point of this surface is to SAVE data by enabling triage.
  router.post("/telemetry/voice-link", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Two auth paths: signed-in account (JWT) or the legacy handset path
      // (x-radio-key + a unit id in the body). Either resolves the agency we
      // bill the row to. We do NOT trust the body's `agency` field; a client
      // that claims to belong to a different tenant than its auth says is
      // silently rebilled to its real one.
      let agencyId: number | null = null;
      let unitId: string | null = null;
      if (req.authUser?.agencyId != null) {
        agencyId = req.authUser.agencyId;
        // For `radio` accounts, lock the report to the unit id baked into
        // the JWT — a radio must never be able to bill a report against
        // another unit id. Admins and dispatchers can report on behalf of
        // any unit in their agency (a dispatch console is multi-unit on
        // purpose), so they pick the unit from the body and fall back to
        // their own JWT unitId.
        if (req.authUser.role === "radio") {
          unitId = req.authUser.unitId ?? null;
        } else {
          const bodyUnit = typeof body.unitId === "string" ? body.unitId.trim() : "";
          unitId = bodyUnit || req.authUser.unitId || null;
        }
      } else {
        const headerRaw = req.headers["x-radio-key"];
        const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
        const key = headerVal ?? (typeof req.query.key === "string" ? req.query.key : null);
        const agency = await resolveAgencyByKey(key ?? null, radioApiKey).catch(() => null);
        if (!agency) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        agencyId = agency.id;
        const bodyUnit = typeof body.unitId === "string" ? body.unitId.trim() : "";
        if (!bodyUnit) {
          res.status(400).json({ error: "missing_unit_id" });
          return;
        }
        unitId = bodyUnit;
      }
      if (!unitId) {
        res.status(400).json({ error: "missing_unit_id" });
        return;
      }
      const parsed = parseVoiceLinkTelemetryBody(body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const channel = typeof body.channel === "string" ? body.channel.trim().slice(0, 128) : null;
      const rawClientType = typeof body.clientType === "string" ? body.clientType : null;
      const clientType = rawClientType ? normalizeClientType(rawClientType) ?? null : null;
      const insert: VoiceLinkTelemetryInsert = {
        agencyId,
        unitId: unitId.slice(0, 64),
        channel: channel || null,
        clientType,
        counters: parsed.counters,
        codecBreakdown: parsed.codecBreakdown,
        // Web console only: window ran in a hidden, timer-throttled tab, so
        // its PLC/underrun counters describe browser throttling, not the link.
        tabHidden: body.tabHidden === true,
        clientTs: parsed.clientTs,
        appVersionName: parsed.appVersionName,
        appVersionCode: parsed.appVersionCode,
      };
      if (getPool() == null) {
        // No DB configured: accept-and-drop so the client's reporter loop
        // doesn't retry forever in local dev / DB-less smoke tests. The 202
        // distinguishes this from a normal 200 so a curious caller sees it
        // was a soft drop, not a persisted insert.
        res.status(202).json({ ok: true, persisted: false });
        return;
      }
      await insertVoiceLinkTelemetry(insert);
      res.json({ ok: true, persisted: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/admin/voice-link-telemetry", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const sinceMs = clampNumber(req.query.since, 60_000, 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
      const channel =
        typeof req.query.channel === "string" && req.query.channel.trim()
          ? req.query.channel.trim()
          : undefined;
      const [units, versions] = await Promise.all([
        listVoiceLinkUnitSummaries(agencyId, sinceMs, channel),
        listLatestAppVersionsByUnit(agencyId, sinceMs),
      ]);
      const versionByUnit = new Map(versions.map((v) => [v.unit_id, v]));
      const unitsWithVersion = units.map((u) => {
        const v = versionByUnit.get(u.unit_id);
        return {
          ...u,
          app_version_name: v?.app_version_name ?? null,
          app_version_code: v?.app_version_code ?? null,
        };
      });
      res.json({ units: unitsWithVersion, sinceMs });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/admin/voice-link-telemetry/:unitId", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const rawUnit = String(req.params.unitId ?? "").trim();
      if (!rawUnit) {
        res.status(400).json({ error: "missing_unit_id" });
        return;
      }
      const sinceMs = clampNumber(req.query.since, 60_000, 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
      const channel =
        typeof req.query.channel === "string" && req.query.channel.trim()
          ? req.query.channel.trim()
          : undefined;
      const windows = await listVoiceLinkUnitTimeseries(agencyId, rawUnit, sinceMs, channel);
      // SQL returns newest-first; the chart wants chronological order so the
      // X axis reads left → right. Reverse here so every consumer sees the
      // same order without each having to remember.
      windows.reverse();
      res.json({ unit: rawUnit, windows, sinceMs });
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
      // Hard-cap the transcript search query at 200 chars so a malicious or
      // accidental megabyte-long `search` param can't blow up either the
      // ILIKE pattern length or the JSON parser. The store layer already
      // escapes `%`, `_`, `\` and parameterises the binding (see `listTransmissions`
      // in store.ts) so SQL-special characters in `search` are safe; this
      // guard is purely about bounded resource use.
      const rawSearch = str(req.query.search);
      const search = rawSearch === undefined ? undefined : rawSearch.slice(0, 200);
      const opts = {
        agencyId,
        limit: Number(req.query.limit ?? 100),
        search,
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
      // Whitelist + length-cap the platform tag so a malformed client can't
      // pollute the radio_positions table with garbage. See `clientType.ts`
      // for the allow-list (and the matching unit tests in
      // `tests/clientType.test.ts`).
      const clientType = normalizeClientType(body.client_type);
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
        clientType,
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
      const activity = getAiActivity(radioAgencyId(req), channel);
      const ai_activity = activity
        ? {
            phase: activity.phase,
            unit: activity.unitId,
            // True when this poll's radio is the unit she's responding to.
            for_you: activity.unitId === unit,
            text: activity.text ?? null,
            // Clean, screen-friendly form (no phonetics); clients prefer this
            // over `text` for display. Plate/VIN returns also carry the literal
            // plate + full VIN so the handset can render "8ABC123" and bold the
            // last six of the VIN instead of the spelled-out TTS.
            display_text: activity.displayText ?? null,
            plate: activity.plate ?? null,
            vin: activity.vin ?? null,
            tag: activity.tag ?? null,
          }
        : null;
      res.json({ alerts, lastId, ten33, ai_activity });
    } catch (error) {
      fail(res, error);
    }
  });

  // Picture attachment for a page, fetched lazily by handsets (radio-key auth).
  router.get("/radio/alerts/:id/image", async (req, res) => {
    try {
      const record = await getAlertImage(Number(req.params.id), radioAgencyId(req));
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(record.image);
    } catch (error) {
      fail(res, error);
    }
  });

  // Radio reply to a page — an ACK or a short canned response. Radio-key auth.
  router.post("/radio/alerts/:id/ack-response", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unit = String(body.unit ?? body.unit_id ?? "").trim().toUpperCase();
      const response = String(body.response ?? "").trim().slice(0, 60);
      if (!unit || !response) {
        res.status(400).json({ error: "missing_unit_or_response" });
        return;
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      const row = await addAlertResponse(radioAgencyId(req), id, unit, response);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(201).json({ response: row });
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
      const elevenKey = await resolveElevenLabsApiKey(agencyId);
      const voiceId = await resolveElevenLabsVoiceId(agencyId);
      const promptSource = await agencyPromptSource(agencyId);
      const wakeWord = await resolveAiDispatchWakeWord(agencyId);
      res.json({
        platform_enabled: platform.enabled,
        platform_llm_configured: platform.llmConfigured,
        agency_tts_configured: !!elevenKey && !!voiceId,
        agency_prompt_configured: promptSource !== "railway_default",
        agency_prompt_source: promptSource,
        model: platform.model,
        dispatch_unit_id: platform.dispatchUnitId,
        // Supervised wake phrase (default "hey ai"); drives the server matcher and the on-device gate.
        agency_wake_word: wakeWord,
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
      // Accept the new three-way `mode` ("off"|"supervised"|"full_auto");
      // fall back to the legacy `enabled` boolean for older clients.
      const mode = normalizeAiDispatchMode(
        body.mode !== undefined ? body.mode : body.enabled,
      );
      const enabled = aiDispatchModeEnabled(mode);
      const agencyId = req.authUser!.agencyId!;
      if (enabled && !(await agencyAllowsAiDispatch(agencyId))) {
        res.status(403).json({ error: "ai_dispatch_requires_pro" });
        return;
      }
      await setChannelAiDispatch(agencyId, channel, mode);
      const { notifyChannelAiDispatchListenPcm } = await import("./voiceRelay.js");
      notifyChannelAiDispatchListenPcm(agencyId, channel, enabled);
      await writeAudit({
        agencyId: req.authUser!.agencyId!,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: enabled ? "ai_dispatch_on" : "ai_dispatch_off",
        target: `${channel} (${mode})`,
        ip: clientIp(req),
      });
      res.json({ ok: true, enabled, mode });
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
      res.json({ enabled: row?.enabled === true, mode: row?.mode ?? "off" });
    } catch (error) {
      fail(res, error);
    }
  });

  // Admin: set the agency's supervised wake phrase (default "hey ai"). Validated to a short
  // spoken phrase so the on-device keyword-spotter and the server matcher stay sane.
  router.post("/ai-dispatch/wake-word", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const wakeWord = normalizeWakeWord(body.wake_word);
      if (
        wakeWord.length < 2 ||
        wakeWord.length > 32 ||
        !/^[a-z][a-z '-]*[a-z]$/.test(wakeWord)
      ) {
        res.status(400).json({ error: "invalid_wake_word" });
        return;
      }
      await setAgencyIntegrationValue(agencyId, "ai_dispatch_wake_word", wakeWord, req.authUser!.id);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "ai_dispatch_wake_word",
        target: wakeWord,
        ip: clientIp(req),
      });
      res.json({ ok: true, wake_word: wakeWord });
    } catch (error) {
      fail(res, error);
    }
  });

  // Admin: type-to-dispatch test page. Runs the full parse / KB / plate / 10-8
  // body-building pipeline against the typed transcript. Side-effects (10-8
  // POSTs) only happen when sendForReal === true; TTS is always preview-only
  // (the dispatcher never keys the radio channel from this endpoint).
  router.post("/ai-dispatch/test", requireAgencyOperator, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const transcript = String(body.transcript ?? "").trim();
      const channelName = String(body.channelName ?? body.channel ?? "test-channel").trim();
      const unitId = String(body.unitId ?? body.unit ?? "352").trim();
      const sendForReal = body.sendForReal === true;
      const synthesizeTts = body.synthesizeTts !== false;
      if (!transcript) {
        res.status(400).json({ error: "missing_transcript" });
        return;
      }
      const result = await runAiDispatchDryRun({
        agencyId: req.authUser!.agencyId!,
        transcript,
        channelName,
        unitId,
        sendForReal,
        synthesizeTts,
      });
      if (sendForReal) {
        await writeAudit({
          agencyId: req.authUser!.agencyId!,
          actorUserId: req.authUser!.id,
          actorName: req.authUser!.username,
          action: "ai_dispatch_test_send_for_real",
          target: channelName,
          ip: clientIp(req),
        });
      }
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  // Per-function 10-8 CAD API tester (Admin → AI test page). Exercises one
  // v1.1.0 endpoint at a time and returns the raw upstream response. Reads run
  // live; writes shadow unless the agency has live CAD writes enabled (handled
  // inside ten8Fetch — surfaced here as `shadow: true`).
  router.post("/integrations/ten8/api-test", requireAgencyOperator, async (req, res) => {
    try {
      const agencyId = req.authUser?.agencyId;
      if (agencyId == null) {
        res.status(401).json({ error: "no_agency" });
        return;
      }
      const body = (req.body ?? {}) as { action?: unknown; params?: unknown };
      const action = String(body.action ?? "").trim();
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (!action) {
        res.status(400).json({ error: "missing_action" });
        return;
      }
      if (!(await ten8Configured(agencyId))) {
        res.status(400).json({
          error: "ten8_not_configured",
          message: "Add the 10-8 CAD API key and secret under Admin → Integrations first.",
        });
        return;
      }

      const str = (v: unknown): string =>
        typeof v === "string" ? v.trim() : v == null ? "" : String(v);
      const num = (v: unknown): number | null => {
        if (typeof v === "number") {
          return Number.isFinite(v) ? v : null;
        }
        const s = str(v).replace(/[^0-9-]/g, "");
        if (!s) {
          return null;
        }
        const n = Number.parseInt(s, 10);
        return Number.isFinite(n) ? n : null;
      };
      // Keep only the listed keys with non-empty values (kept as strings; the
      // search/query helpers send them as query params).
      const pick = (keys: string[]): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          const val = str(params[k]);
          if (val) {
            out[k] = val;
          }
        }
        return out;
      };
      const lookup = str(params.lookup);
      const requireLookup = (): boolean => {
        if (lookup) {
          return true;
        }
        res.status(400).json({
          error: "missing_lookup",
          message: "lookup (incident id, number, or UUID) is required for this action",
        });
        return false;
      };
      const requireNum = (key: string): number | null => {
        const n = num(params[key]);
        if (n == null) {
          res.status(400).json({ error: `missing_${key}`, message: `${key} (number) is required` });
        }
        return n;
      };

      let result: { ok: boolean; shadow?: boolean; status?: number; data?: unknown };

      switch (action) {
        case "health":
          result = await ten8Health(agencyId);
          break;
        case "list_incidents":
          result = await ten8ListIncidents(agencyId, {
            from: num(params.from) ?? undefined,
            to: num(params.to) ?? undefined,
            field: str(params.field) || undefined,
          });
          break;
        case "get_incident":
          if (!requireLookup()) {
            return;
          }
          result = await ten8GetIncident(agencyId, lookup);
          break;
        case "search_persons": {
          const sp = pick([
            "q",
            "firstName",
            "lastName",
            "dob",
            "phone",
            "stateIDNumber",
            "sex",
            "race",
            "limit",
          ]);
          if (Object.keys(sp).length === 0) {
            res.status(400).json({
              error: "missing_search",
              message: "at least one person search parameter is required",
            });
            return;
          }
          result = await ten8SearchPersons(agencyId, sp);
          break;
        }
        case "search_vehicles": {
          const sv = pick([
            "q",
            "license",
            "vin",
            "make",
            "model",
            "color",
            "state",
            "type",
            "year",
            "limit",
          ]);
          if (Object.keys(sv).length === 0) {
            res.status(400).json({
              error: "missing_search",
              message: "at least one vehicle search parameter is required",
            });
            return;
          }
          result = await ten8SearchVehicles(agencyId, sv);
          break;
        }
        case "add_vehicle": {
          if (!requireLookup()) {
            return;
          }
          const vehicle = pick(["license", "vin", "state", "type", "make", "model", "color"]);
          const year = num(params.year);
          if (year != null) {
            vehicle.year = year;
          }
          if (Object.keys(vehicle).length === 0) {
            res.status(400).json({
              error: "missing_vehicle",
              message: "at least one vehicle field is required",
            });
            return;
          }
          const notes = str(params.notes);
          result = await ten8AddVehicle(
            agencyId,
            lookup,
            notes ? { notes, vehicle } : { vehicle },
          );
          break;
        }
        case "remove_vehicle": {
          if (!requireLookup()) {
            return;
          }
          const vehicleId = requireNum("vehicleId");
          if (vehicleId == null) {
            return;
          }
          result = await ten8RemoveVehicle(agencyId, lookup, vehicleId);
          break;
        }
        case "add_person": {
          if (!requireLookup()) {
            return;
          }
          const person = pick([
            "firstName",
            "middleName",
            "lastName",
            "alias",
            "dob",
            "address",
            "city",
            "state",
            "zip",
            "phone",
            "sex",
            "race",
          ]);
          const personId = num(params.personId);
          if (personId == null && Object.keys(person).length === 0) {
            res.status(400).json({
              error: "missing_person",
              message: "personId or at least one person field is required",
            });
            return;
          }
          const payload: Record<string, unknown> = {};
          if (personId != null) {
            payload.personId = personId;
          } else {
            payload.person = person;
          }
          const relation = str(params.relation);
          const notes = str(params.notes);
          if (relation) {
            payload.relation = relation;
          }
          if (notes) {
            payload.notes = notes;
          }
          result = await ten8AddPerson(agencyId, lookup, payload);
          break;
        }
        case "remove_person": {
          if (!requireLookup()) {
            return;
          }
          const personId = requireNum("personId");
          if (personId == null) {
            return;
          }
          result = await ten8RemovePerson(agencyId, lookup, personId);
          break;
        }
        case "add_tag": {
          if (!requireLookup()) {
            return;
          }
          const tag = str(params.tag);
          const tagId = num(params.tagId);
          if (!tag && tagId == null) {
            res.status(400).json({ error: "missing_tag", message: "tag (name) or tagId is required" });
            return;
          }
          const payload: Record<string, unknown> = {};
          if (tagId != null) {
            payload.tagId = tagId;
          }
          if (tag) {
            payload.tag = tag;
          }
          result = await ten8AddTag(agencyId, lookup, payload);
          break;
        }
        case "remove_tag": {
          if (!requireLookup()) {
            return;
          }
          const tagId = requireNum("tagId");
          if (tagId == null) {
            return;
          }
          result = await ten8RemoveTag(agencyId, lookup, tagId);
          break;
        }
        case "add_comment": {
          if (!requireLookup()) {
            return;
          }
          const comment = str(params.comment);
          if (!comment) {
            res.status(400).json({ error: "missing_comment", message: "comment text is required" });
            return;
          }
          result = await ten8AddComment(agencyId, lookup, comment);
          break;
        }
        case "update_comment": {
          if (!requireLookup()) {
            return;
          }
          const commentId = requireNum("commentId");
          if (commentId == null) {
            return;
          }
          const comment = str(params.comment);
          if (!comment) {
            res.status(400).json({ error: "missing_comment", message: "comment text is required" });
            return;
          }
          result = await ten8UpdateComment(agencyId, lookup, commentId, comment);
          break;
        }
        case "create_incident": {
          const type = str(params.type);
          if (!type) {
            res.status(400).json({ error: "missing_type", message: "type (call type) is required" });
            return;
          }
          const payload = pick([
            "type",
            "summary",
            "priority",
            "location",
            "streetAddress",
            "city",
            "state",
            "zip",
            "county",
            "units",
            "dispatcher",
          ]);
          result = await ten8CreateIncident(agencyId, payload);
          break;
        }
        default:
          res.status(400).json({ error: "unknown_action", message: `unknown action: ${action}` });
          return;
      }

      res.json({
        ok: result.ok,
        status: result.status ?? null,
        shadow: result.shadow === true,
        data: result.data ?? null,
        hosts: await ten8ResolvedHosts(agencyId),
      });
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

  // Live positions for the agency. Reachable by a console JWT or a read-only
  // location key (see resolveLocationReadAgency). `?since=<iso>` returns only
  // units whose fix changed after that time — the delta a polling map uses.
  router.get("/locations", async (req, res) => {
    try {
      const access = await resolveLocationReadAgency(req);
      if ("status" in access) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      res.json({ positions: await listPositions(access.agencyId, since) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/ten8/map-incidents", requireAgencyMember, async (req, res) => {
    try {
      const incidents = await listTen8MapIncidents(req.authUser!.agencyId!);
      res.json({ incidents });
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
  // Same dual auth as GET /locations (console JWT or read-only location key).
  router.get("/locations/history", async (req, res) => {
    try {
      const access = await resolveLocationReadAgency(req);
      if ("status" in access) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      const unit = String(req.query.unit ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const samples = await listPositionHistory({
        agencyId: access.agencyId,
        unitId: unit,
        from,
        to,
      });
      res.json({ unit, samples });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: read-only location-feed key (external map integrations) -----
  // The key authenticates GET /locations + /locations/history only — never
  // PTT, admin, or any write. An agency admin issues/rotates/revokes it; hand
  // it to an external patrol-map (e.g. GateGuard) so it polls positions
  // server-side without a full operator login.
  router.get("/admin/location-key", requireAdmin, async (req, res) => {
    try {
      const agency = await getAgencyById(req.authUser!.agencyId!);
      res.json({ location_read_key: agency?.location_read_key ?? null });
    } catch (error) {
      fail(res, error);
    }
  });

  // Issue or rotate the key (rotating invalidates the previous one immediately).
  router.post("/admin/location-key", requireAdmin, async (req, res) => {
    try {
      const key = generateRadioKey();
      await setLocationReadKey(req.authUser!.agencyId!, key);
      res.json({ location_read_key: key });
    } catch (error) {
      fail(res, error);
    }
  });

  // Revoke the key — external map access stops, handsets are unaffected.
  router.delete("/admin/location-key", requireAdmin, async (req, res) => {
    try {
      await setLocationReadKey(req.authUser!.agencyId!, null);
      res.json({ ok: true });
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
      const counts = unitChannelCounts(agencyId);
      const locked = withRosterMoveLock(members, counts);
      res.json({ members: await annotateRosterStatus(agencyId, channel, locked) });
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

  // Live Channel Control: delete an emergency channel by id.
  // The store layer enforces that the channel is still emergency-named at
  // delete-time to prevent stale UI confirmations from deleting renamed
  // operational channels.
  router.delete("/channels/emergency/:id", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const id = Number(req.params.id);
      const result = await deleteEmergencyChannel(id, agencyId);
      if (result.status === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (result.status === "not_emergency") {
        res.status(409).json({ error: "not_emergency_channel" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_delete",
        target: String(id),
        detail: { emergency: true, channel: result.name },
        ip: clientIp(req),
      });
      res.json({ ok: true });
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
      if (isUnitMoveLocked(agencyId, unit)) {
        res.status(409).json({
          error: "unit_move_locked",
          message:
            "This operator has the dispatch console open on multiple channels and cannot be moved.",
        });
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

  // Online roster: unit IDs of this agency with a live voice socket right now.
  // Backs the safeT Control "who's reachable for a remote command" view.
  router.get("/admin/online-units", requireAdmin, async (req, res) => {
    try {
      res.json({ units: listOnlineUnits(req.authUser!.agencyId!) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Remote device command: an admin pushes a control command to one handset
  // over its live voice socket. Admin-only, agency-scoped, and audited. The
  // handset replies with a `device_ack` frame which is logged separately.
  router.post("/admin/device-command", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const unit = String(req.body?.unit_id ?? "").trim().toUpperCase();
      const command = String(req.body?.command ?? "").trim();
      const rawParams = req.body?.params;
      const params =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : null;
      if (!unit || !command) {
        res.status(400).json({ error: "missing_unit_or_command" });
        return;
      }
      if (!DEVICE_COMMANDS.has(command)) {
        res.status(400).json({ error: "unknown_command" });
        return;
      }
      const commandId = randomUUID();
      const reached = sendDeviceCommand(agencyId, unit, command, params, commandId);
      await writeAudit({
        agencyId,
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "device_command",
        target: `unit:${unit} command:${command}`,
        detail: { unit, command, params, commandId, reached },
        ip: clientIp(req),
      });
      if (reached === 0) {
        res.status(409).json({ error: "unit_offline", commandId });
        return;
      }
      res.json({ ok: true, reached, commandId });
    } catch (error) {
      fail(res, error);
    }
  });

  // Recent device-command acks for a unit (remote diagnostics view): the
  // handset's replies to admin commands, newest first.
  router.get("/admin/device-acks/:unitId", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const unit = String(req.params.unitId ?? "").trim();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const limit = Number(req.query.limit ?? 20);
      res.json({ acks: await listDeviceAcks(agencyId, unit, Number.isFinite(limit) ? limit : 20) });
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

  // Attach a picture to a page (compose side). Two-step: POST /alerts returns an
  // id, then this PUTs the raw image bytes. Same dispatcher/admin gate as paging.
  router.put(
    "/alerts/:id/image",
    requireAgencyMember,
    raw({ type: () => true, limit: ALERT_IMAGE_MAX_BYTES }),
    async (req, res) => {
      try {
        const me = req.authUser!;
        if (me.role !== "admin" && me.role !== "dispatcher") {
          res.status(403).json({ error: "forbidden" });
          return;
        }
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
        const ok = await setAlertImage(Number(req.params.id), me.agencyId!, body, mime);
        if (!ok) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.json({ ok: true, mime, byte_size: body.length });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  // Console-side image fetch (dispatch history). Handsets use the radio-scoped
  // GET /radio/alerts/:id/image below.
  router.get("/alerts/:id/image", requireAgencyMember, async (req, res) => {
    try {
      const record = await getAlertImage(Number(req.params.id), req.authUser!.agencyId!);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(record.image);
    } catch (error) {
      fail(res, error);
    }
  });

  // Dispatcher view of radio replies to pages (recent, agency-scoped).
  router.get("/alerts/responses", requireAgencyMember, async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 200);
      res.json({
        responses: await listAlertResponses(
          req.authUser!.agencyId!,
          Number.isFinite(limit) ? limit : 200,
        ),
      });
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

  // Emergency lifecycle: acknowledge (first acknowledger wins) then resolve.
  // Both are agency-scoped — an id outside the caller's agency reads as 404.
  router.post("/alerts/:id/ack", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const outcome = await acknowledgeEmergency(id, agencyId, me.id);
      if (outcome.status === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (outcome.status === "conflict") {
        res.status(409).json({ error: outcome.reason, state: outcome.current });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "alert_acknowledge",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ alert: outcome.alert });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/alerts/:id/resolve", requireAgencyMember, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const outcome = await resolveEmergency(id, agencyId, me.id, me.displayName);
      if (outcome.status === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (outcome.status === "conflict") {
        res.status(409).json({ error: outcome.reason, state: outcome.current });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "alert_resolve",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ alert: outcome.alert });
    } catch (error) {
      fail(res, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Global audio config — apply Audio Lab settings agency-wide
  // ---------------------------------------------------------------------------

  /** GET /v1/admin/audio-config — admin: read current agency-wide audio config */
  router.get("/admin/audio-config", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const row = await getGlobalAudioConfig(agencyId);
      res.json({
        config: row?.config ?? null,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by_username ?? null,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /** PUT /v1/admin/audio-config — admin: push new agency-wide audio config */
  router.put("/admin/audio-config", requireAdmin, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      // The web client sends the AudioLabConfig directly as the JSON body
      // (no { config: ... } wrapper). Validate the expected top-level shape so
      // a malformed payload fails loudly rather than silently storing a partial
      // tree that downstream readers fill with defaults.
      const config = req.body;
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        typeof (config as { preImbe?: unknown }).preImbe !== "object" ||
        typeof (config as { postDecode?: unknown }).postDecode !== "object" ||
        typeof (config as { vocoder?: unknown }).vocoder !== "object"
      ) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const row = await setGlobalAudioConfig(agencyId, config, me.id, me.username);
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "audio_config_push",
        target: "global",
        ip: clientIp(req),
      });
      res.json({
        ok: true,
        config: row.config,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by_username,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * GET /v1/audio/config — any authenticated agency member.
   * Returns a device-oriented summary derived from the global audio config so
   * Android/iOS clients can apply agency-wide AGC and noise-suppression settings
   * without needing to understand the full AudioLabConfig schema.
   */
  router.get("/audio/config", requireAgencyMember, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const row = await getGlobalAudioConfig(agencyId);
      if (!row) {
        res.json({ config: null, updatedAt: null });
        return;
      }
      // The full AudioLabConfig → device-facing summary mapping lives in
      // `audioConfig.ts` (and is unit-tested in `tests/audioConfig.test.ts`)
      // so a regression in the bypass/AGC/wind-noise derivation can't sneak
      // through without a test failure.
      const summary = deriveDeviceAudioConfig(row.config);
      res.json({
        config: summary,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Audio Lab presets — admin-saved named snapshots of the AudioLabConfig.
  // Loading a preset writes the body back through the existing
  // PUT /v1/admin/audio-config path so live-apply behaviour is unchanged.
  // ---------------------------------------------------------------------------

  /** GET /v1/admin/audio-lab-presets — list every saved preset (config body
   *  is read in the same SQL but only its derived summary is returned, so
   *  the JSON payload stays small even on a large catalogue). */
  router.get("/admin/audio-lab-presets", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const rows = await listAudioLabPresets(agencyId);
      const presets = rows.map((r) => ({
        name: r.name,
        updatedAt: r.updated_at,
        summary: summarizePreset(r.config),
      }));
      res.json({ presets });
    } catch (error) {
      fail(res, error);
    }
  });

  /** GET /v1/admin/audio-lab-presets/:name — read one preset's full config. */
  router.get("/admin/audio-lab-presets/:name", requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId!;
      const name = String(req.params.name ?? "").trim();
      if (!isValidPresetName(name)) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      const row = await getAudioLabPreset(agencyId, name);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        name: row.name,
        config: row.config,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /** PUT /v1/admin/audio-lab-presets/:name — upsert from an AudioLabConfig body. */
  router.put("/admin/audio-lab-presets/:name", requireAdmin, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const name = String(req.params.name ?? "").trim();
      if (!isValidPresetName(name)) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      // Mirror the PUT /v1/admin/audio-config validation: the body is the
      // raw AudioLabConfig (no { config: ... } wrapper). Rejecting a malformed
      // body here means a corrupt preset never sneaks into the agency catalog.
      const config = req.body;
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        typeof (config as { preImbe?: unknown }).preImbe !== "object" ||
        typeof (config as { postDecode?: unknown }).postDecode !== "object" ||
        typeof (config as { vocoder?: unknown }).vocoder !== "object"
      ) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const row = await upsertAudioLabPreset(agencyId, name, config);
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "audio_lab_preset_save",
        target: name,
        ip: clientIp(req),
      });
      res.json({
        name: row.name,
        config: row.config,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /** DELETE /v1/admin/audio-lab-presets/:name — remove a preset by name. */
  router.delete("/admin/audio-lab-presets/:name", requireAdmin, async (req, res) => {
    try {
      const me = req.authUser!;
      const agencyId = me.agencyId!;
      const name = String(req.params.name ?? "").trim();
      if (!isValidPresetName(name)) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      const ok = await deleteAudioLabPreset(agencyId, name);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        agencyId,
        actorUserId: me.id,
        actorName: me.username,
        action: "audio_lab_preset_delete",
        target: name,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Analytics — read-only aggregations over the per-agency operational tables.
  // All endpoints take a `range` query param (24h / 7d / 30d) and require any
  // logged-in agency member; aggregations never leak data across tenants.
  // ---------------------------------------------------------------------------

  /** GET /v1/analytics/summary?range=24h|7d|30d — KPI tiles with prior-window deltas. */
  router.get("/analytics/summary", requireAgencyMember, async (req, res) => {
    try {
      const range = parseAnalyticsRange(req.query.range);
      const data = await getKpiSummary(req.authUser!.agencyId!, range);
      res.json({ range, ...data });
    } catch (error) {
      fail(res, error);
    }
  });

  /** GET /v1/analytics/timeseries?range=… — time-bucketed transmissions + AI counts. */
  router.get("/analytics/timeseries", requireAgencyMember, async (req, res) => {
    try {
      const range = parseAnalyticsRange(req.query.range);
      const points = await getTimeSeries(req.authUser!.agencyId!, range);
      res.json({ range, points });
    } catch (error) {
      fail(res, error);
    }
  });

  /** GET /v1/analytics/channels?range=… — per-channel utilization (top 25). */
  router.get("/analytics/channels", requireAgencyMember, async (req, res) => {
    try {
      const range = parseAnalyticsRange(req.query.range);
      const rows = await getChannelUtilization(req.authUser!.agencyId!, range);
      res.json({ range, channels: rows });
    } catch (error) {
      fail(res, error);
    }
  });

  /** GET /v1/analytics/units?range=… — top units by on-air time. */
  router.get("/analytics/units", requireAgencyMember, async (req, res) => {
    try {
      const range = parseAnalyticsRange(req.query.range);
      const rows = await getTopUnits(req.authUser!.agencyId!, range);
      res.json({ range, units: rows });
    } catch (error) {
      fail(res, error);
    }
  });

  /** GET /v1/analytics/ai-dispatch?range=… — outcome breakdown for AI dispatcher calls. */
  router.get("/analytics/ai-dispatch", requireAgencyMember, async (req, res) => {
    try {
      const range = parseAnalyticsRange(req.query.range);
      const rows = await getAiDispatchOutcomes(req.authUser!.agencyId!, range);
      res.json({ range, outcomes: rows });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
