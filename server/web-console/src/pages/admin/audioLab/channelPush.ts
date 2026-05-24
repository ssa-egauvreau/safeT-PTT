// Pushes a processed Audio Lab clip onto a real voice channel — opens a transient
// WebSocket to the relay, keys it as a one-off "LAB" unit, and streams the clip as
// IMBE frames (with clear-PCM sideband for the recorder). Real-time-paced so listeners
// hear it like any other talk-spurt rather than a fire-hose burst.

import { getToken } from "../../../api";
import { imbeEncode, imbeReady, initImbe } from "../../../voice/imbeVocoder";

const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;
const LISTEN_PCM_MAGIC_0 = 0xf6;
const LISTEN_PCM_MAGIC_1 = 0xac;

const IMBE_FRAME_8K_SAMPLES = 160; // 20 ms @ 8 kHz
const FRAME_16K_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_MS = 20;
/** The unit_id under which a lab push appears on the air. Distinct so dispatchers can
 *  see at a glance that the channel is being keyed by the Audio Lab, not a real talker. */
export const LAB_PUSH_UNIT_ID = "LAB";

function voiceSocketUrl(): string {
  const token = getToken() ?? "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/v1/voice/stream?token=${encodeURIComponent(token)}`;
}

function downsample16To8(pcm16k: Int16Array): Int16Array {
  const out = new Int16Array(pcm16k.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = (pcm16k[2 * i] + pcm16k[2 * i + 1]) >> 1;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ChannelPushOptions {
  /** Channel name to key. The caller is responsible for confirming the user really
   *  wants to broadcast on this channel (the audio is real over-the-air voice). */
  channelName: string;
  /** Already-processed clip — Int16 PCM @ 16 kHz mono (output of `processClip`). */
  pcm: Int16Array;
  /** If true, also send the clear-PCM sideband so the transmission lands in the recorder
   *  / transmission log. Default true so the lab push is searchable later. */
  recordSideband?: boolean;
}

export interface ChannelPushHandle {
  /** Resolves when the clip has finished streaming (or rejects on error). */
  finished: Promise<void>;
  /** Cancels mid-stream — stops sending further frames and closes the socket. */
  cancel(): void;
}

/** Streams a processed clip onto a channel as IMBE + sideband, paced to real time so it
 *  sounds like a normal talk-spurt to listeners. Caller awaits `finished`. */
export function pushClipToChannel(opts: ChannelPushOptions): ChannelPushHandle {
  const { channelName, pcm, recordSideband = true } = opts;
  let cancelled = false;
  let ws: WebSocket | null = null;

  const finished = (async () => {
    if (!imbeReady()) {
      const ok = await initImbe();
      if (!ok) {
        throw new Error("IMBE vocoder unavailable — cannot push to channel");
      }
    }

    ws = new WebSocket(voiceSocketUrl());
    ws.binaryType = "arraybuffer";

    // Single close-on-exit guard for every path past the open race — join failure,
    // streaming exception, normal completion, or cancellation. Without this, a
    // rejected join (timeout / listen_only / server error) would leak the socket.
    const closeWsOnExit = (socket: WebSocket | null): void => {
      if (!socket) return;
      try {
        socket.close();
      } catch {
        /* already torn down */
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const w = ws;
        if (!w) {
          reject(new Error("socket disappeared"));
          return;
        }
        w.onopen = () => resolve();
        w.onerror = () => reject(new Error("voice socket error"));
        w.onclose = () => reject(new Error("voice socket closed before open"));
      });
      if (cancelled) {
        return;
      }

      // Reattach onclose to a benign handler now that we're past the open race.
      ws.onclose = null;
      ws.onerror = null;

      // Send join, wait for the relay's "joined" ack (or "error" — which bubbles up).
      const join = new Promise<void>((resolve, reject) => {
        const w = ws;
        if (!w) {
          reject(new Error("socket disappeared"));
          return;
        }
        const timeout = setTimeout(() => reject(new Error("join timed out")), 5000);
        w.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          try {
            const msg = JSON.parse(event.data) as { type?: string; code?: string; permission?: string };
            if (msg.type === "joined") {
              clearTimeout(timeout);
              if (msg.permission === "listen_only") {
                reject(new Error("You do not have talk permission on that channel."));
              } else {
                resolve();
              }
            } else if (msg.type === "error") {
              clearTimeout(timeout);
              reject(new Error(`Channel join rejected (${msg.code ?? "unknown"})`));
            }
            // Ignore "busy" / "move" / etc. — they're not relevant to a one-shot push.
          } catch {
            /* malformed — ignore */
          }
        };
        w.send(
          JSON.stringify({ type: "join", unit_id: LAB_PUSH_UNIT_ID, channel: channelName, client: "audioLab" }),
        );
      });
      await join;
      if (cancelled) {
        return;
      }

      // Stream IMBE + sideband at the real 20 ms frame cadence. The relay's claimAir is
      // refreshed by each binary frame, so pacing keeps the channel held for the duration.
      const pcm8k = downsample16To8(pcm);
      const start = performance.now();
      let frameIndex = 0;
      for (let off = 0; off + IMBE_FRAME_8K_SAMPLES <= pcm8k.length; off += IMBE_FRAME_8K_SAMPLES) {
        if (cancelled || ws.readyState !== WebSocket.OPEN) {
          break;
        }
        const cw = imbeEncode(pcm8k.subarray(off, off + IMBE_FRAME_8K_SAMPLES));
        if (cw) {
          const frame = new Uint8Array(13);
          frame[0] = IMBE_MAGIC_0;
          frame[1] = IMBE_MAGIC_1;
          frame.set(cw, 2);
          ws.send(frame);
        }
        if (recordSideband) {
          // The relay records the sideband but does not broadcast it (see voiceRelay.ts).
          const slice16k = pcm.subarray(frameIndex * FRAME_16K_SAMPLES, (frameIndex + 1) * FRAME_16K_SAMPLES);
          if (slice16k.length === FRAME_16K_SAMPLES) {
            const side = new Uint8Array(2 + slice16k.byteLength);
            side[0] = LISTEN_PCM_MAGIC_0;
            side[1] = LISTEN_PCM_MAGIC_1;
            side.set(new Uint8Array(slice16k.buffer, slice16k.byteOffset, slice16k.byteLength), 2);
            ws.send(side);
          }
        }
        frameIndex += 1;
        // Pace to wall-clock so the sequence claims air for the right duration.
        const nextDueMs = frameIndex * FRAME_MS;
        const wait = nextDueMs - (performance.now() - start);
        if (wait > 0) {
          await sleep(wait);
        }
      }
    } finally {
      closeWsOnExit(ws);
    }
  })();

  return {
    finished,
    cancel(): void {
      cancelled = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
