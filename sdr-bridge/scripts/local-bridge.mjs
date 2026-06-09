#!/usr/bin/env node
/**
 * local-bridge.mjs — push SDR audio to SafeT from THIS PC (the "Zello" model).
 *
 * Why: the SafeT server can't PULL the audio — the Cloudflare tunnel buffers
 * continuous streams and returns 5XX, so every server-side stream bridge fails.
 * So we bridge locally instead: for each enabled stream bridge, read its
 * talkgroup mount over LOCALHOST Icecast (no tunnel), VOX-gate it, and PUSH the
 * voice to that bridge's SafeT channel over the same voice WebSocket the SafeT
 * apps use. Reuses the server bridge worker's ffmpeg -> PCM -> VOX -> frames
 * approach, but connects as the configured admin account over the public relay.
 *
 * Run from sdr-bridge/:  node scripts/local-bridge.mjs   (npm start launches it)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// WebSocket: Node 22+ has it built in; otherwise fall back to the `ws` package.
let WS = globalThis.WebSocket;
if (!WS) {
  try {
    WS = (await import("ws")).WebSocket;
  } catch {
    console.error("local-bridge: need WebSocket — run `npm install ws` in sdr-bridge (or use Node 22+).");
    process.exit(1);
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config", "system.json"), "utf8"));
const safet = cfg.safet ?? {};
const baseUrl = String(safet.baseUrl ?? "").replace(/\/+$/, "");
const iceHost = cfg.icecast?.host ?? "127.0.0.1";
const icePort = cfg.icecast?.port ?? 8000;

const SAMPLE_RATE = 16000; // relay expects raw PCM mono 16-bit LE @ 16 kHz
const FRAME_BYTES = 640; // 20 ms
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 30000;

function wsBase() {
  const u = new URL(baseUrl); // e.g. https://safet-ptt.com/v1
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error ?? text}`);
  return json;
}

async function login() {
  const r = await api("POST", "/auth/login", {
    body: {
      username: safet.username,
      password: safet.password,
      ...(safet.agencySlug ? { agency_slug: safet.agencySlug } : {}),
    },
  });
  if (!r.token) throw new Error("login returned no token");
  return r.token;
}

function mountFromUrl(u) {
  const m = String(u).match(/\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

/** Normalized RMS (0–1) of a mono 16-bit LE PCM frame. */
function frameRms(frame) {
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i << 1);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) / 32768 : 0;
}

// Shared token + de-bounced re-login. NOTE: a fresh login drops this account's
// other voice sockets server-side, so we only re-login when a join is rejected
// for auth — not on a timer.
const tokenRef = { value: null };
let reloginInFlight = null;
function relogin() {
  if (!reloginInFlight) {
    reloginInFlight = login()
      .then((t) => {
        tokenRef.value = t;
      })
      .catch((e) => console.warn("local-bridge: re-login failed —", e.message))
      .finally(() => {
        reloginInFlight = null;
      });
  }
  return reloginInFlight;
}

function runBridge(bridge, udpPort) {
  // Read the decoder's per-talkgroup UDP directly (raw s16le mono 8 kHz) — no
  // Icecast in the path, so nothing flaky to depend on. ffmpeg simply blocks
  // between calls (no packets) and resumes when the next call's audio arrives.
  const inUrl = `udp://127.0.0.1:${udpPort}?fifo_size=1000000&overrun_nonfatal=1`;
  const voxThreshold = Number(bridge.vox_threshold ?? 0.02);
  const voxHang = Number(bridge.vox_hang_ms ?? 1500);
  let stopped = false;
  let backoff = RECONNECT_MIN;

  function once() {
    return new Promise((done) => {
      const token = tokenRef.value;
      const ws = new WS(`${wsBase()}/v1/voice/stream?token=${encodeURIComponent(token)}`);
      ws.binaryType = "arraybuffer";
      let child = null;
      let carry = Buffer.alloc(0);
      let lastActive = 0;
      let gateWas = false;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          child && child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        try {
          ws.close();
        } catch {
          /* closing */
        }
        done();
      };

      const startIngest = () => {
        if (stopped) return finish();
        child = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-f", "s16le", "-ar", "8000", "-ac", "1",
          "-i", inUrl,
          "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
        ]);
        child.on("error", finish);
        child.on("exit", finish);
        child.stderr.on("data", () => {});
        child.stdout.on("data", (chunk) => {
          carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          while (carry.length >= FRAME_BYTES) {
            const frame = carry.subarray(0, FRAME_BYTES);
            carry = carry.subarray(FRAME_BYTES);
            const now = Date.now();
            if (frameRms(frame) >= voxThreshold) lastActive = now;
            const open = lastActive !== 0 && now - lastActive < voxHang;
            if (open && ws.readyState === 1) {
              try {
                ws.send(frame);
              } catch {
                /* drop */
              }
            } else if (gateWas && !open && ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: "release_air" }));
              } catch {
                /* drop */
              }
            }
            gateWas = open;
          }
        });
      };

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: "join",
            channel: bridge.target_channel,
            unit_id: (bridge.name || "SDR").slice(0, 12),
            client: "bridge",
            caps: [],
          }));
        } catch {
          finish();
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return; // inbound channel audio — ignore
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "joined") {
          console.log(`[bridge] ${bridge.name} -> ${bridge.target_channel}: on air`);
          startIngest();
        } else if (m.type === "error") {
          console.warn(`[bridge] ${bridge.name}: relay rejected join (${m.code ?? "error"})`);
          if (/auth|token|unauth|expired|forbidden/i.test(String(m.code ?? ""))) void relogin();
          finish();
        }
      };
      ws.onerror = () => finish();
      ws.onclose = () => finish();
    });
  }

  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await once();
      } catch (e) {
        console.warn(`[bridge] ${bridge.name}:`, e.message);
      }
      if (stopped) break;
      if (Date.now() - started > 60000) backoff = RECONNECT_MIN;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, RECONNECT_MAX);
    }
  })();

  return { stop: () => (stopped = true) };
}

async function main() {
  if (!baseUrl || !safet.username || !safet.password) {
    console.error("local-bridge: config/system.json needs safet.baseUrl / username / password.");
    process.exit(1);
  }
  tokenRef.value = await login();

  // Map talkgroup id -> UDP port from the decoder config the sync just wrote.
  const tgPort = new Map();
  try {
    const tr = JSON.parse(readFileSync(join(ROOT, "trunk-recorder", "config.json"), "utf8"));
    const streams = (tr.plugins ?? []).find((p) => p.name === "simplestream")?.streams ?? [];
    for (const s of streams) tgPort.set(Number(s.TGID), Number(s.port));
  } catch (e) {
    console.error("local-bridge: could not read trunk-recorder/config.json —", e.message);
    process.exit(1);
  }

  const bridges = (await api("GET", "/admin/bridges", { token: tokenRef.value })).bridges ?? [];
  const runnable = [];
  for (const b of bridges) {
    if (b.source_type !== "stream_url" || !b.enabled) continue;
    const m = String(b.source_url).match(/\/tg(\d+)\/?$/i);
    if (!m) {
      console.log(`    • skip "${b.name}" (not a single talkgroup — e.g. /monitor)`);
      continue;
    }
    const port = tgPort.get(Number(m[1]));
    if (!port) {
      console.log(`    • skip "${b.name}" (TG ${m[1]} isn't in the decoder config)`);
      continue;
    }
    runnable.push({ bridge: b, port });
  }
  if (!runnable.length) {
    console.error("local-bridge: no runnable talkgroup bridges (check the bridges exist + sync ran).");
    process.exit(1);
  }
  console.log(`[bridge] pushing ${runnable.length} bridge(s) to SafeT (${wsBase()}) straight from the decoder's UDP:`);
  for (const { bridge: b, port } of runnable) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (udp ${port})`);
    runBridge(b, port);
  }
}

main().catch((e) => {
  console.error("local-bridge:", e.message);
  process.exit(1);
});
