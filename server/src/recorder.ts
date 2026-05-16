// Records each talk-spurt on a channel into the transmissions table, then hands it
// to the transcriber. A talk-spurt ends after a short gap with no frames.

import { getPool } from "./db.js";
import { insertTransmission } from "./store.js";
import { encodeWavPcm16 } from "./wav.js";
import { enqueueTranscription } from "./transcribe.js";

const SAMPLE_RATE = 16000;
/** Silence after the last frame that closes a transmission. */
const GAP_MS = 1500;
/** Hard cap; longer holds are split into separate recordings. */
const MAX_MS = 5 * 60 * 1000;
/** Ignore key bumps shorter than this (~300 ms of 16 kHz mono PCM-16). */
const MIN_BYTES = Math.round(SAMPLE_RATE * 2 * 0.3);
const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;

export interface FrameAttribution {
  channelNorm: string;
  channelName: string;
  channelId: number | null;
  userId: number | null;
  unitId: string;
  displayName: string | null;
}

interface ActiveRecording extends FrameAttribution {
  startedAt: number;
  lastFrameMs: number;
  chunks: Buffer[];
  bytes: number;
}

const active = new Map<string, ActiveRecording>();
let sweepTimer: NodeJS.Timeout | null = null;

function isImbeFrame(payload: Buffer): boolean {
  return payload.length === 13 && payload[0] === IMBE_MAGIC_0 && payload[1] === IMBE_MAGIC_1;
}

async function finalize(rec: ActiveRecording): Promise<void> {
  if (active.get(rec.channelNorm) === rec) {
    active.delete(rec.channelNorm);
  }
  if (rec.bytes < MIN_BYTES) {
    return;
  }
  const pcm = Buffer.concat(rec.chunks, rec.bytes);
  const durationMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
  try {
    const id = await insertTransmission({
      channelId: rec.channelId,
      channelName: rec.channelName,
      userId: rec.userId,
      unitId: rec.unitId,
      displayName: rec.displayName,
      startedAt: new Date(rec.startedAt),
      endedAt: new Date(rec.lastFrameMs),
      durationMs,
      sampleRate: SAMPLE_RATE,
      audio: encodeWavPcm16(pcm, SAMPLE_RATE),
    });
    enqueueTranscription(id);
  } catch (error) {
    console.warn("Failed to save transmission recording", error);
  }
}

/** Feeds one accepted relay frame into the recorder. Call after the frame is broadcast. */
export function recordFrame(attr: FrameAttribution, payload: Buffer): void {
  if (!getPool() || payload.length === 0 || isImbeFrame(payload)) {
    return;
  }
  const now = Date.now();
  let rec = active.get(attr.channelNorm);
  if (rec && rec.unitId !== attr.unitId) {
    void finalize(rec);
    rec = undefined;
  }
  if (!rec) {
    rec = { ...attr, startedAt: now, lastFrameMs: now, chunks: [], bytes: 0 };
    active.set(attr.channelNorm, rec);
  }
  // ws may reuse the frame buffer — copy before retaining it.
  rec.chunks.push(Buffer.from(payload));
  rec.bytes += payload.length;
  rec.lastFrameMs = now;
  if (now - rec.startedAt >= MAX_MS) {
    void finalize(rec);
  }
}

function sweep(): void {
  const now = Date.now();
  for (const rec of [...active.values()]) {
    if (now - rec.lastFrameMs > GAP_MS) {
      void finalize(rec);
    }
  }
}

/** Starts the periodic talk-spurt finalizer. */
export function startRecorder(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(sweep, 500);
  if (typeof sweepTimer.unref === "function") {
    sweepTimer.unref();
  }
}
