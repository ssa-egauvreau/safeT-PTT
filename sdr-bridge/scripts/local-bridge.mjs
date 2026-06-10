#!/usr/bin/env node
/**
 * local-bridge.mjs — push SDR audio to SafeT from THIS PC (the "Zello" model).
 *
 * Why: the SafeT server can't PULL the audio — the Cloudflare tunnel buffers
 * continuous streams and returns 5XX, so every server-side stream bridge fails.
 * So we bridge locally instead: for each enabled stream bridge, read its
 * talkgroup's UDP audio from the decoder (simplestream plugin) with an
 * in-process socket, pace it on a 20 ms clock with silence gap-fill, and PUSH
 * the voice to that bridge's SafeT channel over the same voice WebSocket the
 * SafeT apps use, connected as the configured admin account.
 *
 * Run from sdr-bridge/:  node scripts/local-bridge.mjs   (npm start launches it)
 */
import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// WebSocket: prefer the `ws` package — it exposes ping()/pong so the keepalive
// can detect half-open sockets (the built-in undici WebSocket cannot send
// pings). Fall back to the Node 22+ built-in when ws isn't installed.
let WS;
try {
  WS = (await import("ws")).WebSocket;
} catch {
  WS = globalThis.WebSocket;
}
if (!WS) {
  console.error("local-bridge: need WebSocket — run `npm install ws` in sdr-bridge (or use Node 22+).");
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config", "system.json"), "utf8"));
const safet = cfg.safet ?? {};
const baseUrl = String(safet.baseUrl ?? "").replace(/\/+$/, "");
const iceHost = cfg.icecast?.host ?? "127.0.0.1";
const icePort = cfg.icecast?.port ?? 8000;

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

/** Keepalive for a voice socket. Field logs showed every channel's WS dying
 * with 1006 in periodic batches — idle sockets reaped by NAT/proxies between
 * calls, only noticed when the NEXT call's first frames hit the dead socket
 * (eating the head of the call). Outbound traffic every 20s keeps the idle
 * timers from firing; with the `ws` package a real ping also detects a
 * half-open socket after ~60s and terminates it so the reconnect loop runs
 * BETWEEN calls instead of during one. Returns a cleanup function. */
function startKeepalive(ws) {
  let missedPongs = 0;
  if (typeof ws.on === "function") ws.on("pong", () => { missedPongs = 0; });
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    try {
      if (typeof ws.ping === "function") {
        if (++missedPongs >= 3) {
          (ws.terminate ?? ws.close).call(ws);
          return;
        }
        ws.ping();
      } else {
        ws.send('{"type":"ping"}'); // relay ignores unknown control types
      }
    } catch {
      /* send on a dying socket — close handler owns recovery */
    }
  }, 20000);
  timer.unref();
  return () => clearInterval(timer);
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
      rxFrames: 0, // datagrams routed into this channel's audio path
      rxBytes: 0,
      portFrames: 0, // raw datagrams seen on the per-TG UDP port (diagnostic —
      portBytes: 0, //  field data showed simplestream's per-TG streams skipping
      //               whole calls and emitting 2-byte junk; audio is routed from
      //               the tagged TGID-0 stream instead when it exists)
      lastFrameMs: 0,
      lastTxStartMs: null,
      lastTxEndMs: null,
      lastTxDurMs: null,
      lastTxAudioPct: null, // % of the keyed span that had real decoded audio
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
    r._txRx0 = r.rxBytes || 0; // decode-coverage baseline for this transmission
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
      // Decode coverage: what fraction of the keyed span was real decoded
      // audio (8 kHz s16 = 16000 B/s) vs silence gap-fill. The HEALTH METER
      // for simulcast decode quality — tune gain/antenna until this climbs.
      const expected = (r.lastTxDurMs / 1000) * 16000;
      const got = (r.rxBytes || 0) - (r._txRx0 ?? 0);
      r.lastTxAudioPct =
        !r.scan && expected > 300 ? Math.max(0, Math.min(100, Math.round((got / expected) * 100))) : null;
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
  /** holder name -> "end your silence hang now" (a paced sender's cut()). */
  cutters: new Map(),
  add(ws, bridge) {
    this.members.push({ ws, bridge });
  },
  remove(ws) {
    this.members = this.members.filter((m) => m.ws !== ws);
  },
  /** A REAL frame from `name` found the feed held by someone else. If that
   * holder is only keeping the feed warm with silence gap-fill, cut its hang
   * so the live call takes over now instead of after the ~2s tail. (cut() is
   * a no-op while real audio is still queued, so playback is never clipped.) */
  contend(name) {
    if (this.holder && this.holder !== name) this.cutters.get(this.holder)?.();
  },
  claim(name) {
    const now = Date.now();
    if (this.holder !== null && now - this.lastFrameMs > MONITOR_HOLD_EXPIRE_MS) this.holder = null;
    if (this.holder === null) this.holder = name;
    if (this.holder !== name) return false;
    this.lastFrameMs = now;
    return true;
  },
  send(frame, silent = false) {
    const now = Date.now();
    for (const m of this.members)
      if (m.ws.readyState === 1)
        try {
          m.ws.send(frame);
          if (!silent) markTxFrame(m.bridge, now, this.holder);
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

/** Raw s16le mono 8 kHz -> 16 kHz by sample doubling (fine for radio voice). */
function upsample8to16(pcm) {
  const usable = pcm.length - (pcm.length % 2);
  const up = Buffer.alloc(usable * 2);
  for (let i = 0; i < usable; i += 2) {
    const s = pcm.readInt16LE(i);
    up.writeInt16LE(s, i * 2);
    up.writeInt16LE(s, i * 2 + 2);
  }
  return up;
}

/** Real-time frame pacing + gap fill: the decoder flushes audio in bursts WITH
 * GAPS where decode failed, and the relay un-keys a channel 900ms after its
 * last frame — so one gappy radio call lands on SafeT as several sub-second
 * clips that record as "0s". Release queued frames on a 20ms clock; when the
 * queue runs dry mid-call, keep the channel keyed with silence frames until
 * the gap exceeds `hangMs` (call over), then fire `onHangEnd` once so the
 * owner can un-key crisply.
 *
 * `prerollMs` is a jitter buffer: the decoder delivers audio in uneven bursts
 * (field symptom: 0.3s audio / 0.5s silence / 0.2s audio), so playback of a
 * NEW call starts that far behind arrival — the standing backlog absorbs
 * burst gaps up to the pre-roll without ever going silent mid-sentence.
 *
 * `ready` gates the clock: while false (socket reconnecting) frames are HELD,
 * not dropped — the call resumes complete (a beat late) instead of losing its
 * head. Backlog capped at ~5s so the feed stays near-live. */
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);
function makePacedSender(emit, { hangMs = 2000, prerollMs = 600, onHangEnd, ready = () => true } = {}) {
  const queue = [];
  let clock = null;
  let lastRealMs = null; // wall time real audio last flowed (null = between calls)
  const timer = setInterval(() => {
    const now = Date.now();
    if (!ready()) {
      clock = null; // re-anchor pacing when the socket comes back
      if (queue.length > 250) queue.splice(0, queue.length - 250);
      return;
    }
    if (queue.length) {
      if (clock === null) clock = now;
      while (queue.length && clock <= now) {
        emit(queue.shift(), false);
        clock += 20;
      }
      lastRealMs = now;
      if (queue.length > 250) queue.splice(0, queue.length - 250);
      return;
    }
    if (lastRealMs !== null && now - lastRealMs < hangMs) {
      // Decode gap mid-call: hold the key with silence so the relay's TTL
      // can't split the call into blips.
      if (clock === null) clock = now;
      while (clock <= now) {
        emit(SILENCE_FRAME, true);
        clock += 20;
      }
      return;
    }
    clock = null;
    if (lastRealMs !== null) {
      lastRealMs = null;
      onHangEnd?.();
    }
  }, 10);
  timer.unref();
  return {
    push: (frame) => {
      // First frame of a NEW call: anchor the clock a pre-roll into the
      // future so a jitter buffer builds before playback starts.
      if (clock === null && lastRealMs === null && !queue.length) clock = Date.now() + prerollMs;
      queue.push(frame);
    },
    /** Real frames still queued (a call is mid-playback)? */
    draining: () => queue.length > 0,
    /** End the silence hang NOW (a different call wants the air). */
    cut: () => {
      if (!queue.length && lastRealMs !== null) {
        lastRealMs = null;
        clock = null;
        onHangEnd?.();
      }
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Tagged-stream ingest: the decoder's TGID-0 stream carries EVERY clear call
 * on the system, each datagram prefixed with its 4-byte little-endian TGID.
 * Bridged talkgroups route to their channel's audio path (`tgRoutes` — the
 * per-TG simplestream streams proved unreliable in the field, skipping whole
 * calls); everything else feeds the Scan-All hub, claimed under the
 * talkgroup's name one call at a time like a real scanner.
 */
function runScanAllIngest(port, tgRoutes, tgNames) {
  const sock = createSocket("udp4");
  let currentTg = null;
  let currentName = null;
  let carry = Buffer.alloc(0);
  const paced = makePacedSender(
    (frame, silent) => {
      // Claim on every emitted frame — silence fill included — so the hold
      // survives decode gaps and the call stays ONE transmission on scan.
      if (currentName && monitor.claim(currentName)) monitor.send(frame, silent);
    },
    {
      onHangEnd: () => {
        if (currentName) monitor.release(currentName);
        currentTg = null;
        currentName = null;
      },
    },
  );

  sock.on("message", (msg) => {
    if (msg.length < 6) return;
    const tgid = msg.readUInt32LE(0);
    const route = tgRoutes.get(tgid);
    if (route) {
      route(msg.subarray(4)); // a bridged talkgroup — its channel's audio path
      return;
    }
    const name = tgNames.get(tgid) || `TG ${tgid}`;
    if (currentTg !== null && tgid !== currentTg) {
      if (paced.draining()) return; // previous call still playing — one at a time
      paced.cut(); // only hanging on silence: yield the feed to the new call
    }
    if (!monitor.claim(name)) {
      monitor.contend(name); // holder may just be silence-hanging — cut it
      return;
    }
    if (currentTg !== tgid) {
      currentTg = tgid;
      currentName = name;
      carry = Buffer.alloc(0);
      monitor.cutters.set(name, () => paced.cut());
    }
    carry = carry.length ? Buffer.concat([carry, upsample8to16(msg.subarray(4))]) : upsample8to16(msg.subarray(4));
    while (carry.length >= FRAME_BYTES) {
      paced.push(carry.subarray(0, FRAME_BYTES));
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
      const stopKeepalive = startKeepalive(ws);
      let registered = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        stopKeepalive();
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

/**
 * One talkgroup -> one SafeT channel. `portIsPrimary` picks the audio source:
 * false (the normal case) means audio is routed in from the decoder's tagged
 * TGID-0 stream via `writeTagged` and the per-TG UDP port is only COUNTED
 * (field data showed simplestream's per-TG streams skipping whole calls and
 * emitting 2-byte junk while the tagged stream delivered); true means no
 * tagged stream exists and the per-TG port feeds the audio path directly.
 */
function runBridge(bridge, udpPort, { portIsPrimary = false } = {}) {
  let stopped = false;
  let backoff = RECONNECT_MIN;
  const srow = statusRow(bridge);

  // ---- ingest: lives for the BRIDGE's lifetime, not one connection's ----
  // Audio captured while the voice socket is reconnecting is HELD in the
  // paced queue, not dropped — a reconnect no longer eats the call's head.
  let ws = null; // current voice socket, only set while joined ("on air")
  let carry = Buffer.alloc(0);
  const onAir = () => ws !== null && ws.readyState === 1;
  const paced = makePacedSender(
    (frame, silent) => {
      if (onAir()) {
        try {
          ws.send(frame);
          if (!silent) markTxFrame(bridge, Date.now());
        } catch {
          /* drop — close handler owns recovery */
        }
      }
      // Also feed the Scan-All channels. Silence fill claims too, so the scan
      // hold survives decode gaps and the call stays one transmission there.
      if (monitor.claim(bridge.name)) monitor.send(frame, silent);
      else if (!silent) monitor.contend(bridge.name);
    },
    {
      ready: onAir,
      onHangEnd: () => {
        // Un-key crisply instead of letting the relay's TTL time out.
        if (onAir()) {
          try { ws.send(JSON.stringify({ type: "release_air" })); } catch { /* closing */ }
        }
        monitor.release(bridge.name);
      },
    },
  );
  monitor.cutters.set(bridge.name, () => paced.cut());

  // NO VOX gate: the decoder only ever sends voice (field data showed the
  // gate eating entire calls — 60 packets in, 0 frames out).
  const ingestPcm = (pcm) => {
    if (pcm.length < 4) return; // simplestream sometimes emits 2-byte (one-sample) junk
    srow.rxFrames++;
    srow.rxBytes = (srow.rxBytes || 0) + pcm.length;
    carry = carry.length ? Buffer.concat([carry, upsample8to16(pcm)]) : upsample8to16(pcm);
    while (carry.length >= FRAME_BYTES) {
      paced.push(carry.subarray(0, FRAME_BYTES));
      carry = carry.subarray(FRAME_BYTES);
    }
  };

  const openIngest = () => {
    if (stopped) return;
    const sock = createSocket("udp4");
    sock.on("error", (e) => {
      console.warn(`[bridge] ${bridge.name} udp ${udpPort}: ${e.message} — re-binding in 5s`);
      try { sock.close(); } catch { /* closed */ }
      setTimeout(openIngest, 5000).unref();
    });
    sock.on("message", (msg) => {
      srow.portFrames = (srow.portFrames || 0) + 1;
      srow.portBytes = (srow.portBytes || 0) + msg.length;
      if (portIsPrimary) ingestPcm(msg);
    });
    sock.bind(udpPort, "127.0.0.1", () =>
      console.log(`[bridge] ${bridge.name}: listening on udp ${udpPort}${portIsPrimary ? "" : " (diagnostic only — audio rides the tagged stream)"}`),
    );
  };
  openIngest();

  // ---- voice socket: reconnect loop swaps `ws` in and out ----
  function once() {
    return new Promise((done) => {
      const w = new WS(`${wsBase()}/v1/voice/stream?token=${encodeURIComponent(tokenRef.value)}`);
      w.binaryType = "arraybuffer";
      const stopKeepalive = startKeepalive(w);
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        stopKeepalive();
        if (ws === w) {
          ws = null;
          monitor.release(bridge.name); // don't strand the Scan-All feed
        }
        try {
          w.close();
        } catch {
          /* closing */
        }
        done();
      };

      w.onopen = () => {
        try {
          w.send(JSON.stringify({
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
      w.onmessage = (ev) => {
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
          ws = w;
        } else if (m.type === "error") {
          console.warn(`[bridge] ${bridge.name}: relay rejected join (${m.code ?? "error"})`);
          mark(bridge, { state: `rejected (${m.code ?? "error"})` });
          if (/auth|token|unauth|expired|forbidden/i.test(String(m.code ?? ""))) void relogin();
          finish();
        }
      };
      w.onerror = () => {
        console.warn(`[bridge] ${bridge.name}: ws error`);
        finish();
      };
      w.onclose = (e) => {
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

  return { stop: () => (stopped = true), writeTagged: ingestPcm };
}

async function main() {
  if (!baseUrl || !safet.username || !safet.password) {
    console.error("local-bridge: config/system.json needs safet.baseUrl / username / password.");
    process.exit(1);
  }

  // Kill orphaned UDP readers from a previous bridge run FIRST. A crashed
  // bridge leaves its ffmpegs alive holding the per-talkgroup ports; a new
  // ffmpeg binds the same port "successfully" (SO_REUSEADDR) but the kernel
  // keeps delivering packets to the zombie — every channel silent while the
  // decoder records happily.
  try {
    spawnSync("pkill", ["-9", "-f", "i udp://127.0.0.1:9"]);
    await new Promise((r) => setTimeout(r, 300));
  } catch {
    /* pkill unavailable — run-all's cleanup is the backstop */
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
  // The decoder's TGID-0 "everything" stream (when present) is the PRIMARY
  // audio source: bridged talkgroups demux out of it (the per-TG streams
  // proved unreliable — whole calls skipped), the rest feeds Scan All.
  const scanPort = tgPort.get(0);

  console.log(`[bridge] pushing ${runnable.length} talkgroup + ${monitors.length} scan bridge(s) to SafeT (${wsBase()}):`);
  for (const b of monitors) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (Scan All — every talkgroup)`);
    mark(b, { scan: true });
    runMonitorBridge(b);
  }
  const tgRoutes = new Map(); // tgid -> that channel's audio-path write fn
  for (const { bridge: b, port } of runnable) {
    console.log(`    • ${b.name}  ->  channel "${b.target_channel}"  (udp ${port})`);
    const tgid = Number(String(b.source_url).match(/\/tg(\d+)\/?$/i)?.[1] ?? null) || null;
    mark(b, { tgid });
    const handle = runBridge(b, port, { portIsPrimary: !scanPort });
    if (scanPort && tgid) tgRoutes.set(tgid, handle.writeTagged);
  }

  if (scanPort && (monitors.length || tgRoutes.size)) {
    runScanAllIngest(scanPort, tgRoutes, loadTalkgroupNames());
  } else if (!scanPort) {
    console.warn(
      "[bridge] no TGID-0 tagged stream in the decoder config — per-talkgroup " +
        "UDP feeds the channels directly (less reliable) and Scan All is unavailable.",
    );
  }
}

main().catch((e) => {
  console.error("local-bridge:", e.message);
  process.exit(1);
});
