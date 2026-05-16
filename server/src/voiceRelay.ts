/**
 * FM-style half-duplex voice relay per logical channel over WebSockets.
 *
 * Protocol:
 * - First control message MUST be UTF-8 JSON: { type: "join", unit_id, channel }
 * - Subsequent binary frames: raw PCM mono 16-bit LE, 16000 Hz (matches Android capture).
 *
 * Authentication:
 * - Browser console clients pass a JWT as `?token=` — their channel permission is enforced.
 * - Android handsets pass the shared `X-Radio-Key` header (or `?key=`) and default to `talk`.
 */

import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { normalizedChannel } from "./presence.js";
import { verifyToken, type AuthUser } from "./auth.js";
import { getChannelByName, getMembership, type Permission } from "./store.js";
import { recordFrame } from "./recorder.js";

export const VOICE_WS_PATH = "/v1/voice/stream";

/**
 * TTL after last relay frame before "off air".
 * Keep comfortably above worst-case framing/poll gaps so `/v1/air` does not flap between polls
 * (Android polls ~250–400ms) or between sparse IMBE frames / encode skips.
 */
const VOICE_AIR_TTL_MS = 2000;

type Identity = { kind: "account"; user: AuthUser } | { kind: "legacy" };

interface ClientMeta {
  identity: Identity;
  unitId: string;
  channelNorm: string | null;
  channelName: string;
  channelId: number | null;
  userId: number | null;
  displayName: string | null;
  permission: Permission;
  joined: boolean;
}

type VoiceSlot = { unitUpper: string; lastPcmMs: number };

/** Who is currently keyed on normalized channel keys (presence-style names). */
const voiceAirByChannel = new Map<string, VoiceSlot>();

export function peekVoiceTransmittingUnit(channelRaw: unknown): string | null {
  const chNorm = normalizedChannel(channelRaw);
  if (!chNorm || chNorm === "----") {
    return null;
  }
  const slot = voiceAirByChannel.get(chNorm);
  if (!slot) {
    return null;
  }
  if (Date.now() - slot.lastPcmMs > VOICE_AIR_TTL_MS) {
    voiceAirByChannel.delete(chNorm);
    return null;
  }
  return slot.unitUpper;
}

function touchTransmission(channelNorm: string, unitUpper: string): void {
  voiceAirByChannel.set(channelNorm, { unitUpper, lastPcmMs: Date.now() });
}

/** Unit currently holding the channel, if it is someone other than the candidate; else null. */
function otherActiveHolder(channelNorm: string, candidateUnitUpper: string): string | null {
  const slot = voiceAirByChannel.get(channelNorm);
  if (!slot) {
    return null;
  }
  if (Date.now() - slot.lastPcmMs > VOICE_AIR_TTL_MS) {
    voiceAirByChannel.delete(channelNorm);
    return null;
  }
  return slot.unitUpper !== candidateUnitUpper ? slot.unitUpper : null;
}

export function attachVoiceRelay(
  server: HttpServer,
  options: { radioApiKey?: string },
): WebSocketServer {
  const requiredKey = options.radioApiKey?.trim();

  const wss = new WebSocketServer({ noServer: true });
  const clientMeta = new Map<WebSocket, ClientMeta>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const host = req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== VOICE_WS_PATH) {
        socket.destroy();
        return;
      }

      let identity: Identity;
      const token = url.searchParams.get("token");
      if (token) {
        const user = verifyToken(token);
        if (!user) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        identity = { kind: "account", user };
      } else if (requiredKey) {
        const headerRaw = req.headers["x-radio-key"];
        const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
        if (headerVal !== requiredKey && url.searchParams.get("key") !== requiredKey) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        identity = { kind: "legacy" };
      } else {
        identity = { kind: "legacy" };
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        clientMeta.set(ws, {
          identity,
          unitId: "",
          channelNorm: null,
          channelName: "",
          channelId: null,
          userId: null,
          displayName: null,
          permission: "listen_only",
          joined: false,
        });
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  function broadcastExcept(from: WebSocket, channelNorm: string, payload: Buffer): void {
    for (const [peer, meta] of clientMeta) {
      if (peer === from) continue;
      if (!meta.channelNorm || meta.channelNorm !== channelNorm) continue;
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
    json: { channel?: string; unit_id?: string },
  ): Promise<void> {
    const channelName = String(json.channel ?? "").trim();
    const chNorm = normalizedChannel(channelName);
    if (!chNorm || chNorm === "----") {
      ws.send(JSON.stringify({ type: "error", code: "bad_join" }));
      return;
    }

    let channelRow: { id: number } | null = null;
    try {
      channelRow = await getChannelByName(channelName);
    } catch {
      channelRow = null; // no database — recording/permissions degrade gracefully
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
        if (!membership) {
          ws.send(JSON.stringify({ type: "error", code: "not_a_member" }));
          return;
        }
        permission = membership;
      }
    } else {
      unitId = String(json.unit_id ?? "").trim().toUpperCase();
      if (!unitId) {
        ws.send(JSON.stringify({ type: "error", code: "bad_join" }));
        return;
      }
      permission = "talk";
    }

    meta.unitId = unitId;
    meta.channelNorm = chNorm;
    meta.channelName = channelName;
    meta.channelId = channelRow?.id ?? null;
    meta.userId = userId;
    meta.displayName = displayName;
    meta.permission = permission;
    meta.joined = true;
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
          const json = JSON.parse(text) as { type?: string; channel?: string; unit_id?: string };
          if (json.type === "join") {
            void handleJoin(ws, meta, json);
          }
          return;
        }

        if (!meta.joined || !meta.channelNorm) {
          return;
        }
        // Listen-only members may monitor a channel but never key up.
        if (meta.permission === "listen_only") {
          return;
        }
        // One transmitter per channel per air window. talk_priority pre-empts the current holder.
        const holder = otherActiveHolder(meta.channelNorm, meta.unitId);
        if (holder && meta.permission !== "talk_priority") {
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
        touchTransmission(meta.channelNorm, meta.unitId);
        broadcastExcept(ws, meta.channelNorm, payload);
        recordFrame(
          {
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
    });
  });

  return wss;
}
