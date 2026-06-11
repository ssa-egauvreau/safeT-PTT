/**
 * FM-style half-duplex voice relay per logical channel over WebSockets.
 *
 * Protocol:
 * - First control message MUST be UTF-8 JSON: { type: "join", unit_id, channel }
 * - Subsequent binary frames: raw PCM mono 16-bit LE, 16000 Hz (matches Android capture).
 *
 * Authentication:
 * - Browser console clients pass a JWT as `?token=` — their agency and channel
 *   permission are taken from the token.
 * - Android handsets pass a radio key (`X-Radio-Key` header or `?key=`); the key
 *   identifies which agency the handset belongs to.
 * - The in-process radio-bridge worker passes `?bridge=<secret>&agency=<id>` on a
 *   loopback socket; the secret is generated fresh per server process.
 *
 * Channels are namespaced per agency, so two tenants may both run "Green 1"
 * without ever hearing each other.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { normalizedChannel } from "./presence.js";
import { verifyToken, type AuthUser } from "./auth.js";
import { getPool } from "./db.js";
import {
  setAiDispatchChannelCached,
  isAiDispatchChannelCached,
} from "./aiDispatch/channelCache.js";
import {
  getAgencyById,
  getBridgeById,
  getChannelByName,
  getMembership,
  getSimulcastByName,
  getUserById,
  isChannelAiDispatchEnabled,
  resolveAgencyByKey,
  type Permission,
} from "./store.js";
import { recordFrame, type FrameAttribution } from "./recorder.js";
import {
  DEFAULT_VOICE_CODEC,
  VOICE_CODECS,
  coerceVoiceCodec,
  type VoiceCodec,
} from "./voiceCodecs.js";

/** Sideband PCM for transmission log / AI — not broadcast (pairs with on-air IMBE). */
const LISTEN_PCM_MAGIC_0 = 0xf6;
/** 16 kHz clear-PCM sideband (legacy / iOS / web clients). */
const LISTEN_PCM_MAGIC_1_16K = 0xac;
/** 8 kHz clear-PCM sideband — Android downsamples the sideband to halve its
 *  cellular uplink. The recorder upsamples it back to 16 kHz on receipt so the
 *  stored recording, transcription and playback paths are unchanged. */
const LISTEN_PCM_MAGIC_1_8K = 0xad;

function isListenPcmFrame(payload: Buffer): boolean {
  return (
    payload.length >= 4 &&
    payload[0] === LISTEN_PCM_MAGIC_0 &&
    (payload[1] === LISTEN_PCM_MAGIC_1_16K || payload[1] === LISTEN_PCM_MAGIC_1_8K)
  );
}

/** Sample rate the sideband body carries, from its magic. */
function listenPcmSampleRate(payload: Buffer): number {
  return payload[1] === LISTEN_PCM_MAGIC_1_8K ? 8000 : 16000;
}

function listenPcmBody(payload: Buffer): Buffer {
  return payload.subarray(2);
}
import { getCachedAuth, setCachedAuth } from "./sessionCache.js";

export const VOICE_WS_PATH = "/v1/voice/stream";

/**
 * TTL after last relay frame before "off air" when the talker did not send `release_air`.
 * Keep above Android's fast RX poll (~400ms while someone is shown on air) and sparse
 * vocoder frame gaps; clients should send `release_air` on PTT release for immediate clear.
 */
const VOICE_AIR_TTL_MS = 900;

/**
 * In-process secret the bridge worker presents on its loopback voice sockets.
 * Overridable via env for integration tests; otherwise random per process so it
 * is never valid across restarts and never leaves the host.
 */
export const BRIDGE_LOOPBACK_SECRET =
  process.env.BRIDGE_LOOPBACK_SECRET?.trim() || randomBytes(24).toString("hex");

type Identity =
  | { kind: "account"; user: AuthUser }
  | { kind: "legacy"; agencyId: number }
  | {
      kind: "bridge";
      agencyId: number;
      yields: boolean;
      bridgeName: string;
      /** When set, the bridge may only key this channel (a remote runner). */
      forcedChannel?: string;
      /** Set for desktop `runBridge` sockets authenticated with a user token. */
      ownerUserId?: number;
    };

/** One member channel a simulcast transmission fans out to. */
interface SimTarget {
  channelKey: string;
  channelName: string;
  channelNorm: string;
  channelId: number | null;
}

interface ClientMeta {
  identity: Identity;
  agencyId: number;
  unitId: string;
  channelNorm: string | null;
  channelKey: string | null;
  channelName: string;
  channelId: number | null;
  userId: number | null;
  displayName: string | null;
  permission: Permission;
  joined: boolean;
  /** Set when the client joined a simulcast channel — every frame fans to these. */
  simulcastTargets: SimTarget[] | null;
  /** A yielding talker (a bridge set to yield) is pre-empted by any real unit. */
  yields: boolean;
  /** Last time a "channel busy" notice was sent to this client (throttling). */
  lastBusyMs: number;
  /**
   * Until this timestamp, binary frames are 10-33 marker tones: relay to listeners
   * but do not claim `/v1/air` (so handsets do not show "dispatcher transmitting").
   */
  markerToneUntilMs: number;
  /** When true, uplink should be clear PCM so AI dispatch / Whisper can understand speech. */
  aiDispatchListenPcm: boolean;
  /** Always true after join — handsets/console uplink PCM for transmission log transcription. */
  recordListenPcm: boolean;
  /** Cached from the users table for console accounts (roster / live control). */
  deviceType: string | null;
  /** Codec the client should use to transmit on this channel — taken from the
   *  channel row at join time, updated by [notifyChannelCodec] when an admin
   *  flips the channel's codec while clients are connected. */
  codec: VoiceCodec;
  /** Codecs the client said it can encode/decode (from `caps` on the join
   *  control frame). Empty array means the client predates multi-codec and is
   *  effectively IMBE-only. The relay never blocks on this — frames are
   *  forwarded by magic-byte regardless — but it gates whether [notifyChannelCodec]
   *  bothers pushing a codec the client can't honor. */
  caps: VoiceCodec[];
}

/** Throttle for the per-client "channel busy" notice. */
const BUSY_NOTICE_MS = 750;

/**
 * Peer-buffer high-water mark before voice fan-out skips that peer. ~64 KB is well over a few
 * seconds of voice frames (IMBE is ~13 B/20ms; PCM mono 16k is 640 B/20ms) so a healthy peer
 * never trips it. A backed-up consumer gets dropped frames instead of holding back the channel.
 */
const VOICE_PEER_BUFFER_LIMIT_BYTES = 64 * 1024;

type VoiceSlot = {
  ws: WebSocket;
  unitUpper: string;
  displayName: string | null;
  lastPcmMs: number;
  priority: boolean;
  yields: boolean;
};

/** Who is currently keyed, keyed by `agency:channel` so tenants stay isolated. */
const voiceAirByChannel = new Map<string, VoiceSlot>();

/** Auto-derived activity status for a roster member. */
export type PresenceStatus = "idle" | "transmitting" | "driving" | "emergency";

export interface RosterMember {
  unit_id: string;
  display_name: string | null;
  kind: "account" | "legacy" | "bridge";
  /** Client platform reported on join: android, ios, web, desktop, bridge, or unknown. */
  client: string;
  /** Account device category (unit_radio, phone, dispatch_console, …) when known. */
  device_type?: string | null;
  connected_ms: number;
  /** Derived from live signals (talker / GPS speed / active emergency); set by the roster route. */
  status?: PresenceStatus;
  /**
   * True when Live Channel Control must not move this unit (dispatch console on
   * multiple channels, or explicit dispatch_console device type).
   */
  move_locked?: boolean;
}

interface RosterRecord {
  channelKey: string;
  /** Display name of the channel this socket joined (for the live-control admin tree). */
  channelName: string;
  unitId: string;
  displayName: string | null;
  kind: "account" | "legacy" | "bridge";
  client: string;
  deviceType: string | null;
  joinedAt: number;
}

/** Client platforms the relay recognizes; anything else is recorded as "unknown". */
const KNOWN_CLIENTS = new Set(["android", "ios", "web", "desktop", "bridge"]);

function normalizeClient(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return KNOWN_CLIENTS.has(value) ? value : "unknown";
}

/** Live voice-WebSocket roster so the console can show who is on each channel. */
const voiceRoster = new Map<WebSocket, RosterRecord>();

/** Every open voice socket and its connection metadata (the relay is a singleton). */
const clientMeta = new Map<WebSocket, ClientMeta>();

function frameAttribution(meta: ClientMeta): FrameAttribution {
  return {
    agencyId: meta.agencyId,
    channelNorm: meta.channelNorm!,
    channelName: meta.channelName,
    channelId: meta.channelId,
    userId: meta.userId,
    unitId: meta.unitId,
    displayName: meta.displayName,
    aiDispatchListenPcm: meta.aiDispatchListenPcm,
    recordListenPcm: meta.recordListenPcm,
  };
}

/** Tell connected voice clients on a channel to uplink clear PCM (AI dispatch listening). */
export function notifyChannelAiDispatchListenPcm(
  agencyId: number,
  channelName: string,
  enabled: boolean,
): void {
  setAiDispatchChannelCached(agencyId, channelName, enabled);
  const chNorm = normalizedChannel(channelName);
  const key = channelKey(agencyId, chNorm);
  for (const [ws, meta] of clientMeta) {
    if (meta.channelKey !== key) {
      continue;
    }
    meta.aiDispatchListenPcm = enabled;
    try {
      ws.send(JSON.stringify({ type: "ai_dispatch_pcm", enabled }));
    } catch {
      /* socket closing */
    }
  }
}

/**
 * Tell connected voice clients on a channel which codec to transmit with.
 * Triggered by the admin PATCH that updates `radio_channels.codec`. The relay
 * keeps the per-client `meta.codec` in sync and pushes a control frame so
 * clients can flush their TX encoder and swap mid-session. RX is unaffected —
 * peers detect each incoming frame's codec from its leading magic bytes.
 *
 * A client that doesn't advertise support for the new codec still receives
 * the push (for visibility) but is expected to fall back to its best-supported
 * encoder on TX. Listening side keeps working regardless.
 */
export function notifyChannelCodec(
  agencyId: number,
  channelName: string,
  codec: VoiceCodec,
): void {
  const chNorm = normalizedChannel(channelName);
  const key = channelKey(agencyId, chNorm);
  for (const [ws, meta] of clientMeta) {
    if (meta.channelKey !== key) {
      continue;
    }
    meta.codec = codec;
    try {
      ws.send(JSON.stringify({ type: "codec_change", codec }));
    } catch {
      /* socket closing */
    }
  }
}

/** Composite channel key namespacing a normalized channel under its agency. */
function channelKey(agencyId: number, channelNorm: string): string {
  return `${agencyId} ${channelNorm}`;
}

/**
 * Forcibly closes every open voice socket belonging to an agency. Called when
 * the owner disables the agency, rotates its radio key, or deletes it, so live
 * voice cannot outlast the tenant's access. Returns the number of sockets closed.
 */
export function dropAgencyVoiceConnections(agencyId: number): number {
  let closed = 0;
  for (const [ws, meta] of clientMeta) {
    if (meta.agencyId !== agencyId) {
      continue;
    }
    try {
      ws.close(1008, "agency access revoked");
    } catch {
      /* ignore a socket already gone */
    }
    closed++;
  }
  return closed;
}

/**
 * Closes every open voice socket with a "going away" code (1001). Called from the SIGTERM
 * handler so a Railway redeploy doesn't slam the underlying TCP — clients see a clean close and
 * trigger their own reconnect logic instead of a mid-frame audio drop.
 */
export function closeAllVoiceConnections(): number {
  let closed = 0;
  for (const ws of clientMeta.keys()) {
    try {
      ws.close(1001, "server shutting down");
    } catch {
      /* already gone */
    }
    closed++;
  }
  return closed;
}

/**
 * Closes every voice socket tied to one user account. Called from the login
 * handler so a fresh sign-in immediately silences any prior browser session and
 * any desktop `runBridge` runner for the same account. Key-authenticated
 * handsets and the in-process loopback bridge worker are not user-bound.
 */
export function dropUserVoiceConnections(userId: number): number {
  let closed = 0;
  for (const [ws, meta] of clientMeta) {
    const ownedByUser =
      (meta.identity.kind === "account" && meta.identity.user.id === userId) ||
      (meta.identity.kind === "bridge" &&
        meta.identity.ownerUserId != null &&
        meta.identity.ownerUserId === userId);
    if (!ownedByUser) continue;
    try {
      ws.close(1008, "session superseded");
    } catch {
      /* ignore a socket already gone */
    }
    closed++;
  }
  return closed;
}

/**
 * Resolves the agency a key-authenticated handset belongs to.
 * `requiredKey` is the legacy global `RADIO_API_KEY`, which maps to the default agency.
 */
async function resolveLegacyAgency(key: string | null, requiredKey: string | undefined): Promise<number | null> {
  if (!getPool()) {
    // No database — per-agency keys can't be resolved, but the global radio
    // key still gates handset traffic. Bucket 0 stands in for the lone tenant.
    if (!requiredKey) {
      return 0;
    }
    return key === requiredKey ? 0 : null;
  }
  const agency = await resolveAgencyByKey(key, requiredKey).catch(() => null);
  return agency?.id ?? null;
}

/** Members currently connected to a channel's voice stream, longest-connected first. */
export function listChannelRoster(agencyId: number, channelRaw: unknown): RosterMember[] {
  const chNorm = normalizedChannel(channelRaw);
  if (!chNorm || chNorm === "----") {
    return [];
  }
  const key = channelKey(agencyId, chNorm);
  const now = Date.now();
  const members: RosterMember[] = [];
  for (const record of voiceRoster.values()) {
    if (record.channelKey === key) {
      members.push({
        unit_id: record.unitId,
        display_name: record.displayName,
        kind: record.kind,
        client: record.client,
        device_type: record.deviceType,
        connected_ms: now - record.joinedAt,
      });
    }
  }
  members.sort((a, b) => b.connected_ms - a.connected_ms);
  return members;
}

/** One channel and the members currently connected to it. */
export interface AgencyChannelRoster {
  channel: string;
  members: RosterMember[];
}

/**
 * Every channel in the agency that has at least one connected member, with that
 * member list — drives the Live Channel Control admin tree.
 */
export function listAgencyRosters(agencyId: number): AgencyChannelRoster[] {
  const prefix = `${agencyId} `;
  const now = Date.now();
  const byChannel = new Map<string, RosterMember[]>();
  for (const record of voiceRoster.values()) {
    if (!record.channelKey.startsWith(prefix)) {
      continue;
    }
    const list = byChannel.get(record.channelName) ?? [];
    list.push({
      unit_id: record.unitId,
      display_name: record.displayName,
      kind: record.kind,
      client: record.client,
      device_type: record.deviceType,
      connected_ms: now - record.joinedAt,
    });
    byChannel.set(record.channelName, list);
  }
  const counts = unitChannelCounts(agencyId);
  return [...byChannel.entries()]
    .map(([channel, members]) => ({
      channel,
      members: withRosterMoveLock(
        members.sort((a, b) => b.connected_ms - a.connected_ms),
        counts,
      ),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

type MoveLockRosterRecord = Pick<
  RosterRecord,
  "channelKey" | "channelName" | "unitId" | "kind" | "client" | "deviceType"
>;

function countsAsDispatchConsoleSession(record: MoveLockRosterRecord): boolean {
  if (record.kind !== "account") {
    return false;
  }
  if (record.deviceType === "dispatch_console") {
    return true;
  }
  // Older rows (or temporary DB misses during join) can leave `deviceType`
  // null. Treat web/desktop account sessions as console-style for the
  // multi-channel move lock so scanning dispatchers still cannot be force-moved.
  return (
    record.deviceType == null && (record.client === "web" || record.client === "desktop")
  );
}

/**
 * Subset of a {@link RosterRecord} that the live-control move-lock counters
 * care about. Broken out so the counting rules can be exercised in unit tests
 * without spinning up a WebSocket server to seed the live roster.
 *
 * `client` is optional so legacy fixtures (which only set deviceType) keep
 * working — when it's missing, only `deviceType === "dispatch_console"` can
 * trigger a console count, which is the historical behavior.
 */
export interface UnitChannelCountRecord {
  channelKey: string;
  channelName: string;
  unitId: string;
  kind: "account" | "legacy" | "bridge";
  deviceType: string | null;
  client?: string;
}

/**
 * Pure helper that backs both {@link unitChannelCounts} (production path) and
 * {@link unitChannelCountsFromRecords} (test-friendly alias with the
 * agencyId-first signature). Counts distinct voice channels each unit is
 * currently dispatching on, scoped to the given agency.
 *
 * Only `account`-kind sessions counted as a dispatch console contribute — a
 * user who just has a handset/phone on one channel and the dashboard open on
 * another must still be drag-droppable. Multi-channel scanning is a
 * dispatch-console signal, not a "this person is everywhere" signal.
 */
export function computeUnitChannelCounts(
  records: Iterable<UnitChannelCountRecord>,
  agencyId: number,
): Map<string, number> {
  const prefix = `${agencyId} `;
  const byUnit = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.channelKey.startsWith(prefix)) {
      continue;
    }
    if (!countsAsDispatchConsoleSession({
      channelKey: record.channelKey,
      channelName: record.channelName,
      unitId: record.unitId,
      kind: record.kind,
      client: record.client ?? "unknown",
      deviceType: record.deviceType,
    })) {
      continue;
    }
    const unit = record.unitId.toUpperCase();
    const set = byUnit.get(unit) ?? new Set<string>();
    set.add(record.channelName);
    byUnit.set(unit, set);
  }
  const counts = new Map<string, number>();
  for (const [unit, channels] of byUnit) {
    counts.set(unit, channels.size);
  }
  return counts;
}

/**
 * agencyId-first alias for {@link computeUnitChannelCounts} used by the
 * live-control move-lock regression tests (PR #151 "fix live-control move
 * lock for null deviceType consoles"). Kept as its own export so tests can
 * exercise the rule directly without depending on the function's argument
 * order changing.
 */
export function unitChannelCountsFromRecords(
  agencyId: number,
  records: Iterable<UnitChannelCountRecord>,
): Map<string, number> {
  return computeUnitChannelCounts(records, agencyId);
}

/**
 * How many distinct voice channels each unit is currently dispatching on
 * (live control). Reads from the in-memory voice roster — see
 * {@link computeUnitChannelCounts} for the per-record counting rules.
 */
export function unitChannelCounts(agencyId: number): Map<string, number> {
  return computeUnitChannelCounts(voiceRoster.values(), agencyId);
}

/** Marks console operators who must not be live-moved (multi-channel dispatch). */
export function withRosterMoveLock(
  members: RosterMember[],
  counts: Map<string, number>,
): RosterMember[] {
  return members.map((m) => {
    const n = counts.get(m.unit_id.toUpperCase()) ?? 0;
    const locked =
      m.kind === "account" &&
      (m.device_type === "dispatch_console" || n > 1);
    return locked ? { ...m, move_locked: true } : m;
  });
}

/** True when live channel control must not relocate this unit. */
export function isUnitMoveLocked(agencyId: number, unitIdRaw: string): boolean {
  const unit = unitIdRaw.trim().toUpperCase();
  if (!unit) {
    return false;
  }
  const counts = unitChannelCounts(agencyId);
  if ((counts.get(unit) ?? 0) > 1) {
    return true;
  }
  const prefix = `${agencyId} `;
  for (const record of voiceRoster.values()) {
    if (!record.channelKey.startsWith(prefix) || record.unitId.toUpperCase() !== unit) {
      continue;
    }
    if (record.kind === "account" && record.deviceType === "dispatch_console") {
      return true;
    }
  }
  return false;
}

/** Seed the in-memory voice roster with a synthetic record for tests. */
export interface VoiceRosterTestRecord {
  agencyId: number;
  channelName: string;
  unitId: string;
  displayName?: string | null;
  kind: "account" | "legacy" | "bridge";
  client?: string;
  deviceType?: string | null;
  joinedAt?: number;
}

/**
 * Test-only: insert a synthetic roster entry without going through the
 * WebSocket upgrade/join path. Each call creates a fresh, unique key so the
 * record is independently addressable in the underlying map.
 *
 * @internal Intended for unit tests; do not call from production code.
 */
export function __setVoiceRosterRecordForTest(record: VoiceRosterTestRecord): void {
  const chNorm = normalizedChannel(record.channelName);
  voiceRoster.set({} as WebSocket, {
    channelKey: channelKey(record.agencyId, chNorm),
    channelName: record.channelName,
    unitId: record.unitId,
    displayName: record.displayName ?? null,
    kind: record.kind,
    client: record.client ?? "unknown",
    deviceType: record.deviceType ?? null,
    joinedAt: record.joinedAt ?? Date.now(),
  });
}

/** Test-only: drop every entry from the in-memory voice roster. @internal */
export function __resetVoiceRosterForTest(): void {
  voiceRoster.clear();
  voiceAirByChannel.clear();
  clientMeta.clear();
}

/**
 * Test-only: register a minimal `clientMeta` entry so the per-channel control
 * fan-out (e.g. the `air_released` broadcast) can be exercised without the full
 * WebSocket upgrade/join path. The `ws` should be a stub exposing `send` and a
 * `readyState` of `WebSocket.OPEN`. @internal
 */
export function __registerVoiceMemberForTest(opts: {
  ws: WebSocket;
  agencyId: number;
  channel: string;
}): void {
  const chNorm = normalizedChannel(opts.channel);
  clientMeta.set(opts.ws, {
    identity: { kind: "legacy", agencyId: opts.agencyId },
    agencyId: opts.agencyId,
    unitId: "",
    channelNorm: chNorm,
    channelKey: channelKey(opts.agencyId, chNorm),
    channelName: opts.channel,
    channelId: null,
    userId: null,
    displayName: null,
    permission: "talk",
    joined: true,
    simulcastTargets: null,
    yields: false,
    lastBusyMs: 0,
    markerToneUntilMs: 0,
    aiDispatchListenPcm: false,
    recordListenPcm: false,
    deviceType: null,
    codec: DEFAULT_VOICE_CODEC,
    caps: [],
  });
}

/** Test-only: seed a channel air slot as if a talker were live. When
 *  `lastPcmMs` is supplied the slot is timestamped at that millisecond
 *  instead of `now()`, letting TTL-reap tests forge a stale entry without
 *  fake timers. @internal */
export function __claimVoiceAirForTest(opts: {
  agencyId: number;
  channel: string;
  ws: WebSocket;
  unitId: string;
  displayName?: string | null;
  lastPcmMs?: number;
  yields?: boolean;
}): void {
  const chNorm = normalizedChannel(opts.channel);
  const key = channelKey(opts.agencyId, chNorm);
  voiceAirByChannel.set(key, {
    ws: opts.ws,
    unitUpper: opts.unitId.trim().toUpperCase(),
    displayName: opts.displayName?.trim() || null,
    lastPcmMs: opts.lastPcmMs ?? Date.now(),
    priority: false,
    yields: opts.yields ?? false,
  });
}

/** Test-only: handle a control frame the same way the relay socket would. @internal */
export function __handleVoiceControlForTest(ws: WebSocket, type: string): void {
  if (type === "release_air") {
    releaseAir(ws);
  }
}

/**
 * Live Channel Control: pushes a "move to channel" command to every open socket
 * belonging to agency+unit. The client re-joins the target channel on receipt.
 * Returns the number of sockets the command reached.
 */
export function sendMoveCommand(
  agencyId: number,
  unitIdRaw: string,
  toChannel: string,
  byName: string | null,
  fromChannel: string | null,
): number {
  const unit = unitIdRaw.trim().toUpperCase();
  if (!unit) {
    return 0;
  }
  const payload = JSON.stringify({
    type: "move",
    channel: toChannel,
    by: byName,
    from: fromChannel,
  });
  let reached = 0;
  for (const [ws, meta] of clientMeta) {
    if (meta.agencyId !== agencyId || meta.unitId !== unit) {
      continue;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    try {
      ws.send(payload);
      reached += 1;
    } catch {
      /* stale socket — ignore */
    }
  }
  return reached;
}

export function peekVoiceTransmittingUnit(agencyId: number, channelRaw: unknown): string | null {
  return peekVoiceTransmittingTalker(agencyId, channelRaw)?.unit_id ?? null;
}

/** Live transmitter on a channel (for handset HUD / air probe). */
export function peekVoiceTransmittingTalker(
  agencyId: number,
  channelRaw: unknown,
): { unit_id: string; display_name: string | null; yields: boolean } | null {
  const chNorm = normalizedChannel(channelRaw);
  if (!chNorm || chNorm === "----") {
    return null;
  }
  const key = channelKey(agencyId, chNorm);
  const slot = voiceAirByChannel.get(key);
  if (!slot) {
    return null;
  }
  if (Date.now() - slot.lastPcmMs > VOICE_AIR_TTL_MS) {
    // The talker's socket dropped without sending `release_air`, so the slot
    // has aged out. Mirror the explicit-release path and tell every other
    // member of the channel the air just freed, so each listener can play
    // the same end-of-transmission cue (roger beep / squelch tail) that
    // PR #218 wired up. The dead talker's ws is excluded from the broadcast
    // by `broadcastAirReleased`'s `peer === from` filter, so we cannot send
    // to a closing socket. Idempotent: the delete-then-broadcast pair runs
    // exactly once per real release — a second peek finds no slot and emits
    // nothing.
    voiceAirByChannel.delete(key);
    broadcastAirReleased(slot.ws, key);
    return null;
  }
  return { unit_id: slot.unitUpper, display_name: slot.displayName, yields: slot.yields };
}

type AirClaim = { ok: true } | { ok: false; holder: string };

/**
 * Strict half-duplex: at most one transmitter per channel at a time. Records
 * the caller as the channel holder when it is allowed to transmit. A
 * `talk_priority` operator may take the channel from a non-priority talker, but
 * never from another priority talker — so two operators can never double up.
 * A yielding holder (a radio bridge configured to yield) steps aside for any
 * talker, so a real unit always wins the channel back from such a bridge.
 */
function claimAir(
  chanKey: string,
  ws: WebSocket,
  unitUpper: string,
  displayName: string | null,
  priority: boolean,
  yields: boolean,
): AirClaim {
  const slot = voiceAirByChannel.get(chanKey);
  const now = Date.now();
  if (slot && now - slot.lastPcmMs <= VOICE_AIR_TTL_MS && slot.ws !== ws) {
    // A different connection is holding the channel. A yielding holder is
    // pre-empted by anyone; otherwise only priority takes a non-priority holder.
    if (!slot.yields && !(priority && !slot.priority)) {
      return { ok: false, holder: slot.unitUpper };
    }
    // fall through and take over the channel.
  }
  // A fresh talk-spurt is a slot that didn't exist, had gone stale, or changed
  // hands — push the talker to the channel's listeners right away so handsets
  // can attribute the audio immediately instead of waiting (up to ~1.2 s) for
  // their next /v1/talk-activity poll. Per-frame slot refreshes by the same
  // socket stay silent.
  const newHolder = !slot || slot.ws !== ws || now - slot.lastPcmMs > VOICE_AIR_TTL_MS;
  voiceAirByChannel.set(chanKey, {
    ws,
    unitUpper,
    displayName: displayName?.trim() || null,
    lastPcmMs: now,
    priority,
    yields,
  });
  if (newHolder) {
    broadcastAirClaimed(ws, chanKey, unitUpper, displayName?.trim() || null);
  }
  return { ok: true };
}

/** Frees any channel a closing socket was holding, so the air clears at once.
 *  When a slot actually existed, forwards an `air_released` control message to
 *  every OTHER member of that channel so each listener can synthesize the
 *  end-of-transmission cue (roger beep / squelch tail) locally — precise
 *  timing, clean PCM, and the talker correctly excluded. Idempotent: a slot is
 *  deleted at most once, so the broadcast fires exactly once per real release;
 *  a stray release_air from a socket holding nothing emits nothing. */
function releaseAir(ws: WebSocket): void {
  for (const [chanKey, slot] of voiceAirByChannel) {
    if (slot.ws === ws) {
      voiceAirByChannel.delete(chanKey);
      broadcastAirReleased(ws, chanKey);
    }
  }
}

/** Tell every other member of `chanKey` the air was released. Reuses the same
 *  per-channel `clientMeta` fan-out as `broadcastExcept` / `notifyChannelCodec`.
 *  The releasing socket is excluded. The channel display name is taken from
 *  each peer's own `meta.channelName` (they are, by the key filter, on that
 *  exact channel) so the client can match it against the channel it is tuned
 *  to. */
function broadcastAirReleased(from: WebSocket, chanKey: string): void {
  for (const [peer, meta] of clientMeta) {
    if (peer === from) continue;
    if (!meta.channelKey || meta.channelKey !== chanKey) continue;
    if (peer.readyState !== WebSocket.OPEN) continue;
    try {
      peer.send(JSON.stringify({ type: "air_released", channel: meta.channelName }));
    } catch {
      /* socket closing */
    }
  }
}

/** Tell every other member of `chanKey` who just took the air. Counterpart of
 *  `broadcastAirReleased` with the same per-recipient channel personalization;
 *  fired by `claimAir` once per talk-spurt so clients can paint "RX: UNIT"
 *  the moment audio starts instead of on their next talk-activity poll. */
function broadcastAirClaimed(
  from: WebSocket,
  chanKey: string,
  unitUpper: string,
  displayName: string | null,
): void {
  for (const [peer, meta] of clientMeta) {
    if (peer === from) continue;
    if (!meta.channelKey || meta.channelKey !== chanKey) continue;
    if (peer.readyState !== WebSocket.OPEN) continue;
    try {
      peer.send(
        JSON.stringify({
          type: "air_claimed",
          channel: meta.channelName,
          unit_id: unitUpper,
          display_name: displayName,
        }),
      );
    } catch {
      /* socket closing */
    }
  }
}

/**
 * True when a *different* live connection currently holds the channel's air. Gates the clear-PCM
 * record sideband: only the connection that actually holds the air (or a free/expired channel) is
 * recorded. A unit that loses the half-duplex race must not have its sideband recorded — otherwise
 * its mic both creates a phantom transmission (transcribed + answered by AI for audio nobody heard)
 * and, because recordings key on agency+channel and finalize whenever the unit changes, repeatedly
 * finalizes and fragments the real talker's in-progress recording.
 *
 * This deliberately keys off the *current* holder, not who could preempt it. claimAir only runs on
 * the IMBE/voice path, and clients send the clear-PCM sideband just before their first IMBE frame,
 * so a would-be preemptor has not actually taken the channel yet at sideband time. Recording it
 * speculatively would reintroduce the phantom/fragmentation behavior if that IMBE is delayed or
 * never arrives. A real preemptor simply starts recording once its IMBE claims the air; the cost is
 * at most one leading sideband frame (audio that was not yet on-air anyway).
 */
function channelAirBlocksRecord(chanKey: string, ws: WebSocket): boolean {
  const slot = voiceAirByChannel.get(chanKey);
  if (!slot) {
    return false;
  }
  if (Date.now() - slot.lastPcmMs > VOICE_AIR_TTL_MS) {
    return false;
  }
  return slot.ws !== ws;
}

/** A NAT or radio dropping a TCP connection without TCP RST/FIN leaves the WS "stuck" on our
 *  side — heartbeat detects + drops these zombies fast. The interval matches typical NAT idle
 *  timeouts (~60 s) without being chatty enough to drain handset battery noticeably. */
const VOICE_WS_HEARTBEAT_MS = 30_000;

interface HeartbeatWs extends WebSocket {
  isAlive?: boolean;
}

export function attachVoiceRelay(
  server: HttpServer,
  options: { radioApiKey?: string },
): WebSocketServer {
  const requiredKey = options.radioApiKey?.trim();

  // Cap per-frame size to bound memory per connection. Voice frames are ~13 B IMBE or
  // ~640 B/20ms PCM, but custom soundboard tone-outs (playCustomTone) send a whole decoded
  // PCM clip as ONE frame: at 16 kHz mono int16, a 30-second clip is ~960 KB and a 4-minute
  // clip from a 4 MB MP3 upload (TONE_OUT_AUDIO_MAX in apiRoutes.ts) can decode to ~8 MB.
  // 8 MB covers every legitimate clip the agency-side TONE_OUT_AUDIO_MAX permits while still
  // rejecting outright junk; the ws library's 100 MB default is too generous.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  /*
   * Periodic ping; if a socket missed the previous round's pong, terminate it. The pong
   * handler resets isAlive so any TCP that's still answering survives. wss.clients is the
   * library-tracked set — using it directly avoids drift against our own clientMeta map.
   */
  const heartbeatInterval = setInterval(() => {
    for (const raw of wss.clients) {
      const ws = raw as HeartbeatWs;
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* already closing */
      }
    }
  }, VOICE_WS_HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeatInterval));

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const host = req.headers.host ?? "localhost";
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== VOICE_WS_PATH) {
          socket.destroy();
          return;
        }

        let identity: Identity;
        const bridgeParam = url.searchParams.get("bridge");
        const token = url.searchParams.get("token");
        if (bridgeParam) {
          // Loopback connection from the in-process radio-bridge worker.
          if (bridgeParam !== BRIDGE_LOOPBACK_SECRET) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          const bridgeAgency = Number(url.searchParams.get("agency"));
          if (!Number.isInteger(bridgeAgency) || bridgeAgency < 0) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
          }
          // A bridge must not outlive its agency being disabled.
          if (getPool()) {
            const agency = await getAgencyById(bridgeAgency).catch(() => null);
            if (!agency || agency.disabled) {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
          }
          identity = {
            kind: "bridge",
            agencyId: bridgeAgency,
            yields: url.searchParams.get("yields") === "1",
            bridgeName: (url.searchParams.get("name") ?? "BRIDGE").slice(0, 64),
          };
        } else if (token) {
          const user = verifyToken(token);
          if (!user) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          if (user.agencyId == null) {
            // Platform owners have no agency and cannot join a voice channel.
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
          // A token outlives its agency being disabled — reject the upgrade if so.
          // Honor the 15 s sessionCache (same one the REST router uses) so a reconnect storm
          // after a Railway redeploy doesn't fan dozens of pg lookups in parallel.
          if (getPool()) {
            const cached = getCachedAuth(user.id);
            if (cached) {
              if (cached.userDisabled || cached.agencyDisabled) {
                socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
                socket.destroy();
                return;
              }
              if (user.gen !== cached.tokenGeneration) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
              }
            } else {
              // Differentiate "the lookup returned null because the row is gone or disabled"
              // (a definitive negative we want to cache so retries don't thrash pg) from
              // "the lookup threw because pg is transiently unhappy" (must NOT be cached, or a
              // single bad query would lock the user out for the next 15 s).
              let lookupErrored = false;
              const [agency, dbUser] = await Promise.all([
                getAgencyById(user.agencyId).catch(() => {
                  lookupErrored = true;
                  return null;
                }),
                getUserById(user.id).catch(() => {
                  lookupErrored = true;
                  return null;
                }),
              ]);
              const agencyDisabled = !agency || agency.disabled;
              if (!dbUser || dbUser.disabled || agencyDisabled) {
                if (!lookupErrored) {
                  setCachedAuth(user.id, {
                    tokenGeneration: dbUser?.token_generation ?? 0,
                    userDisabled: !dbUser || !!dbUser.disabled,
                    agencyDisabled,
                  });
                }
                socket.write(
                  agencyDisabled || (dbUser && dbUser.disabled)
                    ? "HTTP/1.1 403 Forbidden\r\n\r\n"
                    : "HTTP/1.1 401 Unauthorized\r\n\r\n",
                );
                socket.destroy();
                return;
              }
              // Newest sign-in wins: reject a stale token here too so an auto-
              // reconnecting browser cannot briefly resurrect its dropped socket.
              if (user.gen !== dbUser.token_generation) {
                if (!lookupErrored) {
                  setCachedAuth(user.id, {
                    tokenGeneration: dbUser.token_generation,
                    userDisabled: false,
                    agencyDisabled: false,
                  });
                }
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
              }
              if (!lookupErrored) {
                setCachedAuth(user.id, {
                  tokenGeneration: dbUser.token_generation,
                  userDisabled: false,
                  agencyDisabled: false,
                });
              }
            }
          }
          const runBridgeRaw = url.searchParams.get("runBridge");
          if (runBridgeRaw != null) {
            // Remote audio-device bridge runner (the desktop console). The
            // account's token authenticates it; the bridge row decides which
            // channel it keys, whether it yields, and its name — the client
            // cannot pick those, so this never grants extra channel access.
            const bridgeId = Number(runBridgeRaw);
            const bridge =
              getPool() && Number.isInteger(bridgeId)
                ? await getBridgeById(bridgeId, user.agencyId).catch(() => null)
                : null;
            if (!bridge || !bridge.enabled || bridge.source_type !== "audio_device") {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
            identity = {
              kind: "bridge",
              agencyId: user.agencyId,
              yields: bridge.yield_to_units,
              bridgeName: bridge.name,
              forcedChannel: bridge.target_channel,
              ownerUserId: user.id,
            };
          } else {
            identity = { kind: "account", user };
          }
        } else {
          const headerRaw = req.headers["x-radio-key"];
          const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
          const key = headerVal ?? url.searchParams.get("key");
          const agencyId = await resolveLegacyAgency(key ?? null, requiredKey);
          if (agencyId == null) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          identity = { kind: "legacy", agencyId };
        }

        const agencyId = identity.kind === "account" ? identity.user.agencyId! : identity.agencyId;
        wss.handleUpgrade(req, socket, head, (ws) => {
          clientMeta.set(ws, {
            identity,
            agencyId,
            unitId: "",
            channelNorm: null,
            channelKey: null,
            channelName: "",
            channelId: null,
            userId: null,
            displayName: null,
            permission: "listen_only",
            joined: false,
            simulcastTargets: null,
            yields: identity.kind === "bridge" ? identity.yields : false,
            lastBusyMs: 0,
            markerToneUntilMs: 0,
            aiDispatchListenPcm: false,
            recordListenPcm: true,
            deviceType: null,
            codec: DEFAULT_VOICE_CODEC,
            caps: [],
          });
          wss.emit("connection", ws, req);
        });
      } catch {
        socket.destroy();
      }
    })();
  });

  function broadcastExcept(from: WebSocket, chanKey: string, payload: Buffer): void {
    for (const [peer, meta] of clientMeta) {
      if (peer === from) continue;
      if (!meta.channelKey || meta.channelKey !== chanKey) continue;
      if (peer.readyState !== WebSocket.OPEN) continue;
      // Drop frames for a peer whose send buffer has already piled up past the high-water mark.
      // Without this, one slow consumer (saturated network, paused browser tab, etc.) would let
      // ws queue frames unbounded, holding memory and adding latency for everyone else on the
      // channel. Half-duplex voice tolerates drops fine — better a moment of silence on the slow
      // peer than a backed-up relay on the channel.
      if (peer.bufferedAmount > VOICE_PEER_BUFFER_LIMIT_BYTES) continue;
      try {
        peer.send(payload);
      } catch {
        /* ignore stale peer */
      }
    }
  }

  async function handleJoin(
    ws: WebSocket,
    meta: ClientMeta,
    json: { channel?: string; unit_id?: string; client?: string; caps?: unknown },
  ): Promise<void> {
    // A remote bridge runner keys only the channel its bridge row configures.
    const channelName =
      meta.identity.kind === "bridge" && meta.identity.forcedChannel
        ? meta.identity.forcedChannel.trim()
        : String(json.channel ?? "").trim();
    const chNorm = normalizedChannel(channelName);
    if (!chNorm || chNorm === "----") {
      ws.send(JSON.stringify({ type: "error", code: "bad_join" }));
      return;
    }

    // Multi-codec capability: client lists every codec it can encode/decode.
    // Older clients omit this field — they are effectively IMBE-only.
    meta.caps = Array.isArray(json.caps)
      ? json.caps.filter((c): c is VoiceCodec =>
          typeof c === "string" && (VOICE_CODECS as readonly string[]).includes(c),
        )
      : [];

    let channelRow: { id: number; codec: VoiceCodec } | null = null;
    try {
      const row = await getChannelByName(meta.agencyId, channelName);
      channelRow = row ? { id: row.id, codec: row.codec } : null;
    } catch {
      channelRow = null; // no database — recording/permissions degrade gracefully
    }

    // When it is not a real channel, it may be a simulcast channel — only
    // admin/dispatcher accounts may key one; handsets and radios cannot.
    let simulcast: { id: number; name: string; memberChannels: { id: number; name: string }[] } | null = null;
    if (!channelRow) {
      try {
        simulcast = await getSimulcastByName(meta.agencyId, channelName);
      } catch {
        simulcast = null;
      }
    }

    let unitId: string;
    let permission: Permission;
    let userId: number | null = null;
    let displayName: string | null = null;

    if (meta.identity.kind === "account") {
      const user = meta.identity.user;
      userId = user.id;
      displayName = user.displayName;
      unitId = (user.unitId ?? user.username).trim().toUpperCase() || "WEB";
      if (meta.deviceType == null && getPool()) {
        try {
          const row = await getUserById(user.id, meta.agencyId);
          meta.deviceType = row?.device_type ?? null;
        } catch {
          meta.deviceType = null;
        }
      }
      if (user.role === "admin" || user.role === "dispatcher") {
        permission = "talk_priority";
      } else {
        if (!channelRow) {
          ws.send(JSON.stringify({ type: "error", code: "unknown_channel" }));
          return;
        }
        const membership = await getMembership(user.id, channelRow.id).catch(() => null);
        // Handsets list every agency channel; radios without an explicit assignment
        // still need to join voice on their tuned channel (dispatchers use priority above).
        permission = membership ?? "talk";
      }
    } else if (meta.identity.kind === "bridge") {
      // A radio bridge keys its admin-configured target like a unit. It may key
      // a simulcast channel too, so one ingest fans out to several channels.
      unitId = meta.identity.bridgeName.trim().toUpperCase() || "BRIDGE";
      displayName = meta.identity.bridgeName;
      userId = meta.identity.ownerUserId ?? null;
      permission = "talk";
    } else {
      // A key-authenticated handset cannot key a simulcast channel.
      if (simulcast) {
        ws.send(JSON.stringify({ type: "error", code: "not_a_member" }));
        return;
      }
      unitId = String(json.unit_id ?? "").trim().toUpperCase();
      if (!unitId) {
        ws.send(JSON.stringify({ type: "error", code: "bad_join" }));
        return;
      }
      permission = "talk";
    }

    const chanKey = channelKey(meta.agencyId, chNorm);
    meta.unitId = unitId;
    meta.channelNorm = chNorm;
    meta.channelKey = chanKey;
    meta.channelName = channelName;
    meta.channelId = simulcast ? null : channelRow?.id ?? null;
    meta.userId = userId;
    meta.displayName = displayName;
    meta.permission = permission;
    meta.simulcastTargets = simulcast
      ? simulcast.memberChannels.map((c) => {
          const norm = normalizedChannel(c.name);
          return {
            channelKey: channelKey(meta.agencyId, norm),
            channelName: c.name,
            channelNorm: norm,
            channelId: c.id,
          };
        })
      : null;
    meta.joined = true;
    let aiListenPcm = isAiDispatchChannelCached(meta.agencyId, channelName);
    if (!aiListenPcm && channelRow && !simulcast) {
      try {
        aiListenPcm = await isChannelAiDispatchEnabled(meta.agencyId, channelName);
        setAiDispatchChannelCached(meta.agencyId, channelName, aiListenPcm);
      } catch {
        aiListenPcm = false;
      }
    }
    meta.aiDispatchListenPcm = aiListenPcm;
    meta.recordListenPcm = true;
    // A real channel carries its codec on the row; simulcast keys IMBE for now
    // (per-member-channel codecs may differ — handled in a follow-up). Coerce
    // through the registry so an unexpected DB value falls back to the default.
    meta.codec = channelRow ? coerceVoiceCodec(channelRow.codec) : DEFAULT_VOICE_CODEC;
    const prior = voiceRoster.get(ws);
    voiceRoster.set(ws, {
      channelKey: chanKey,
      channelName,
      unitId,
      displayName,
      kind: meta.identity.kind,
      client: normalizeClient(json.client),
      deviceType: meta.deviceType,
      // Keep the original join time across re-joins to the same channel
      // (Android re-sends `join` on the same socket periodically).
      joinedAt: prior && prior.channelKey === chanKey ? prior.joinedAt : Date.now(),
    });
    ws.send(
      JSON.stringify({
        type: "joined",
        channel: channelName,
        permission,
        unit_id: unitId,
        record_listen_pcm: true,
        codec: meta.codec,
        ...(aiListenPcm ? { ai_dispatch_listen_pcm: true } : {}),
      }),
    );
  }

  wss.on("connection", (ws: WebSocket) => {
    // Mark alive at handshake so the next heartbeat tick doesn't immediately tear us down.
    (ws as HeartbeatWs).isAlive = true;
    ws.on("pong", () => {
      (ws as HeartbeatWs).isAlive = true;
    });
    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const meta = clientMeta.get(ws);
      if (!meta) {
        return;
      }
      try {
        if (!isBinary) {
          const text = Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
          const json = JSON.parse(text) as {
            type?: string;
            channel?: string;
            unit_id?: string;
            client?: string;
          };
          if (json.type === "join") {
            void handleJoin(ws, meta, json);
            return;
          }
          // 10-33 marker: the next PCM frame(s) are alert audio only, not keyed voice.
          if (json.type === "marker_tone") {
            meta.markerToneUntilMs = Date.now() + 30_000;
            return;
          }
          // PTT released — drop `/v1/air` immediately instead of waiting for TTL.
          if (json.type === "release_air") {
            releaseAir(ws);
            return;
          }
          return;
        }

        if (!meta.joined || !meta.channelNorm || !meta.channelKey) {
          return;
        }
        // Listen-only members may monitor a channel but never key up.
        if (meta.permission === "listen_only") {
          return;
        }

        let payload: Buffer;
        if (Buffer.isBuffer(raw)) {
          payload = raw;
        } else if (Array.isArray(raw)) {
          payload = Buffer.concat(raw);
        } else {
          payload = Buffer.from(raw);
        }
        if (payload.length === 0) {
          return;
        }

        // Clear PCM sideband for recorder / AI — never broadcast or key the channel. Only record it
        // for the connection that actually holds the air: a unit keying a busy channel loses the
        // half-duplex race on-air, so recording its sideband would log a transmission nobody heard
        // and fragment the real talker's recording (see channelAirBlocksRecord).
        if (isListenPcmFrame(payload)) {
          const pcm = listenPcmBody(payload);
          const pcmRate = listenPcmSampleRate(payload);
          if (pcm.length > 0) {
            if (meta.simulcastTargets) {
              for (const target of meta.simulcastTargets) {
                if (channelAirBlocksRecord(target.channelKey, ws)) {
                  continue;
                }
                recordFrame(
                  {
                    ...frameAttribution(meta),
                    channelNorm: target.channelNorm,
                    channelName: target.channelName,
                    channelId: target.channelId,
                    aiDispatchListenPcm: isAiDispatchChannelCached(meta.agencyId, target.channelName),
                    recordListenPcm: true,
                  },
                  pcm,
                  pcmRate,
                );
              }
            } else if (meta.channelKey && !channelAirBlocksRecord(meta.channelKey, ws)) {
              recordFrame(frameAttribution(meta), pcm, pcmRate);
            }
          }
          return;
        }

        const priority = meta.permission === "talk_priority";
        const markerOnly = meta.markerToneUntilMs > Date.now();

        // 10-33 marker tone — audibility without occupying the channel on /v1/air.
        if (markerOnly) {
          if (meta.simulcastTargets) {
            for (const target of meta.simulcastTargets) {
              broadcastExcept(ws, target.channelKey, payload);
              recordFrame(
                {
                  ...frameAttribution(meta),
                  channelNorm: target.channelNorm,
                  channelName: target.channelName,
                  channelId: target.channelId,
                  aiDispatchListenPcm: isAiDispatchChannelCached(meta.agencyId, target.channelName),
                  recordListenPcm: true,
                },
                payload,
              );
            }
          } else if (meta.channelKey) {
            broadcastExcept(ws, meta.channelKey, payload);
            recordFrame(frameAttribution(meta), payload);
          }
          // One WebSocket binary message carries the whole marker clip.
          meta.markerToneUntilMs = 0;
          return;
        }

        // Simulcast — fan the frame out to every member channel it can claim.
        if (meta.simulcastTargets) {
          for (const target of meta.simulcastTargets) {
            if (!claimAir(target.channelKey, ws, meta.unitId, meta.displayName, priority, meta.yields).ok) {
              continue; // a member channel held by someone else is simply skipped
            }
            broadcastExcept(ws, target.channelKey, payload);
            recordFrame(
              {
                ...frameAttribution(meta),
                channelNorm: target.channelNorm,
                channelName: target.channelName,
                channelId: target.channelId,
                aiDispatchListenPcm: isAiDispatchChannelCached(meta.agencyId, target.channelName),
                recordListenPcm: true,
              },
              payload,
            );
          }
          return;
        }

        // Strict half-duplex — only the channel holder's audio goes through.
        const claim = claimAir(meta.channelKey, ws, meta.unitId, meta.displayName, priority, meta.yields);
        if (!claim.ok) {
          const now = Date.now();
          if (now - meta.lastBusyMs > BUSY_NOTICE_MS) {
            meta.lastBusyMs = now;
            try {
              ws.send(JSON.stringify({ type: "busy", unit_id: claim.holder }));
            } catch {
              /* ignore stale peer */
            }
          }
          return;
        }
        broadcastExcept(ws, meta.channelKey, payload);
        recordFrame(frameAttribution(meta), payload);
      } catch (e) {
        console.warn("voiceRelay message handling error", e);
      }
    });

    ws.on("close", () => {
      clientMeta.delete(ws);
      voiceRoster.delete(ws);
      releaseAir(ws);
    });
  });

  return wss;
}
