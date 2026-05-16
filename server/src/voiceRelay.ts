/**
 * FM-style half-duplex voice relay per logical channel over WebSockets.
 *
 * Protocol:
 * - First control message MUST be UTF-8 JSON: { type: "join", unit_id, channel }
 * - Subsequent binary frames: raw PCM mono 16-bit LE, 16000 Hz (matches Android capture).
 */

import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { normalizedChannel } from "./presence.js";

export const VOICE_WS_PATH = "/v1/voice/stream";

/**
 * TTL after last relay frame before "off air".
 * Keep comfortably above worst-case framing/poll gaps so `/v1/air` does not flap between polls
 * (Android polls ~250–400ms) or between sparse IMBE frames / encode skips.
 */
const VOICE_AIR_TTL_MS = 2000;

type ClientMeta = { unitId: string; channelNorm: string | null };

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

/** True if channel is keyed by someone other than [candidateUnitUpper]. Caller uses for busy / drop. */
function isBlockedByAnother(channelNorm: string, candidateUnitUpper: string): boolean {
  const now = Date.now();
  const slot = voiceAirByChannel.get(channelNorm);
  if (!slot) {
    return false;
  }
  if (now - slot.lastPcmMs > VOICE_AIR_TTL_MS) {
    voiceAirByChannel.delete(channelNorm);
    return false;
  }
  return slot.unitUpper !== candidateUnitUpper;
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
      if (requiredKey) {
        const provided = req.headers["x-radio-key"];
        const headerVal = Array.isArray(provided) ? provided[0] : provided;
        if (headerVal !== requiredKey) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
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

  wss.on("connection", (ws: WebSocket) => {
    clientMeta.set(ws, { unitId: "", channelNorm: null });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (!isBinary) {
          const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
          const json = JSON.parse(text) as { type?: string; channel?: string; unit_id?: string };
          if (json.type !== "join") {
            return;
          }
          const unitId = String(json.unit_id ?? "")
            .trim()
            .toUpperCase();
          const chNorm = normalizedChannel(json.channel);
          if (!unitId || !chNorm || chNorm === "----") {
            ws.send(JSON.stringify({ type: "error", code: "bad_join" }));
            return;
          }
          clientMeta.set(ws, { unitId, channelNorm: chNorm });
          return;
        }

        const meta = clientMeta.get(ws);
        if (!meta?.channelNorm) {
          return;
        }
        /**
         * Only one transmitting unit per channel per air window — drop streams from intruders while
         * another handset holds the channel (TTL window).
         */
        if (isBlockedByAnother(meta.channelNorm, meta.unitId)) {
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
