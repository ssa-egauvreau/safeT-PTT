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

// "Scan All" hub: monitor bridges (source /monitor) are fed by whichever
// talkgroup is currently keyed — a scanner that plays one call at a time. The
// first talkgroup to key "holds" the scan feed until it releases, so frames from
// different talkgroups never interleave into garble.
const monitor = {
  sockets: [],
  holder: null,
  add(ws) {
    this.sockets.push(ws);
  },
  remove(ws) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  },
  claim(name) {
    if (this.holder === null) this.holder = name;
    return this.holder === name;
  },
  send(frame) {
    for (const ws of this.sockets) if (ws.readyState === 1) try { ws.send(frame); } catch { /* drop */ }
  },
  release(name) {
    if (this.holder !== name) return;
    this.holder = null;
    for (const ws of this.sockets)
      if (ws.readyState === 1) try { ws.send(JSON.stringify({ type: "release_air" })); } catch { /* drop */ }
  },
};

/** A monitor/Scan-All bridge: no ingest of its own — it joins its channel and
 * is fed by the talkgroup ingests via the `monitor` hub. */
function runMonitorBridge(bridge) {
  let stopped = false;
  let backoff = RECONNECT_MIN;
  function once() {
    return new Promise((done) => {
      const ws = new WS(`${wsBase()}/v1/voice/stream?token=${encodeURIComponent(tokenRef.value)}`);
      ws.binaryType = "arraybuffer";
      let registered = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (registered) monitor.remove(ws);
        try { ws.close(); } catch { /* closing */ }
        done();
      };
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: "join",
            channel: bridge.target_channel,
            unit_id: (bridge.name || "SCAN").slice(0, 12),
            client: "bridge",
            caps: [],
          }));
        } catch {
          finish();
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "joined") {
          console.log(`[bridge] ${bridge.name} -> ${bridge.target_channel}: on air (Scan All)`);
          monitor.add(ws);
          registered = true;
        } else if (m.type === "error") {
          console.warn(`[bridge] ${bridge.name}: relay rejected join (${m.code ?? "error"})`);
          finish();
        }
      };
      ws.onerror = () => finish();
      ws.onclose = (e) => {
        console.warn(`[bridge] ${bridge.name}: ws closed ${e && e.code != null ? e.code : ""}`);
        finish();
      };
    });
  }
  (async () => {
    while (!stopped) {
      const started = Date.now();
      try { await once(); } catch (e) { console.warn(`[bridge] ${bridge.name}:`, e.message); }
      if (stopped) break;
      if (Date.now() - started > 60000) backoff = RECONNECT_MIN;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, RECONNECT_MAX);
    }
  })();
  return { stop: () => (stopped = true) };
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
        monitor.release(bridge.name); // don't strand the Scan-All feed if we held it
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
        child.on("error", (e) => {
          console.warn(`[bridge] ${bridge.name} ffmpeg error: ${e.message}`);
          finish();
        });
        child.on("exit", (code) => {
          console.warn(`[bridge] ${bridge.name} ffmpeg exited (code ${code})`);
          finish();
        });
        child.stderr.on("data", (d) => {
          const s = d.toString().trim().split("\n")[0];
          if (s) console.warn(`[bridge] ${bridge.name} ffmpeg: ${s}`);
        });
        child.stdout.on("data", (chunk) => {
          carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          while (carry.length >= FRAME_BYTES) {
            const frame = carry.subarray(0, FRAME_BYTES);
            carry = carry.subarray(FRAME_BYTES);
            const now = Date.now();
            if (frameRms(frame) >= voxThreshold) lastActive = now;
            const open = lastActive !== 0 && now - lastActive < voxHang;
            // Log the gate edges only (not every 20 ms frame): a "▶ keying" line
            // is proof the bridge is forwarding a REAL decoded call to SafeT — so
            // a quiet-but-working bridge is distinguishable from a broken one.
            if (open && !gateWas) console.log(`[bridge] ▶ ${bridge.name}: keying — pushing audio to "${bridge.target_channel}"`);
            if (open && ws.readyState === 1) {
              try {
                ws.send(frame);
              } catch {
                /* drop */
              }
              // Also feed the Scan-All channels if we currently hold the feed.
              if (monitor.claim(bridge.name)) monitor.send(frame);
            } else if (gateWas && !open && ws.readyState === 1) {
              console.log(`[bridge] ■ ${bridge.name}: released "${bridge.target_channel}"`);
              try {
                ws.send(JSON.stringify({ type: "release_air" }));
              } catch {
                /* drop */
              }
              monitor.release(bridge.name);
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
      ws.onerror = () => {
        console.warn(`[bridge] ${bridge.name}: ws error`);
        finish();
      };
      ws.onclose = (e) => {
        const code = e && e.code != null ? e.code : "";
        const reason = e && e.reason ? ` ${e.reason}` : "";
        console.warn(`[bridge] ${bridge.name}: ws closed ${code}${reason}`);
        finish();
      };
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
  const monitors = [];
  for (const b of bridges) {
    if (b.source_type !== "stream_url" || !b.enabled) continue;
    if (/\/monitor\/?$/i.test(String(b.source_url))) {
      monitors.push(b); // Scan All / All CCCS — fed by every talkgroup
      continue;
    }
    const m = String(b.source_url).match(/\/tg(\d+)\/?$/i);
    if (!m) {
      console.log(`    • skip "${b.name}" (unrecognized source ${b.source_url})`);
      continue;
    }
    const port = tgPort.get(Number(m[1]));
    if (!port) {
      console.log(`    • skip "${b.name}" (TG ${m[1]} isn't in the decoder config)`);
      continue;
    }
    runnable.push({ bridge: b, port });
  }
  if (!runnable.length && !monitors.length) {
    console.error("local-bridge: no runnable bridges (check the bridges exist + sync ran).");
    process.exit(1);
  }
  console.log(`[bridge] pushing ${runnable.length} talkgroup + ${monitors.length} scan bridge(s) to SafeT (${wsBase()}):`);
  for (const b of monitors) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (Scan All — every talkgroup)`);
    runMonitorBridge(b);
  }
  for (const { bridge: b, port } of runnable) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (udp ${port})`);
    runBridge(b, port);
  }
}

main().catch((e) => {
  console.error("local-bridge:", e.message);
  process.exit(1);
});
