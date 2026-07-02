#!/usr/bin/env node
/**
 * sdrtrunk-bridge.mjs — push sdrtrunk-decoded calls to SafeT (the sdrtrunk
 * decoder path; trunk-recorder users run local-bridge.mjs instead).
 *
 * sdrtrunk decodes the P25 simulcast system on Windows (its LSM equalizer
 * handles the multi-tower distortion an RTL-SDR + trunk-recorder can't) and
 * uploads each FINISHED call to us via its RdioScanner broadcaster. We accept
 * the upload, ffmpeg-decode the audio to 16 kHz PCM, and push the whole call
 * onto its SafeT channel (and the Scan All channels) over the same voice
 * WebSocket the SafeT apps use. One upload = one complete SafeT transmission:
 * no live stream to gate, no partial audio, exact call boundaries, real
 * talkgroup labels.
 *
 * Run from sdr-bridge/:  node scripts/sdrtrunk-bridge.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCallUploadServer } from "./lib/sdrtrunk-rdio.mjs";

let WS;
try {
  WS = (await import("ws")).WebSocket;
} catch {
  WS = globalThis.WebSocket;
}
if (!WS) {
  console.error("sdrtrunk-bridge: need WebSocket — run `npm install ws` in sdr-bridge (or Node 22+).");
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config", "system.json"), "utf8"));
const safet = cfg.safet ?? {};
const baseUrl = String(safet.baseUrl ?? "").replace(/\/+$/, "");
const UPLOAD_PORT = Number(cfg.sdrtrunk?.uploadPort) || 8765;
const FRAME_BYTES = 640; // 20 ms @ 16 kHz mono s16le
const FRAME_MS = 20;

// Auth: the bridge logs in with a CONSOLE account, whose JWT expires after the
// server's 12h TOKEN_TTL. The relay only checks the token at the WS UPGRADE, so a
// socket that's already open survives token expiry — but the FIRST reconnect past
// the 12h mark is 401'd, and the old code then retried the SAME dead token forever
// (audio gone, no self-recovery: the 6/27 6:30 AM outage). Fix: on a confirmed
// 401/403 at the upgrade, re-authenticate and reconnect with the fresh token.
// Re-login ONLY on a real auth failure, never on a timer — a fresh login bumps
// this account's token generation and would supersede the bridge's own still-open
// sockets (matches local-bridge.mjs's hard-won note).
let token = null;
const ALL_DOWN_EXIT_MS = 5 * 60 * 1000; // every channel offline this long -> exit for a clean relaunch
const channels = []; // every Channel, so the health backstop can see if all are down
let allDownSince = 0;

function wsBase() {
  const u = new URL(baseUrl);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
}

async function login() {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: safet.username, password: safet.password, ...(safet.agencySlug ? { agency_slug: safet.agencySlug } : {}) }),
  });
  if (!res.ok) throw new Error(`login -> ${res.status}`);
  const j = await res.json();
  if (!j.token) throw new Error("login returned no token");
  return j.token;
}

async function getBridges(token) {
  const res = await fetch(`${baseUrl}/admin/bridges`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`bridges -> ${res.status}`);
  return (await res.json()).bridges ?? [];
}

/** Re-authenticate and swap in a fresh module-level token. Guarded so overlapping
 *  triggers (the periodic refresh plus several sockets failing auth at once) share
 *  one login. Already-open sockets keep running — the relay only checks the token
 *  at the upgrade — so the fresh token is simply what the NEXT (re)connect uses. */
let reloginPromise = null;
async function refreshToken(reason = "scheduled") {
  if (reloginPromise) return reloginPromise;
  reloginPromise = (async () => {
    try {
      token = await login();
      console.log(`[sdrtrunk] re-authenticated (${reason}).`);
    } catch (e) {
      console.warn(`[sdrtrunk] re-auth failed (${reason}): ${e.message}`);
    } finally {
      reloginPromise = null;
    }
  })();
  return reloginPromise;
}

/** ffmpeg-decode an uploaded call (MP3/M4A/WAV) to 16 kHz mono s16le PCM.
 *  SDRTRUNK_RAW_PCM=1 is a test hook: treat the upload as already-decoded
 *  16 kHz s16le PCM and skip ffmpeg (lets the harness exercise routing without
 *  a real audio codec installed). */
function decodeToPcm(audio) {
  if (process.env.SDRTRUNK_RAW_PCM === "1") return Promise.resolve(audio);
  return new Promise((res, rej) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]);
    const out = [];
    let err = "";
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", rej);
    ff.on("close", (code) => (code === 0 ? res(Buffer.concat(out)) : rej(new Error(err.trim() || `ffmpeg exit ${code}`))));
    ff.stdin.on("error", () => {}); // ignore EPIPE if ffmpeg bails early
    ff.stdin.end(audio);
  });
}

function frameify(pcm) {
  const frames = [];
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) frames.push(pcm.subarray(i, i + FRAME_BYTES));
  return frames;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Live per-channel status for the desktop "Channels" panel (same shape the
// trunk-recorder bridge writes, so the UI is unchanged).
const STATUS_FILE = "/tmp/sdr-bridge-status.json";
const SCAN_RECENT_CAP = 20; // how many recent calls each scan feed remembers
const rows = new Map();
let statusDirty = true;
let heartbeatTick = 0;
// Freeze-detection feed for the desktop watchdog: sdrtrunk can hang without
// dying (heap-exhaustion GC spiral — process "up", zero calls). We stamp when
// the LAST call upload arrived (and when this bridge started, so "no calls
// yet" is measurable too); the watchdog restarts sdrtrunk when the gap grows
// past its stall threshold. Both stamps use this (WSL) clock, same as
// updatedAt, so the comparison is immune to Windows/WSL clock skew.
const startedAtMs = Date.now();
let lastCallUploadMs = 0;

// Roster of every talkgroup heard (tgid -> {label, count, lastHeardMs}), reported
// to the SafeT server every ~30s so the console can offer a "discovered → add"
// picker. The bridge is the only place that knows a call's numeric talkgroup id.
const seenTgs = new Map();
async function reportObservedTalkgroups() {
  if (!token || !seenTgs.size) return;
  const talkgroups = [...seenTgs.entries()].map(([tgid, s]) => ({ tgid, label: s.label, count: s.count, lastHeardMs: s.lastHeardMs }));
  try {
    await fetch(`${baseUrl}/admin/bridges/observed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ talkgroups }),
    });
  } catch {
    /* best-effort — the console picker just won't refresh */
  }
}
function row(name, channel, scan = false, tgid = null) {
  let r = rows.get(name);
  if (!r) {
    r = { name, channel, tgid, scan, state: "connecting", transmitting: false, rxFrames: 0, rxBytes: 0, portFrames: 0, portBytes: 0, lastFrameMs: 0, lastTxStartMs: null, lastTxEndMs: null, lastTxDurMs: null, lastTxAudioPct: null, txCount: 0, via: null, recent: [] };
    rows.set(name, r);
  }
  return r;
}
setInterval(() => {
  // Write on change, AND at least every 5s regardless: the file's mtime is the
  // desktop app's PROOF OF LIFE for this bridge. Without the heartbeat the file
  // goes stale between calls and the dashboard reads "Stopped" (calls only
  // refresh it when they happen, and quiet talkgroups can idle for minutes).
  if (!statusDirty && ++heartbeatTick % 5 !== 0) return;
  statusDirty = false;
  // Atomic write: a plain writeFileSync lets the desktop's `cat` catch a
  // half-written file (JSON.parse throws → the Channels panel blanks). Writing a
  // temp file then rename(2)-ing it within /tmp is atomic, so a reader always
  // sees a COMPLETE file. The replacer drops `_`-prefixed internal bookkeeping.
  try {
    const json = JSON.stringify(
      { updatedAt: Date.now(), startedAtMs, lastCallUploadMs, bridges: [...rows.values()] },
      (k, v) => (k[0] === "_" ? undefined : v),
    );
    const tmp = STATUS_FILE + ".tmp";
    writeFileSync(tmp, json);
    renameSync(tmp, STATUS_FILE);
  } catch {
    /* best-effort */
  }
}, 1000).unref();

/** One SafeT channel: a self-healing voice socket that plays whole calls in
 *  order. Calls are queued so two uploads for the same channel never garble. */
class Channel {
  constructor(channelName, unit, scan = false, tgid = null) {
    this.channelName = channelName;
    this.unit = (unit || channelName || "SDR").slice(0, 12);
    this.ws = null;
    this.queue = [];
    this.draining = false;
    this.backoffMs = 2000; // grows on repeated drops, resets after a stable connection
    this.row = row(unit || channelName, channelName, scan, tgid);
    channels.push(this);
    this.connect();
  }
  connect() {
    const connectedAt = Date.now();
    const ws = new WS(`${wsBase()}/v1/voice/stream?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    // Keepalive: idle voice sockets get reaped by NAT/proxies between calls
    // (1006 in batches — see local-bridge.mjs), only noticed when the next call's
    // first frames hit the dead socket. A 20s ping keeps idle timers from firing
    // AND, after ~3 missed pongs (~60s), terminates a half-open socket so the
    // reconnect runs BETWEEN calls instead of eating the head of the next one.
    let missedPongs = 0;
    ws.on?.("pong", () => { missedPongs = 0; });
    const ka = setInterval(() => {
      if (ws.readyState !== 1) return;
      try {
        if (typeof ws.ping === "function") {
          if (++missedPongs >= 3) { (ws.terminate ?? ws.close).call(ws); return; }
          ws.ping();
        } else {
          ws.send('{"type":"ping"}'); // relay ignores unknown control types
        }
      } catch { /* dying — drop handler owns recovery */ }
    }, 20000);
    ka.unref?.();
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: "join", channel: this.channelName, unit_id: this.unit, client: "bridge", caps: [] })); } catch { /* closing */ }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "joined") {
        this.ws = ws;
        this.row.state = "on air";
        statusDirty = true;
        console.log(`[sdrtrunk] ${this.row.name} -> ${this.channelName}: on air`);
      } else if (m.type === "error") {
        this.row.state = `rejected (${m.code ?? "error"})`;
        statusDirty = true;
      }
    };
    // A failing socket fires BOTH onerror and onclose. Without the once-guard
    // each firing scheduled its own reconnect, so live connections doubled on
    // every blip (1 → 2 → 4 → 8 …) and the roster showed the bridge joined to
    // each channel many times over.
    let dropped = false;
    let authRejected = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearInterval(ka);
      try { ws.close(); } catch { /* already dead */ }
      if (this.ws === ws) {
        this.ws = null;
        if (this.row.state === "on air") { this.row.state = "reconnecting"; statusDirty = true; }
      }
      // A 401/403 at the upgrade means the token is expired or superseded — it
      // will NEVER succeed on retry with the SAME token. Refresh it first so the
      // reconnect below carries a valid one (the 6/27 6:30 AM outage fix).
      if (authRejected) {
        this.row.state = "reauthenticating";
        statusDirty = true;
        void refreshToken("401 on upgrade");
      }
      // A connection that stayed up >60s was healthy — reset the backoff. Rapid
      // repeated drops grow it (2s→30s) so a server hiccup isn't hammered.
      if (Date.now() - connectedAt > 60000) this.backoffMs = 2000;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      setTimeout(() => this.connect(), wait);
    };
    // The relay rejects a bad token at the HTTP upgrade, before the socket opens.
    // Capture the 401/403 so drop() re-auths instead of looping on a dead token.
    // Both shapes are handled because which one fires depends on the ws build:
    // node's `ws` emits `unexpected-response`; a bare error carries the status in
    // its message.
    ws.on?.("unexpected-response", (_req, res) => {
      if (res && (res.statusCode === 401 || res.statusCode === 403)) authRejected = true;
      drop();
    });
    ws.onerror = (event) => {
      const msg = String((event && (event.message || (event.error && event.error.message))) || "");
      if (/Unexpected server response: 40[13]/.test(msg)) authRejected = true;
      drop();
    };
    ws.onclose = drop;
  }
  enqueue(frames, label, talker = null, info = null) {
    this.queue.push({ frames, label, talker, info });
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50); // never backlog forever
    if (!this.draining) void this.drain();
  }
  async drain() {
    this.draining = true;
    while (this.queue.length) {
      const { frames, label, talker, info } = this.queue.shift();
      await this.play(frames, label, talker, info);
    }
    this.draining = false;
  }
  async play(frames, label, talker = null, info = null) {
    if (!frames.length) return;
    const r = this.row;
    r.transmitting = true;
    r.lastTxStartMs = Date.now();
    r.txCount++;
    if (label) r.via = label;
    // Scan rows log each call so the desktop can show WHAT traffic crossed
    // "Scan All", not just the most recent label. sdrtrunk uploads whole calls,
    // so the duration is known up front (no end-fill needed).
    if (r.scan && info) {
      r.recent.unshift({
        label: info.label || label,
        tgid: info.tgid ?? null,
        source: info.source ?? null,
        atMs: r.lastTxStartMs,
        durMs: frames.length * FRAME_MS,
      });
      if (r.recent.length > SCAN_RECENT_CAP) r.recent.length = SCAN_RECENT_CAP;
    }
    statusDirty = true;
    // Attribute this call to the real over-the-air talker before the first
    // frame claims the channel: radio ID as the unit, talkgroup alias as the
    // display name. Handsets then paint "RX: 5921719 • TAN-CALL" instead of
    // the bridge's own identity. release_air (below) clears it server-side.
    if (talker && (talker.unit || talker.name) && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify({ type: "tx_meta", unit_id: talker.unit ?? "", display_name: talker.name ?? "" })); } catch { /* closing */ }
    }
    const start = Date.now();
    for (let i = 0; i < frames.length; i++) {
      if (this.ws && this.ws.readyState === 1) {
        try { this.ws.send(frames[i]); r.rxFrames++; r.rxBytes += frames[i].length; } catch { /* dropped */ }
      }
      const target = start + (i + 1) * FRAME_MS;
      const wait = target - Date.now();
      if (wait > 1) await sleep(wait);
    }
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify({ type: "release_air" })); } catch { /* closing */ }
    }
    r.transmitting = false;
    r.lastFrameMs = Date.now();
    r.lastTxEndMs = r.lastFrameMs;
    r.lastTxDurMs = frames.length * FRAME_MS;
    statusDirty = true;
  }
}

async function main() {
  if (!baseUrl || !safet.username || !safet.password) {
    console.error("sdrtrunk-bridge: config/system.json needs safet.baseUrl / username / password.");
    process.exit(1);
  }
  token = await login();
  const bridges = await getBridges(token);

  const tgToChannel = new Map(); // tgid -> Channel
  const scanChannels = [];
  for (const b of bridges) {
    if (b.source_type !== "stream_url" || !b.enabled) continue;
    if (/\/monitor\/?$/i.test(String(b.source_url))) {
      scanChannels.push(new Channel(b.target_channel, b.name, true));
      continue;
    }
    const m = String(b.source_url).match(/\/tg(\d+)\/?$/i);
    if (!m) continue;
    tgToChannel.set(Number(m[1]), new Channel(b.target_channel, b.name, false, Number(m[1])));
  }
  if (!tgToChannel.size && !scanChannels.length) {
    console.error("sdrtrunk-bridge: no runnable bridges (create them in the SafeT console).");
    process.exit(1);
  }
  console.log(`[sdrtrunk] ready: ${tgToChannel.size} talkgroup + ${scanChannels.length} scan channel(s).`);

  // Health backstop: if EVERY channel's socket has been down for a few minutes
  // (auth wall, server down, host asleep), exit so run-all.sh relaunches us with
  // a brand-new login instead of looping in-process forever.
  setInterval(() => {
    if (channels.some((c) => c.ws && c.ws.readyState === 1)) { allDownSince = 0; return; }
    if (!allDownSince) allDownSince = Date.now();
    else if (Date.now() - allDownSince > ALL_DOWN_EXIT_MS) {
      console.error(`[sdrtrunk] all channels offline ${Math.round((Date.now() - allDownSince) / 1000)}s — exiting for a clean relaunch.`);
      process.exit(1);
    }
  }, 30000).unref();

  // Report heard talkgroups to SafeT so the console's "discovered → add" picker
  // stays current.
  setInterval(() => void reportObservedTalkgroups(), 30000).unref();

  await createCallUploadServer({
    port: UPLOAD_PORT,
    onCall: async (call) => {
      // Stamp receipt BEFORE decode: any upload proves sdrtrunk is alive and
      // decoding, even if this particular call fails to transcode.
      lastCallUploadMs = Date.now();
      statusDirty = true;
      let pcm;
      try {
        pcm = await decodeToPcm(call.audio);
      } catch (e) {
        console.warn(`[sdrtrunk] decode failed (TG ${call.talkgroupId}): ${e.message}`);
        return;
      }
      const frames = frameify(pcm);
      if (!frames.length) return;
      const label = call.talkgroupLabel || (call.talkgroupId != null ? `TG ${call.talkgroupId}` : "SDR");
      const sourceLabel = call.source ? `${label} [${call.source}]` : label;
      // Remember this talkgroup for the console's "discovered → add" picker.
      if (call.talkgroupId != null) {
        const s = seenTgs.get(call.talkgroupId);
        seenTgs.set(call.talkgroupId, {
          label: call.talkgroupLabel || s?.label || `TG ${call.talkgroupId}`,
          count: (s?.count || 0) + 1,
          lastHeardMs: Date.now(),
        });
      }
      // Route to the call's own talkgroup channel AND to every talkgroup it's
      // PATCHED / multi-selected into. A dispatch console multi-select (e.g.
      // "OCSD Communications Silver 1" carrying DSP-DSP) keys under the patch's
      // talkgroup, so without this the call reaches only Scan All. sdrtrunk
      // reports the regroup members in `patches`. Dedup so a channel that is
      // both the primary and a patch member never gets the call twice.
      const dests = new Set();
      if (call.talkgroupId != null) {
        const d = tgToChannel.get(call.talkgroupId);
        if (d) dests.add(d);
      }
      for (const p of call.patches || []) {
        const d = tgToChannel.get(p);
        if (d) dests.add(d);
      }
      // Real talker for the handset display: radio ID as the unit number,
      // talkgroup alias as the name (talker alias fills in when the system
      // sent one and the talkgroup has no label).
      const talker = { unit: call.source, name: call.talkgroupLabel || call.talkerAlias };
      // Structured call info for the Scan All history feed (label without the
      // "[source]" suffix; radio ID kept separate so the UI can format it).
      const info = { label, tgid: call.talkgroupId ?? null, source: call.source ?? null };
      for (const d of dests) d.enqueue(frames, sourceLabel, talker, info);
      for (const sc of scanChannels) sc.enqueue(frames, sourceLabel, talker, info); // Scan All gets every call
      const who = call.talkerAlias || call.source; // radio that keyed up, when the system sent it
      const destNames = [...dests].map((d) => d.channelName).join(", ") || "(scan only)";
      const patchNote = call.patches && call.patches.length ? ` patches[${call.patches.join(",")}]` : "";
      console.log(`[sdrtrunk] call TG ${call.talkgroupId} "${label}"${who ? ` from ${who}` : ""}${patchNote} ${(frames.length * FRAME_MS) / 1000}s -> ${destNames}`);
    },
    log: (m) => console.log(`[sdrtrunk] ${m}`),
  });
}

main().catch((e) => {
  console.error("sdrtrunk-bridge:", e.message);
  process.exit(1);
});
