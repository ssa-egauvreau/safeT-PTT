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
 * Most recent ingest status for a stream bridge. `running` is false once the
 * status goes stale, so a stalled or stopped ingest reads as not running.
 */
export function getBridgeStatus(id: number): { level: number; keyed: boolean; running: boolean } {
  const status = bridgeStatuses.get(id);
  if (!status || Date.now() - status.updatedAt > 4000) {
    return { level: 0, keyed: false, running: false };
  }
  return { level: status.level, keyed: status.keyed, running: true };
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
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimum spacing between ffmpeg launches across all bridges. */
const LAUNCH_GAP_MS = 400;
/**
 * Serializes ffmpeg launches fleet-wide. On boot/redeploy every bridge finishes
 * its loopback handshake at almost the same instant and would `spawn` ffmpeg in
 * the same tick; that burst — stacked on the transcription worker processes —
 * blows past the container's process/thread limit and the kernel refuses the
 * fork with EAGAIN. Spacing launches a few hundred ms apart brings the fleet up
 * smoothly and de-synchronizes the retry storm that follows a wave of failures.
 */
let launchChain: Promise<void> = Promise.resolve();
function acquireLaunchSlot(): Promise<void> {
  const ready = launchChain;
  launchChain = launchChain.then(() => delay(LAUNCH_GAP_MS));
  return ready;
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
        // Stagger the fork so a fleet-wide (re)start doesn't hit the container's
        // process/thread limit all at once (spawn EAGAIN). Re-check liveness
        // after the wait — the socket may have closed while we were queued.
        await acquireLaunchSlot();
        if (done || stopped) {
          finish();
          return;
        }
        child = spawn("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          // One decode thread is plenty for a mono 16 kHz PCM ingest and keeps
          // each bridge's thread footprint small; with many bridges plus the
          // transcription workers, default multi-threading otherwise piles onto
          // the container's process/thread limit.
          "-threads",
          "1",
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
          console.warn(`bridge "${bridge.name}": ffmpeg failed to start —`, err.message);
          finish();
        });
        child.on("exit", () => finish());
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8").trim();
          if (text) {
            console.warn(`bridge "${bridge.name}" ffmpeg:`, text.split("\n")[0]);
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
      // Jitter so a wave of bridges that failed together (e.g. an EAGAIN burst)
      // doesn't retry in lockstep and re-trigger the same burst.
      await delay(backoff + Math.floor(Math.random() * 1000));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  })();

  return {
    signature: signatureOf(bridge),
    stop: () => {
      stopped = true;
      bridgeStatuses.delete(bridge.id);
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
}
