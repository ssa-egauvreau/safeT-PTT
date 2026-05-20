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
  getAgencyById,
  getBridgeById,
  getChannelByName,
  getMembership,
  getSimulcastByName,
  getUserById,
  resolveAgencyByKey,
  type Permission,
} from "./store.js";
import { recordFrame } from "./recorder.js";

export const VOICE_WS_PATH = "/v1/voice/stream";

/**
 * TTL after last relay frame before "off air".
 * Keep comfortably above worst-case framing/poll gaps so `/v1/air` does not flap between polls
 * (Android polls ~250–400ms) or between sparse IMBE frames / encode skips.
 */
const VOICE_AIR_TTL_MS = 2000;

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
      /**
       * For desktop `runBridge` sockets authenticated with a user token, the user id of the
       * account that opened the socket. Used by [dropUserVoiceConnections] so a newer login
       * from the same account also kicks the bridge runner (otherwise the bridge would keep
       * relaying audio under the prior token, since freshness is checked at upgrade time only).
       * Loopback bridges (the in-process worker) leave this unset.
       */
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
}

/** Throttle for the per-client "channel busy" notice. */
const BUSY_NOTICE_MS = 750;

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

export interface RosterMember {
  unit_id: string;
  display_name: string | null;
  kind: "account" | "legacy" | "bridge";
  /** Client platform reported on join: android, ios, web, desktop, bridge, or unknown. */
  client: string;
  connected_ms: number;
}

interface RosterRecord {
  channelKey: string;
  unitId: string;
  displayName: string | null;
  kind: "account" | "legacy" | "bridge";
  client: string;
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
 * Closes every voice socket tied to one user account. Called from the login handler so a fresh
 * sign-in immediately silences any prior browser session and any desktop `runBridge` runner
 * authenticated with the same account. Key-authenticated handsets and the in-process loopback
 * bridge worker are not user-bound and are intentionally left untouched.
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
        connected_ms: now - record.joinedAt,
      });
    }
  }
  members.sort((a, b) => b.connected_ms - a.connected_ms);
  return members;
}

export function peekVoiceTransmittingUnit(agencyId: number, channelRaw: unknown): string | null {
  return peekVoiceTransmittingTalker(agencyId, channelRaw)?.unit_id ?? null;
}

/** Live transmitter on a channel (for handset HUD / air probe). */
export function peekVoiceTransmittingTalker(
  agencyId: number,
  channelRaw: unknown,
): { unit_id: string; display_name: string | null } | null {
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
    voiceAirByChannel.delete(key);
    return null;
  }
  return { unit_id: slot.unitUpper, display_name: slot.displayName };
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
  voiceAirByChannel.set(chanKey, {
    ws,
    unitUpper,
    displayName: displayName?.trim() || null,
    lastPcmMs: now,
    priority,
    yields,
  });
  return { ok: true };
}

/** Frees any channel a closing socket was holding, so the air clears at once. */
function releaseAir(ws: WebSocket): void {
  for (const [chanKey, slot] of voiceAirByChannel) {
    if (slot.ws === ws) {
      voiceAirByChannel.delete(chanKey);
    }
  }
}

export function attachVoiceRelay(
  server: HttpServer,
  options: { radioApiKey?: string },
): WebSocketServer {
  const requiredKey = options.radioApiKey?.trim();

  const wss = new WebSocketServer({ noServer: true });

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
          if (getPool()) {
            const agency = await getAgencyById(user.agencyId).catch(() => null);
            if (!agency || agency.disabled) {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
            // Newest sign-in wins: reject a stale token here too so an auto-
            // reconnecting browser cannot briefly resurrect its dropped socket.
            const dbUser = await getUserById(user.id).catch(() => null);
            if (!dbUser || user.gen !== dbUser.token_generation) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
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
    json: { channel?: string; unit_id?: string; client?: string },
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

    let channelRow: { id: number } | null = null;
    try {
      channelRow = await getChannelByName(meta.agencyId, channelName);
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
    const prior = voiceRoster.get(ws);
    voiceRoster.set(ws, {
      channelKey: chanKey,
      unitId,
      displayName,
      kind: meta.identity.kind,
      client: normalizeClient(json.client),
      // Keep the original join time across re-joins to the same channel
      // (Android re-sends `join` on the same socket periodically).
      joinedAt: prior && prior.channelKey === chanKey ? prior.joinedAt : Date.now(),
    });
    ws.send(JSON.stringify({ type: "joined", channel: channelName, permission, unit_id: unitId }));
  }

  wss.on("connection", (ws: WebSocket) => {
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
        const priority = meta.permission === "talk_priority";

        // Simulcast — fan the frame out to every member channel it can claim.
        if (meta.simulcastTargets) {
          for (const target of meta.simulcastTargets) {
            if (!claimAir(target.channelKey, ws, meta.unitId, meta.displayName, priority, meta.yields).ok) {
              continue; // a member channel held by someone else is simply skipped
            }
            broadcastExcept(ws, target.channelKey, payload);
            recordFrame(
              {
                agencyId: meta.agencyId,
                channelNorm: target.channelNorm,
                channelName: target.channelName,
                channelId: target.channelId,
                userId: meta.userId,
                unitId: meta.unitId,
                displayName: meta.displayName,
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
        recordFrame(
          {
            agencyId: meta.agencyId,
            channelNorm: meta.channelNorm,
            channelName: meta.channelName,
            channelId: meta.channelId,
            userId: meta.userId,
            unitId: meta.unitId,
            displayName: meta.displayName,
          },
          payload,
        );
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
