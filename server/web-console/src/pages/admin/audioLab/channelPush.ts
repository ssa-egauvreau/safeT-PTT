// Pushes a processed Audio Lab clip onto a real voice channel — opens a transient
// WebSocket to the relay, keys it as a one-off "LAB" unit, and streams the clip as
// vocoded frames (with clear-PCM sideband for the recorder). Real-time-paced so listeners
// hear it like any other talk-spurt rather than a fire-hose burst.

import type { VoiceCodec } from "../../../api";
import { getToken } from "../../../api";
import { ambeEncode, ambeReady, initAmbe } from "../../../voice/ambeVocoder";
import { codec2Encode, codec2Ready, initCodec2 } from "../../../voice/codec2Vocoder";
import { imbeEncode, imbeReady, initImbe } from "../../../voice/imbeVocoder";
import { opusEncode, opusReady, initOpus } from "../../../voice/opusWasmCodec";
import { codecMagic } from "../../../voice/voiceCodecRegistry";

const LISTEN_PCM_MAGIC_0 = 0xf6;
const LISTEN_PCM_MAGIC_1 = 0xac;

const IMBE_FRAME_8K_SAMPLES = 160; // 20 ms @ 8 kHz
const CODEC2_FRAME_8K_SAMPLES = 160;
const OPUS_FRAME_16K_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_16K_SAMPLES = 320;
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

async function ensurePushCodec(codec: VoiceCodec): Promise<void> {
  if (codec === "imbe") {
    if (!imbeReady()) {
      const ok = await initImbe();
      if (!ok) throw new Error("IMBE vocoder unavailable — cannot push to channel");
    }
    return;
  }
  if (codec === "codec2_3200") {
    if (!codec2Ready()) {
      const ok = await initCodec2();
      if (!ok) throw new Error("Codec2 vocoder unavailable — cannot push to channel");
    }
    return;
  }
  if (codec === "ambe_2450") {
    if (!ambeReady()) {
      const ok = await initAmbe();
      if (!ok) throw new Error("AMBE vocoder unavailable — cannot push to channel");
    }
    return;
  }
  if (!opusReady()) {
    const ok = await initOpus();
    if (!ok) throw new Error("Opus vocoder unavailable — cannot push to channel");
  }
}

export interface ChannelPushOptions {
  /** Channel name to key. The caller is responsible for confirming the user really
   *  wants to broadcast on this channel (the audio is real over-the-air voice). */
  channelName: string;
  /** Already-processed clip — Int16 PCM @ 16 kHz mono (output of `processClip`). */
  pcm: Int16Array;
  /** Wire codec for the streamed frames (should match the channel's codec for a fair test). */
  codec?: VoiceCodec;
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

/** Streams a processed clip onto a channel, paced to real time so it sounds like a normal talk-spurt. */
export function pushClipToChannel(opts: ChannelPushOptions): ChannelPushHandle {
  const { channelName, pcm, codec = "imbe", recordSideband = true } = opts;
  let cancelled = false;
  let ws: WebSocket | null = null;

  const finished = (async () => {
    await ensurePushCodec(codec);

    ws = new WebSocket(voiceSocketUrl());
    ws.binaryType = "arraybuffer";

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

      ws.onclose = null;
      ws.onerror = null;

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

      const magic = codecMagic(codec);
      const start = performance.now();
      let frameIndex = 0;

      if (codec === "opus") {
        for (let off = 0; off + OPUS_FRAME_16K_SAMPLES <= pcm.length; off += OPUS_FRAME_16K_SAMPLES) {
          if (cancelled || ws.readyState !== WebSocket.OPEN) break;
          const packet = opusEncode(pcm.subarray(off, off + OPUS_FRAME_16K_SAMPLES));
          if (packet) {
            const frame = new Uint8Array(2 + packet.length);
            frame[0] = magic.b0;
            frame[1] = magic.b1;
            frame.set(packet, 2);
            ws.send(frame);
          }
          if (recordSideband) {
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
          const wait = frameIndex * FRAME_MS - (performance.now() - start);
          if (wait > 0) await sleep(wait);
        }
      } else {
        const pcm8k = downsample16To8(pcm);
        const frameSamples = codec === "codec2_3200" ? CODEC2_FRAME_8K_SAMPLES : IMBE_FRAME_8K_SAMPLES;
        for (let off = 0; off + frameSamples <= pcm8k.length; off += frameSamples) {
          if (cancelled || ws.readyState !== WebSocket.OPEN) break;
          const slice8k = pcm8k.subarray(off, off + frameSamples);
          let payload: Uint8Array | null = null;
          if (codec === "codec2_3200") {
            payload = codec2Encode(slice8k);
          } else if (codec === "ambe_2450") {
            payload = ambeEncode(slice8k);
          } else {
            payload = imbeEncode(slice8k);
          }
          if (payload) {
            const frame = new Uint8Array(2 + payload.length);
            frame[0] = magic.b0;
            frame[1] = magic.b1;
            frame.set(payload, 2);
            ws.send(frame);
          }
          if (recordSideband) {
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
          const wait = frameIndex * FRAME_MS - (performance.now() - start);
          if (wait > 0) await sleep(wait);
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
