import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { withChannelPlaybackLock } from "./channelPlayback.js";
import { BRIDGE_LOOPBACK_SECRET, VOICE_WS_PATH } from "../voiceRelay.js";

const FRAME_BYTES = 640;
const SAMPLE_RATE = 16_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeMp3ToPcm(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      url,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`))));
  });
}

async function playPcmOnChannelUnlocked(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
  yieldsToUnits: boolean;
  pcm: Buffer;
}): Promise<void> {
  if (opts.pcm.length === 0) {
    return;
  }

  const url = new URL(`ws://127.0.0.1:${opts.loopbackPort}${VOICE_WS_PATH}`);
  url.searchParams.set("bridge", BRIDGE_LOOPBACK_SECRET);
  url.searchParams.set("agency", String(opts.agencyId));
  url.searchParams.set("yields", opts.yieldsToUnits ? "1" : "0");
  url.searchParams.set("name", opts.unitId.slice(0, 64));

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    let joined = false;
    let done = false;

    const finish = (err?: Error) => {
      if (done) {
        return;
      }
      done = true;
      if (joinTimeout) {
        clearTimeout(joinTimeout);
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    // The loopback must ack our join promptly; otherwise fail fast so a stuck socket can never
    // hold the channel playback lock (and freeze the single-threaded AI engine) forever.
    const joinTimeout = setTimeout(() => {
      if (!joined) {
        finish(new Error("loopback join timed out"));
      }
    }, 10_000);

    const sendPcm = async () => {
      try {
        let next = Date.now();
        for (let off = 0; off < opts.pcm.length; off += FRAME_BYTES) {
          if (ws.readyState !== WebSocket.OPEN) {
            break;
          }
          const end = Math.min(off + FRAME_BYTES, opts.pcm.length);
          let frame = opts.pcm.subarray(off, end);
          if (frame.length < FRAME_BYTES) {
            frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
          }
          ws.send(frame);
          next += 20;
          const wait = next - Date.now();
          if (wait > 0) {
            await sleep(wait);
          }
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "release_air" }));
        }
        finish();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", channel: opts.channelName, client: "bridge" }));
    });
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary || joined) {
        return;
      }
      try {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string };
        if (msg.type === "joined") {
          joined = true;
          void sendPcm();
        }
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => {
      if (!joined) {
        finish(new Error("loopback closed before join"));
      }
    });
  });
}

async function playMarkerBurstOnChannelUnlocked(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
  pcm: Buffer;
}): Promise<void> {
  if (opts.pcm.length === 0) {
    return;
  }

  const url = new URL(`ws://127.0.0.1:${opts.loopbackPort}${VOICE_WS_PATH}`);
  url.searchParams.set("bridge", BRIDGE_LOOPBACK_SECRET);
  url.searchParams.set("agency", String(opts.agencyId));
  url.searchParams.set("yields", "1");
  url.searchParams.set("name", opts.unitId.slice(0, 64));

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    let joined = false;
    let done = false;

    const finish = (err?: Error) => {
      if (done) {
        return;
      }
      done = true;
      if (joinTimeout) {
        clearTimeout(joinTimeout);
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const joinTimeout = setTimeout(() => {
      if (!joined) {
        finish(new Error("loopback join timed out"));
      }
    }, 10_000);

    const sendMarker = async () => {
      try {
        // Match the web console: one `marker_tone` control frame, then the full
        // PCM clip in a single binary message. Sending 20 ms chunks used to
        // clear `markerToneUntilMs` after the first chunk so later chunks
        // claimed `/v1/air` as keyed voice and blocked units with busy tone.
        ws.send(JSON.stringify({ type: "marker_tone" }));
        if (ws.readyState === WebSocket.OPEN && opts.pcm.length > 0) {
          ws.send(opts.pcm);
        }
        finish();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", channel: opts.channelName, client: "bridge" }));
    });
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary || joined) {
        return;
      }
      try {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string };
        if (msg.type === "joined") {
          joined = true;
          void sendMarker();
        }
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => finish(err));
    ws.on("close", () => {
      if (!joined) {
        finish(new Error("loopback closed before join"));
      }
    });
  });
}

export async function playPcmOnChannel(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
  yieldsToUnits: boolean;
  pcm: Buffer;
}): Promise<void> {
  return withChannelPlaybackLock(opts.agencyId, opts.channelName, () => playPcmOnChannelUnlocked(opts));
}

/** Sends one 10-33 marker tone burst (marker_tone + PCM, does not key the channel as voice). */
export async function playMarkerBurstOnChannel(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
  pcm: Buffer;
}): Promise<void> {
  return withChannelPlaybackLock(opts.agencyId, opts.channelName, () =>
    playMarkerBurstOnChannelUnlocked(opts),
  );
}

export async function playMp3UrlOnChannel(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
  yieldsToUnits: boolean;
  mp3Url: string;
}): Promise<void> {
  const pcm = await decodeMp3ToPcm(opts.mp3Url);
  await playPcmOnChannel({ ...opts, pcm });
}
