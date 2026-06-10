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
import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
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

// Live per-channel status for the desktop app's "Channels" panel: connection
// state plus the last transmission pushed to SafeT (start time, duration,
// count). Written at most once a second; purely best-effort.
const STATUS_FILE = "/tmp/sdr-bridge-status.json";
const chanStatus = new Map(); // bridge name -> mutable status row
let statusDirty = true;

function statusRow(b) {
  let r = chanStatus.get(b.name);
  if (!r) {
    r = {
      name: b.name,
      channel: b.target_channel,
      tgid: null,
      scan: false,
      state: "connecting",
      transmitting: false,
      lastFrameMs: 0,
      lastTxStartMs: null,
      lastTxEndMs: null,
      lastTxDurMs: null,
      txCount: 0,
      via: null, // for scan rows: which talkgroup fed the last clip
    };
    chanStatus.set(b.name, r);
  }
  return r;
}

function mark(b, patch) {
  Object.assign(statusRow(b), patch);
  statusDirty = true;
}

function markTxFrame(b, now, via = null) {
  const r = statusRow(b);
  if (!r.transmitting) {
    r.transmitting = true;
    r.lastTxStartMs = now;
    r.txCount++;
  }
  r.lastFrameMs = now;
  if (via) r.via = via;
  statusDirty = true;
}

let heartbeatTick = 0;
setInterval(() => {
  const now = Date.now();
  for (const r of chanStatus.values()) {
    // A transmission "ends" when frames stop arriving — the decoder simply goes
    // quiet at call end, so no closing frame ever comes.
    if (r.transmitting && now - r.lastFrameMs > 2000) {
      r.transmitting = false;
      r.lastTxEndMs = r.lastFrameMs;
      r.lastTxDurMs = Math.max(0, r.lastFrameMs - (r.lastTxStartMs ?? r.lastFrameMs));
      statusDirty = true;
    }
  }
  // Write on change, and at least every 5s regardless: the file's mtime is the
  // desktop app's PROOF OF LIFE for this process (pgrep proved unreliable).
  if (!statusDirty && ++heartbeatTick % 5 !== 0) return;
  statusDirty = false;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ updatedAt: now, bridges: [...chanStatus.values()] }));
  } catch {
    /* status is best-effort */
  }
}, 1000).unref();

// "Scan All" hub: monitor bridges (source /monitor) are fed by whichever
// talkgroup is currently keyed — a scanner that plays one call at a time. The
// first talkgroup to key "holds" the scan feed until it releases, so frames from
// different talkgroups never interleave into garble.
//
// The hold must expire on its own: the decoder simply STOPS sending UDP when a
// call ends, so the owning bridge never sees another frame and its VOX gate
// never closes — without the expiry the first talkgroup to key would hold the
// scan feed forever and every other talkgroup would be locked out.
const MONITOR_HOLD_EXPIRE_MS = 1500;
const monitor = {
  members: [], // { ws, bridge }
  holder: null,
  lastFrameMs: 0,
  add(ws, bridge) {
    this.members.push({ ws, bridge });
  },
  remove(ws) {
    this.members = this.members.filter((m) => m.ws !== ws);
  },
  claim(name) {
    const now = Date.now();
    if (this.holder !== null && now - this.lastFrameMs > MONITOR_HOLD_EXPIRE_MS) this.holder = null;
    if (this.holder === null) this.holder = name;
    if (this.holder !== name) return false;
    this.lastFrameMs = now;
    return true;
  },
  send(frame) {
    const now = Date.now();
    for (const m of this.members)
      if (m.ws.readyState === 1)
        try {
          m.ws.send(frame);
          markTxFrame(m.bridge, now, this.holder);
        } catch { /* drop */ }
  },
  release(name) {
    if (this.holder !== name) return;
    this.holder = null;
    for (const m of this.members)
      if (m.ws.readyState === 1) try { m.ws.send(JSON.stringify({ type: "release_air" })); } catch { /* drop */ }
  },
};

// Un-key the scan channels promptly when the holding call ends (no frame will
// arrive to trigger the gate-close release).
setInterval(() => {
  if (monitor.holder !== null && Date.now() - monitor.lastFrameMs > MONITOR_HOLD_EXPIRE_MS) {
    monitor.release(monitor.holder);
  }
}, 500).unref();

/**
 * Scan-All ingest: the decoder's TGID-0 stream carries EVERY clear call on the
 * system, each datagram prefixed with its 4-byte little-endian TGID. Demux by
 * TGID, claim the scan hub under the talkgroup's name (one call at a time —
 * real scanner behavior), upsample 8 kHz -> 16 kHz, and feed the hub. Bridged
 * talkgroups are skipped here: their own ingests already feed the hub.
 */
function runScanAllIngest(port, bridgedTgids, tgNames) {
  const sock = createSocket("udp4");
  let currentTg = null;
  let carry = Buffer.alloc(0);
  sock.on("message", (msg) => {
    if (msg.length < 6) return;
    const tgid = msg.readUInt32LE(0);
    if (bridgedTgids.has(tgid)) return;
    const name = tgNames.get(tgid) || `TG ${tgid}`;
    if (!monitor.claim(name)) return; // another call holds the scan feed
    if (currentTg !== tgid) {
      currentTg = tgid;
      carry = Buffer.alloc(0);
    }
    // 8 kHz mono s16le -> 16 kHz by sample doubling (fine for radio voice).
    const pcm = msg.subarray(4);
    const usable = pcm.length - (pcm.length % 2);
    const up = Buffer.alloc(usable * 2);
    for (let i = 0; i < usable; i += 2) {
      const s = pcm.readInt16LE(i);
      up.writeInt16LE(s, i * 2);
      up.writeInt16LE(s, i * 2 + 2);
    }
    carry = carry.length ? Buffer.concat([carry, up]) : up;
    while (carry.length >= FRAME_BYTES) {
      monitor.send(carry.subarray(0, FRAME_BYTES));
      carry = carry.subarray(FRAME_BYTES);
    }
  });
  sock.on("error", (e) => console.warn("[bridge] scan-all ingest error:", e.message));
  sock.bind(port, "127.0.0.1", () =>
    console.log(`[bridge] Scan All ingest: every clear talkgroup on the system (udp ${port})`),
  );
}

/** tgid -> alpha tag, from the generated talkgroups.csv (bridged + full system). */
function loadTalkgroupNames() {
  const names = new Map();
  try {
    const lines = readFileSync(join(ROOT, "trunk-recorder", "talkgroups.csv"), "utf8").split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const id = Number((c[0] ?? "").trim());
      if (Number.isFinite(id) && id > 0 && c[2]) names.set(id, c[2].trim());
    }
  } catch {
    /* names are nice-to-have */
  }
  return names;
}

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
          monitor.add(ws, bridge);
          registered = true;
          mark(bridge, { state: "on air" });
        } else if (m.type === "error") {
          console.warn(`[bridge] ${bridge.name}: relay rejected join (${m.code ?? "error"})`);
          mark(bridge, { state: `rejected (${m.code ?? "error"})` });
          finish();
        }
      };
      ws.onerror = () => finish();
      ws.onclose = (e) => {
        console.warn(`[bridge] ${bridge.name}: ws closed ${e && e.code != null ? e.code : ""}`);
        if (statusRow(bridge).state === "on air") mark(bridge, { state: "reconnecting" });
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
            if (open && ws.readyState === 1) {
              try {
                ws.send(frame);
                markTxFrame(bridge, now);
              } catch {
                /* drop */
              }
              // Also feed the Scan-All channels if we currently hold the feed.
              if (monitor.claim(bridge.name)) monitor.send(frame);
            } else if (gateWas && !open && ws.readyState === 1) {
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
          mark(bridge, { state: "on air" });
          startIngest();
        } else if (m.type === "error") {
          console.warn(`[bridge] ${bridge.name}: relay rejected join (${m.code ?? "error"})`);
          mark(bridge, { state: `rejected (${m.code ?? "error"})` });
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
        if (statusRow(bridge).state === "on air") mark(bridge, { state: "reconnecting" });
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

  // A bridge whose target is a SIMULCAST group transmits onto EVERY member
  // channel at once — almost never what you want for a scanner feed. Warn
  // loudly so a Scan All bridge pointed at an "all channels" group is obvious.
  let simulcastNames = new Set();
  try {
    const r = await api("GET", "/simulcast", { token: tokenRef.value });
    simulcastNames = new Set((r.simulcasts ?? []).map((s) => String(s.name).toLowerCase()));
  } catch {
    /* older server or non-operator account — skip the check */
  }

  const runnable = [];
  const monitors = [];
  for (const b of bridges) {
    if (b.source_type !== "stream_url" || !b.enabled) continue;
    if (simulcastNames.has(String(b.target_channel ?? "").toLowerCase())) {
      console.warn(
        `    ! WARNING: "${b.name}" targets the SIMULCAST group "${b.target_channel}" — ` +
          `its audio will key EVERY member channel at once. Point it at a single ` +
          `channel (e.g. a dedicated "Scanner" channel) instead.`,
      );
    }
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
    mark(b, { scan: true });
    runMonitorBridge(b);
  }
  for (const { bridge: b, port } of runnable) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (udp ${port})`);
    mark(b, { tgid: Number(String(b.source_url).match(/\/tg(\d+)\/?$/i)?.[1] ?? null) || null });
    runBridge(b, port);
  }

  // Scan All carries EVERY clear call on the system — not just the bridged
  // talkgroups — via the decoder's TGID-0 "everything" stream (when present).
  const scanPort = tgPort.get(0);
  if (monitors.length && scanPort) {
    const bridgedTgids = new Set(
      runnable
        .map(({ bridge: b }) => Number(String(b.source_url).match(/\/tg(\d+)\/?$/i)?.[1]))
        .filter(Number.isFinite),
    );
    runScanAllIngest(scanPort, bridgedTgids, loadTalkgroupNames());
  }
}

main().catch((e) => {
  console.error("local-bridge:", e.message);
  process.exit(1);
});
