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
import { readFileSync, writeFileSync } from "node:fs";
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
const rows = new Map();
let statusDirty = true;
function row(name, channel, scan = false, tgid = null) {
  let r = rows.get(name);
  if (!r) {
    r = { name, channel, tgid, scan, state: "connecting", transmitting: false, rxFrames: 0, rxBytes: 0, portFrames: 0, portBytes: 0, lastFrameMs: 0, lastTxStartMs: null, lastTxEndMs: null, lastTxDurMs: null, lastTxAudioPct: null, txCount: 0, via: null };
    rows.set(name, r);
  }
  return r;
}
setInterval(() => {
  if (!statusDirty) return;
  statusDirty = false;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ updatedAt: Date.now(), bridges: [...rows.values()] }));
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
    this.row = row(unit || channelName, channelName, scan, tgid);
    this.connect();
  }
  connect() {
    const ws = new WS(`${wsBase()}/v1/voice/stream?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    const ka = setInterval(() => {
      if (ws.readyState === 1) try { ws.ping?.(); } catch { /* dying */ }
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
    const drop = () => {
      clearInterval(ka);
      if (this.ws === ws) {
        this.ws = null;
        if (this.row.state === "on air") { this.row.state = "reconnecting"; statusDirty = true; }
      }
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = drop;
    ws.onclose = drop;
  }
  enqueue(frames, label, talker = null) {
    this.queue.push({ frames, label, talker });
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50); // never backlog forever
    if (!this.draining) void this.drain();
  }
  async drain() {
    this.draining = true;
    while (this.queue.length) {
      const { frames, label, talker } = this.queue.shift();
      await this.play(frames, label, talker);
    }
    this.draining = false;
  }
  async play(frames, label, talker = null) {
    if (!frames.length) return;
    const r = this.row;
    r.transmitting = true;
    r.lastTxStartMs = Date.now();
    r.txCount++;
    if (label) r.via = label;
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

let token = null;

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

  await createCallUploadServer({
    port: UPLOAD_PORT,
    onCall: async (call) => {
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
      const dest = call.talkgroupId != null ? tgToChannel.get(call.talkgroupId) : null;
      // Real talker for the handset display: radio ID as the unit number,
      // talkgroup alias as the name (talker alias fills in when the system
      // sent one and the talkgroup has no label).
      const talker = { unit: call.source, name: call.talkgroupLabel || call.talkerAlias };
      if (dest) dest.enqueue(frames, sourceLabel, talker);
      for (const sc of scanChannels) sc.enqueue(frames, sourceLabel, talker); // Scan All gets every call
      const who = call.talkerAlias || call.source; // radio that keyed up, when the system sent it
      console.log(`[sdrtrunk] call TG ${call.talkgroupId} "${label}"${who ? ` from ${who}` : ""} ${(frames.length * FRAME_MS) / 1000}s -> ${dest ? dest.channelName : "(scan only)"}`);
    },
    log: (m) => console.log(`[sdrtrunk] ${m}`),
  });
}

main().catch((e) => {
  console.error("sdrtrunk-bridge:", e.message);
  process.exit(1);
});
