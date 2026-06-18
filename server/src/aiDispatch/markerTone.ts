import { existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getAgencySound, getAgencySoundsVersion } from "../store.js";
import { playMarkerBurstOnChannel } from "./playback.js";

const SAMPLE_RATE = 16_000;
const MARKER_BEEP_MS = 1200;
const MARKER_BEEP_HZ = 950;

function markerBeepPcm(): Buffer {
  const total = Math.round((SAMPLE_RATE * MARKER_BEEP_MS) / 1000);
  const fade = Math.round(SAMPLE_RATE * 0.01);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    let gain = 0.5;
    if (i < fade) {
      gain *= i / fade;
    } else if (i > total - fade) {
      gain *= (total - i) / fade;
    }
    const sample = Math.round(Math.sin((2 * Math.PI * MARKER_BEEP_HZ * i) / SAMPLE_RATE) * gain * 32767);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function decodeMarkerFile(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
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

/**
 * Decode an uploaded custom tone to PCM. The bytes are written to a temp file
 * first (rather than piped to ffmpeg's stdin) because `accept="audio/*"` lets
 * operators upload containers — m4a / mp4 / aac and some WAVs — whose metadata
 * sits at the end of the file and so cannot be decoded from a non-seekable
 * stdin pipe. A pipe decode of those formats fails and silently falls back to
 * the bundled default beep; decoding from a real file matches the bundled path
 * and handles every format ffmpeg supports.
 */
/** Retry the custom-tone decode a few times — a transient ffmpeg spawn failure
 *  (EAGAIN/ENOMEM under load) would otherwise drop this agency to the default
 *  beep for the burst, and that's exactly the condition that kept reverting the
 *  custom 10-33 to the default. A successful decode is cached, so one win sticks. */
const MARKER_DECODE_ATTEMPTS = 3;
const MARKER_DECODE_BACKOFF_MS = 250;

async function decodeMarkerAudio(input: Buffer): Promise<Buffer> {
  const tmp = join(tmpdir(), `marker-${randomBytes(8).toString("hex")}`);
  await writeFile(tmp, input);
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MARKER_DECODE_ATTEMPTS; attempt++) {
      try {
        return await decodeMarkerFile(tmp);
      } catch (err) {
        lastErr = err;
        if (attempt < MARKER_DECODE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, MARKER_DECODE_BACKOFF_MS * (attempt + 1)));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

const bundledMarkerCache: { pcm: Buffer | null } = { pcm: null };
const agencyMarkerCache = new Map<string, Buffer>();

async function getBundledMarkerPcm(): Promise<Buffer> {
  if (bundledMarkerCache.pcm) {
    return bundledMarkerCache.pcm;
  }
  const roots = [
    join(process.cwd(), "dist/web-public/sounds/marker_1033.wav"),
    join(process.cwd(), "web-console/public/sounds/marker_1033.wav"),
    join(dirname(fileURLToPath(import.meta.url)), "../../../dist/web-public/sounds/marker_1033.wav"),
  ];
  for (const wavPath of roots) {
    if (existsSync(wavPath)) {
      try {
        bundledMarkerCache.pcm = await decodeMarkerFile(wavPath);
        return bundledMarkerCache.pcm;
      } catch {
        /* try next */
      }
    }
  }
  bundledMarkerCache.pcm = markerBeepPcm();
  return bundledMarkerCache.pcm;
}

/** Agency custom tone (Admin → Sounds) → bundled default → synthetic beep. */
async function getMarkerPcmForAgency(agencyId: number): Promise<Buffer> {
  const version = await getAgencySoundsVersion(agencyId);
  const cacheKey = `${agencyId}:${version}`;
  const hit = agencyMarkerCache.get(cacheKey);
  if (hit) {
    return hit;
  }

  const custom = await getAgencySound(agencyId, "marker_1033");
  if (custom?.audio?.length) {
    try {
      const pcm = await decodeMarkerAudio(custom.audio);
      cacheAgencyMarker(agencyId, cacheKey, pcm);
      return pcm;
    } catch (err) {
      // Return the bundled default for THIS burst but do NOT cache it — the
      // sounds version only changes on re-upload, so caching the fallback here
      // would pin the default beep until redeploy/re-upload even though the
      // failure (e.g. a transient ffmpeg spawn error under load) was temporary.
      // Leaving it uncached lets the next 12 s burst retry the custom tone.
      console.warn(
        `[ai-dispatch] agency ${agencyId} custom marker_1033 decode failed, using bundled default for this burst (will retry)`,
        err,
      );
      return getBundledMarkerPcm();
    }
  }

  // No custom tone configured — the bundled default is the correct, stable
  // answer for this version, so it's safe to cache.
  const pcm = await getBundledMarkerPcm();
  cacheAgencyMarker(agencyId, cacheKey, pcm);
  return pcm;
}

/** Store the agency's marker PCM and drop its stale (older-version) entries. */
function cacheAgencyMarker(agencyId: number, cacheKey: string, pcm: Buffer): void {
  agencyMarkerCache.set(cacheKey, pcm);
  for (const key of agencyMarkerCache.keys()) {
    if (key.startsWith(`${agencyId}:`) && key !== cacheKey) {
      agencyMarkerCache.delete(key);
    }
  }
}

/** One 10-33 marker burst on the channel (same relay path as dispatch console marker). */
export async function playMarkerToneOnChannel(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
}): Promise<void> {
  const pcm = await getMarkerPcmForAgency(opts.agencyId);
  await playMarkerBurstOnChannel({ ...opts, pcm });
}
