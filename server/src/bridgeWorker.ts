/**
 * In-process radio-bridge worker.
 *
 * For every enabled `stream_url` bridge it runs an ffmpeg ingest that decodes
 * the source into 16 kHz mono PCM, applies VOX gating, and feeds the gated
 * audio onto the bridge's target channel through a loopback voice socket — the
 * same relay path a real handset uses.
 *
 * Bridges configured to yield are pre-empted by any real unit (see the relay's
 * `claimAir`); the loopback socket carries the `yields` flag so the relay knows.
 *
 * Audio-device bridges are handled client-side (desktop console), not here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket } from "ws";
import { getPool } from "./db.js";
import { listEnabledStreamBridges, type AgencyBridgeRow } from "./store.js";
import { BRIDGE_LOOPBACK_SECRET, VOICE_WS_PATH } from "./voiceRelay.js";

/** PCM ingest format — must match the relay's expected mono 16-bit LE @ 16 kHz. */
const SAMPLE_RATE = 16000;
/** 20 ms frame: 320 samples × 2 bytes. Fine-grained enough for VOX gating. */
const FRAME_BYTES = 640;

/** How often the worker reconciles running ingests against the database. */
const POLL_INTERVAL_MS = 15000;

/** ffmpeg respawn backoff bounds after a pipeline drops. */
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 30000;
/** A run healthy for at least this long resets the backoff. */
const HEALTHY_RUN_MS = 60000;

interface RunningBridge {
  /** Restart-relevant fields; a change tears the ingest down and starts fresh. */
  signature: string;
  stop: () => void;
}

const running = new Map<number, RunningBridge>();
let pollTimer: NodeJS.Timeout | null = null;
let loopbackPort = 8080;
let ffmpegReady: Promise<boolean> | null = null;
let ffmpegMissingLogged = false;

/** Live ingest level + gate state for one stream bridge — drives the console meter. */
interface BridgeStatus {
  level: number;
  keyed: boolean;
  updatedAt: number;
}
const bridgeStatuses = new Map<number, BridgeStatus>();

/**
 * Last failure reason for a stream bridge that isn't currently passing audio.
 * Persisted across the supervisor's respawn/backoff loop so the console can
 * show *why* a bridge reads "Not running" (stream refused, auth failed,
 * unreachable, …) instead of a bare red dot. Cleared the moment audio flows.
 */
interface BridgeDiagnostic {
  reason: string;
  at: number;
}
const bridgeDiagnostics = new Map<number, BridgeDiagnostic>();

/** How long a recorded failure reason stays relevant once nothing refreshes it. */
const REASON_TTL_MS = 120_000;

function setBridgeReason(id: number, reason: string): void {
  bridgeDiagnostics.set(id, { reason, at: Date.now() });
}

/**
 * Translate an ffmpeg stderr line (or other ingest failure text) into an
 * operator-readable reason. Broadcastify's concurrent-listener limit shows up
 * as a 403, so it's called out specifically — that's the most common cause of
 * an authenticated feed that nonetheless refuses the bridge.
 */
export function describeBridgeIngestError(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes("403") || lower.includes("forbidden")) {
    return "Stream refused the connection (HTTP 403) — the source account may already be streaming elsewhere (Broadcastify allows a limited number of simultaneous listeners) or the feed requires a premium subscription.";
  }
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return "Stream authentication failed (HTTP 401) — check the username and password in the stream URL.";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "Stream not found (HTTP 404) — check the feed ID / URL.";
  }
  if (lower.includes("429")) {
    return "Stream is rate-limiting the connection (HTTP 429) — too many recent attempts.";
  }
  if (
    lower.includes("failed to resolve") ||
    lower.includes("name or service not known") ||
    lower.includes("could not resolve")
  ) {
    return "Could not resolve the stream host — check the URL hostname.";
  }
  if (lower.includes("connection refused") || lower.includes("connection timed out") || lower.includes("timed out")) {
    return "Could not reach the stream — connection refused or timed out.";
  }
  if (lower.includes("protocol not on whitelist") || lower.includes("tls") || lower.includes("ssl")) {
    return "Could not open the secure stream (TLS error) — try the http:// URL instead of https://.";
  }
  if (lower.includes("invalid data found") || lower.includes("could not find codec")) {
    return "The source isn't decodable audio — confirm the URL points at an audio stream.";
  }
  // Unknown ffmpeg error: surface its first line verbatim, trimmed for the UI.
  return `Ingest error: ${text.split("\n")[0].slice(0, 160)}`;
}

/**
 * Most recent ingest status for a stream bridge. `running` is false once the
 * status goes stale, so a stalled or stopped ingest reads as not running. When
 * not running, `reason` carries the last failure cause (if known and fresh).
 */
export function getBridgeStatus(
  id: number,
): { level: number; keyed: boolean; running: boolean; reason: string | null } {
  const status = bridgeStatuses.get(id);
  if (status && Date.now() - status.updatedAt <= 4000) {
    return { level: status.level, keyed: status.keyed, running: true, reason: null };
  }
  const diag = bridgeDiagnostics.get(id);
  const reason = diag && Date.now() - diag.at <= REASON_TTL_MS ? diag.reason : null;
  return { level: 0, keyed: false, running: false, reason };
}

/**
 * Translate an ffmpeg *spawn* failure (the child process couldn't be started)
 * into an operator-readable reason. ENOENT means the binary is genuinely
 * missing; ENOMEM / EAGAIN mean the binary exists but the container couldn't
 * fork another ffmpeg — the common cause when one bridge runs fine but the
 * next won't start (too many concurrent ingests for the available memory/CPU).
 */
export function describeBridgeSpawnError(code: string | undefined, message: string): string {
  if (code === "ENOENT") {
    return "ffmpeg is not installed on the server — stream bridges cannot run.";
  }
  if (code === "ENOMEM" || code === "EAGAIN") {
    return `The server ran out of resources to start this bridge (${code}) — too many concurrent ffmpeg ingests for the available memory/CPU. Increase the container's resources or run fewer bridges at once.`;
  }
  return `ffmpeg could not start${code ? ` (${code})` : ""}: ${message}`.slice(0, 200);
}

/** Fields that, when changed, require the ingest to be rebuilt from scratch. */
function signatureOf(b: AgencyBridgeRow): string {
  return JSON.stringify([
    b.agency_id,
    b.name,
    b.source_url,
    b.target_channel,
    b.direction,
    b.yield_to_units,
    b.vox_threshold,
    b.vox_hang_ms,
    b.noise_suppression,
  ]);
}

/**
 * ffmpeg audio-filter chain for a bridge's noise-suppression setting, or null
 * for "off". A voice band-pass (≈200–3400 Hz) strips low hum and high hiss that
 * sit outside speech; "strong" adds the FFT denoiser `afftdn` for steady
 * static. Kept conservative so radio voice (incl. P25) stays intelligible.
 */
export function noiseFilterChain(level: string | undefined): string | null {
  switch (level) {
    case "light":
      return "highpass=f=200,lowpass=f=3400";
    case "strong":
      return "highpass=f=200,lowpass=f=3400,afftdn=nr=12:nf=-25";
    default:
      return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Probes for an ffmpeg binary on PATH exactly once per process. */
function ffmpegAvailable(): Promise<boolean> {
  if (!ffmpegReady) {
    ffmpegReady = new Promise<boolean>((resolve) => {
      const probe = spawn("ffmpeg", ["-hide_banner", "-version"]);
      probe.on("error", () => resolve(false));
      probe.on("exit", (code) => resolve(code === 0));
      probe.stdout?.resume();
      probe.stderr?.resume();
    });
  }
  return ffmpegReady;
}

/** Normalized RMS (0–1) of one mono 16-bit LE PCM frame. */
function frameRms(frame: Buffer): number {
  let sum = 0;
  const samples = frame.length >> 1;
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i << 1);
    sum += s * s;
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples) / 32768;
}

/**
 * Minimum spacing between ffmpeg ingest spawns. Reconciling several enabled
 * bridges at once (boot, or a respawn storm after the network blips) would
 * otherwise fork every ffmpeg in the same tick — and a *burst* of spawns is
 * what trips a container's process/memory limits (EAGAIN/ENOMEM) even when it
 * has ample headroom to keep them all running once started. Spacing the spawns
 * out costs a second or two of extra startup latency and removes the burst.
 */
const SPAWN_STAGGER_MS = 700;
let lastSpawnAt = 0;
let spawnChain: Promise<void> = Promise.resolve();

/** Resolves when it's this ingest's turn to spawn — at most one per stagger window. */
function nextFfmpegSpawnSlot(): Promise<void> {
  spawnChain = spawnChain.then(async () => {
    const wait = lastSpawnAt + SPAWN_STAGGER_MS - Date.now();
    if (wait > 0) {
      await delay(wait);
    }
    lastSpawnAt = Date.now();
  });
  return spawnChain;
}

/**
 * Supervises one stream bridge: an ffmpeg ingest piped — through a VOX gate —
 * into a loopback voice socket, respawned with backoff until `stop()`.
 */
function runBridge(bridge: AgencyBridgeRow): RunningBridge {
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let activeWs: WebSocket | null = null;

  const url = new URL(`ws://127.0.0.1:${loopbackPort}${VOICE_WS_PATH}`);
  url.searchParams.set("bridge", BRIDGE_LOOPBACK_SECRET);
  url.searchParams.set("agency", String(bridge.agency_id));
  url.searchParams.set("yields", bridge.yield_to_units ? "1" : "0");
  url.searchParams.set("name", bridge.name);
  const loopbackUrl = url.toString();

  /** One ingest attempt; resolves when the pipeline ends for any reason. */
  function runOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      let child: ChildProcessWithoutNullStreams | null = null;
      let carry: Buffer = Buffer.alloc(0);
      let lastActiveMs = 0;
      let meterLevel = 0;

      const ws = new WebSocket(loopbackUrl);
      activeWs = ws;

      const finish = (): void => {
        if (done) return;
        done = true;
        activeChild = null;
        activeWs = null;
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            /* already closing */
          }
        }
        resolve();
      };

      const startIngest = async (): Promise<void> => {
        if (done || stopped) {
          finish();
          return;
        }
        // Space out ffmpeg spawns so a multi-bridge reconcile doesn't burst-fork.
        await nextFfmpegSpawnSlot();
        if (done || stopped) {
          finish();
          return;
        }
        const noiseFilter = noiseFilterChain(bridge.noise_suppression);
        child = spawn("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          // Pace ingestion to real time. A no-op for genuine live streams (they
          // already arrive at 1x); for a file-like URL it stops ffmpeg dumping
          // the whole source at once and flooding the channel.
          "-re",
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_delay_max",
          "5",
          "-i",
          bridge.source_url ?? "",
          // Optional static/hiss suppression, applied before downmix/resample.
          ...(noiseFilter ? ["-af", noiseFilter] : []),
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-f",
          "s16le",
          "-",
        ]);
        activeChild = child;

        child.on("error", (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          console.warn(`bridge "${bridge.name}": ffmpeg failed to start — ${code ?? ""} ${err.message}`);
          setBridgeReason(bridge.id, describeBridgeSpawnError(code, err.message));
          finish();
        });
        child.on("exit", () => finish());
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8").trim();
          if (text) {
            console.warn(`bridge "${bridge.name}" ffmpeg:`, text.split("\n")[0]);
            const reason = describeBridgeIngestError(text);
            if (reason) {
              setBridgeReason(bridge.id, reason);
            }
          }
        });

        let gateWasOpen = false;
        child.stdout.on("data", (chunk: Buffer) => {
          carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
          while (carry.length >= FRAME_BYTES) {
            const frame = carry.subarray(0, FRAME_BYTES);
            carry = carry.subarray(FRAME_BYTES);
            const now = Date.now();
            const rms = frameRms(frame);
            if (rms >= bridge.vox_threshold) {
              lastActiveMs = now;
            }
            // VOX gate: forward while audio is present and through the hang tail.
            const gateOpen = lastActiveMs !== 0 && now - lastActiveMs < bridge.vox_hang_ms;
            // Publish a slow-decaying level so the console meter still catches
            // activity between its (~1 s) polls.
            meterLevel = Math.max(rms, meterLevel * 0.96);
            bridgeStatuses.set(bridge.id, { level: meterLevel, keyed: gateOpen, updatedAt: now });
            // Audio is flowing — clear any stale failure reason.
            bridgeDiagnostics.delete(bridge.id);
            if (gateOpen && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(frame);
              } catch {
                /* socket dropped — the close handler will tear down */
              }
            } else if (gateWasOpen && !gateOpen && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: "release_air" }));
              } catch {
                /* socket dropped */
              }
            }
            gateWasOpen = gateOpen;
          }
        });
      };

      ws.on("open", () => {
        try {
          ws.send(
            JSON.stringify({ type: "join", channel: bridge.target_channel, client: "bridge" }),
          );
        } catch {
          finish();
        }
      });
      ws.on("message", (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          return; // inbound channel audio — a stream-URL bridge has nowhere to play it
        }
        let msg: { type?: string; code?: string };
        try {
          msg = JSON.parse(raw.toString("utf8")) as { type?: string; code?: string };
        } catch {
          return;
        }
        if (msg.type === "joined") {
          void startIngest();
        } else if (msg.type === "error") {
          console.warn(`bridge "${bridge.name}": relay rejected join (${msg.code ?? "error"})`);
          setBridgeReason(
            bridge.id,
            msg.code === "unknown_channel"
              ? `Target channel "${bridge.target_channel}" does not exist — pick an existing channel for this bridge.`
              : `Relay rejected the bridge (${msg.code ?? "error"}).`,
          );
          finish();
        }
        // "busy" is expected when a yielding bridge is pre-empted — ignore it.
      });
      ws.on("error", (err) => {
        console.warn(`bridge "${bridge.name}": loopback socket error —`, err.message);
        finish();
      });
      ws.on("close", () => finish());
    });
  }

  void (async () => {
    if (!(await ffmpegAvailable())) {
      if (!ffmpegMissingLogged) {
        ffmpegMissingLogged = true;
        console.warn("Radio bridge worker: ffmpeg not found on PATH — stream bridges are idle.");
      }
      setBridgeReason(bridge.id, "ffmpeg is not installed on the server — stream bridges cannot run.");
      return;
    }
    console.log(
      `Radio bridge "${bridge.name}" → ${bridge.target_channel} ` +
        `(${bridge.yield_to_units ? "yields" : "holds"}) starting.`,
    );
    while (!stopped) {
      const startedAt = Date.now();
      await runOnce();
      if (stopped) break;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) {
        backoff = BACKOFF_MIN_MS;
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  })();

  return {
    signature: signatureOf(bridge),
    stop: () => {
      stopped = true;
      bridgeStatuses.delete(bridge.id);
      bridgeDiagnostics.delete(bridge.id);
      if (activeChild) {
        try {
          activeChild.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (activeWs) {
        try {
          activeWs.close();
        } catch {
          /* already closing */
        }
      }
    },
  };
}

/** Reconciles running ingests against the database. */
async function refresh(): Promise<void> {
  if (!getPool()) {
    return; // no database — nothing to drive
  }
  let bridges: AgencyBridgeRow[];
  try {
    bridges = await listEnabledStreamBridges();
  } catch (err) {
    console.warn("Radio bridge worker: could not load bridges —", (err as Error).message);
    return;
  }

  const wanted = new Map(bridges.map((b) => [b.id, b] as const));

  // Stop ingests for bridges that were removed, disabled, or materially changed.
  for (const [id, run] of running) {
    const next = wanted.get(id);
    if (!next || signatureOf(next) !== run.signature) {
      run.stop();
      running.delete(id);
    }
  }

  // Start ingests for newly enabled (or changed) bridges.
  for (const [id, bridge] of wanted) {
    if (!running.has(id)) {
      running.set(id, runBridge(bridge));
    }
  }
}

/** Starts the radio-bridge worker. Idempotent; safe to call once at boot. */
export function startBridgeWorker(options: { port: number }): void {
  if (pollTimer) {
    return;
  }
  loopbackPort = options.port;
  void refresh();
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  pollTimer.unref();
}

/** Stops every ingest and the poll loop. Used by tests and graceful shutdown. */
export function stopBridgeWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const run of running.values()) {
    run.stop();
  }
  running.clear();
  bridgeStatuses.clear();
  bridgeDiagnostics.clear();
}
