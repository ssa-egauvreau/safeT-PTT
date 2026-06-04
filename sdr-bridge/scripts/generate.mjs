#!/usr/bin/env node
/**
 * generate.mjs — turn config/system.json (+ optional config/talkgroups.csv) into
 * everything the SDR -> SafeT pipeline needs:
 *
 *   trunk-recorder/config.json     decode the P25 system from one RTL-SDR and
 *                                  UDP-stream each wanted talkgroup's audio
 *   icecast/icecast.xml            an Icecast that accepts a mount per talkgroup
 *   generated/stream-talkgroups.sh one ffmpeg per talkgroup: UDP PCM -> Icecast mount
 *   generated/bridges.json         manifest consumed by import-bridges.mjs
 *
 * Nothing here touches SafeT — import-bridges.mjs does that. This step is pure,
 * deterministic file generation, safe to re-run any time you edit system.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");
const TALKGROUPS = join(ROOT, "config", "talkgroups.csv");

/** First UDP port; talkgroup N streams on BASE_UDP_PORT + N. */
const BASE_UDP_PORT = 9000;

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(CONFIG)) {
  die(
    `config/system.json not found.\n    Copy the example and edit it:\n` +
      `      cp config/system.example.json config/system.json`,
  );
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch (e) {
  die(`config/system.json is not valid JSON: ${e.message}`);
}

const bridges = Array.isArray(cfg.bridges) ? cfg.bridges : [];
if (bridges.length === 0) die("config/system.json has no 'bridges' — nothing to generate.");

// --- light validation so failures are obvious, not silent -------------------
const mounts = new Set();
const tgids = new Set();
bridges.forEach((b, i) => {
  if (b.tgid === undefined) die(`bridges[${i}] is missing 'tgid'.`);
  if (!b.channel) die(`bridges[${i}] (tgid ${b.tgid}) is missing 'channel'.`);
  if (!b.mount) die(`bridges[${i}] (tgid ${b.tgid}) is missing 'mount'.`);
  if (!/^[a-z0-9._-]+$/.test(b.mount))
    die(`bridges[${i}] mount "${b.mount}" must be lowercase letters/digits/.-_ only.`);
  if (mounts.has(b.mount)) die(`duplicate mount "${b.mount}" — each must be unique.`);
  if (tgids.has(b.tgid)) die(`duplicate tgid ${b.tgid} — list each talkgroup once.`);
  mounts.add(b.mount);
  tgids.add(b.tgid);
});

// --- optional: cross-check tgids against a RadioReference export -------------
let knownTgs = null;
if (existsSync(TALKGROUPS)) {
  knownTgs = new Map();
  const lines = readFileSync(TALKGROUPS, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const cols = line.split(",");
    const dec = Number(cols[0]);
    if (Number.isFinite(dec)) knownTgs.set(dec, (cols[2] ?? "").trim());
  }
  for (const b of bridges) {
    if (!knownTgs.has(Number(b.tgid))) {
      console.warn(
        `  ! tgid ${b.tgid} ("${b.channel}") is not in talkgroups.csv — double-check it.`,
      );
    }
  }
}

// --- assign a UDP port to each talkgroup ------------------------------------
const plan = bridges.map((b, i) => ({ ...b, udpPort: BASE_UDP_PORT + i }));

mkdirSync(join(ROOT, "generated"), { recursive: true });
mkdirSync(join(ROOT, "trunk-recorder"), { recursive: true });
mkdirSync(join(ROOT, "icecast"), { recursive: true });

// --- 1) trunk-recorder/config.json ------------------------------------------
// One RTL-SDR source decoding the control channel; the simplestream plugin
// forwards each wanted talkgroup's call audio to its UDP port as raw
// 16-bit / 8 kHz / mono PCM.
const sdr = cfg.sdr ?? {};
const sys = cfg.system ?? {};
const trunkConfig = {
  ver: 2,
  sources: [
    {
      center: sdr.centerHz ?? 854000000,
      rate: sdr.rateHz ?? 2400000,
      gain: sdr.gain ?? 0,
      ppm: sdr.ppm ?? 0,
      // Concurrent voice recorders. Bounded by what fits in the SDR's ~2 MHz
      // window; more than this many simultaneous calls simply queue.
      digitalRecorders: Math.max(4, plan.length),
      driver: "osmosdr",
      device: `rtl=${sdr.device ?? 0}`,
    },
  ],
  systems: [
    {
      shortName: sys.shortName ?? "occcs",
      type: sys.type ?? "p25",
      modulation: sys.modulation ?? "qpsk",
      control_channels: sys.controlChannelsHz ?? [],
      talkgroupsFile: "talkgroups.csv",
      // Only record/stream the talkgroups we actually bridge.
      talkgroups: plan.map((p) => Number(p.tgid)),
    },
  ],
  plugins: [
    {
      name: "simplestream",
      library: "libsimplestream_plugin.so",
      streams: plan.map((p) => ({
        TGID: Number(p.tgid),
        address: "127.0.0.1",
        port: p.udpPort,
        sendTGID: false,
      })),
    },
  ],
  captureDir: "/tmp/trunk-recorder",
  callTimeout: 3,
  logFile: false,
};
writeFileSync(join(ROOT, "trunk-recorder", "config.json"), JSON.stringify(trunkConfig, null, 2) + "\n");

// --- 2) icecast/icecast.xml -------------------------------------------------
// Mounts are created on the fly by source clients using <source-password>, so
// we don't need to declare each one. Keep the passwords in sync with system.json.
const ice = cfg.icecast ?? {};
const icecastXml = `<icecast>
  <!-- Generated by sdr-bridge/scripts/generate.mjs — edit config/system.json, not this file. -->
  <limits>
    <clients>100</clients>
    <sources>${Math.max(10, plan.length + 2)}</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>30</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65535</burst-size>
  </limits>
  <authentication>
    <source-password>${ice.sourcePassword ?? "hackme"}</source-password>
    <relay-password>${ice.sourcePassword ?? "hackme"}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${ice.adminPassword ?? "hackme"}</admin-password>
  </authentication>
  <hostname>${ice.host ?? "127.0.0.1"}</hostname>
  <listen-socket>
    <port>${ice.port ?? 8000}</port>
  </listen-socket>
  <fileserve>0</fileserve>
  <paths>
    <logdir>/var/log/icecast2</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
  </paths>
  <logging>
    <loglevel>2</loglevel>
  </logging>
</icecast>
`;
writeFileSync(join(ROOT, "icecast", "icecast.xml"), icecastXml);

// --- 3) generated/stream-talkgroups.sh --------------------------------------
// One ffmpeg per talkgroup. Input 0 is infinite silence (keeps the Icecast
// mount alive between calls); input 1 is the UDP PCM trunk-recorder sends only
// during a call. amix(duration=first) is driven by the infinite silence, so the
// mount streams continuously and call audio is overlaid when present. SafeT's
// own bridge VOX gate then decides when to key the channel.
const icePort = ice.port ?? 8000;
const iceHost = ice.host ?? "127.0.0.1";
const srcPass = ice.sourcePassword ?? "hackme";
const streamLines = plan
  .map(
    (p) => `# ${p.channel}  (TGID ${p.tgid})  ->  mount /${p.mount}
ffmpeg -hide_banner -loglevel warning \\
  -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=8000" \\
  -f s16le -ar 8000 -ac 1 -fflags nobuffer \\
  -i "udp://127.0.0.1:${p.udpPort}?listen=1&fifo_size=1000000&overrun_nonfatal=1" \\
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:normalize=0,volume=1.6,alimiter=limit=0.95[a]" \\
  -map "[a]" -c:a libmp3lame -b:a 32k -ar 8000 -ac 1 \\
  -content_type audio/mpeg -f mp3 \\
  "icecast://source:${srcPass}@${iceHost}:${icePort}/${p.mount}" &`,
  )
  .join("\n\n");

const streamScript = `#!/usr/bin/env bash
# Generated by sdr-bridge/scripts/generate.mjs — do not edit by hand.
# Launches one ffmpeg per talkgroup: trunk-recorder UDP PCM -> Icecast mount.
# Run AFTER Icecast is up and BEFORE/alongside trunk-recorder.
set -euo pipefail

cleanup() { echo "stopping streamers..."; kill 0; }
trap cleanup EXIT INT TERM

${streamLines}

echo "Streaming ${plan.length} talkgroup mount(s) to icecast://${iceHost}:${icePort}/  (Ctrl-C to stop)"
wait
`;
writeFileSync(join(ROOT, "generated", "stream-talkgroups.sh"), streamScript, { mode: 0o755 });

// --- 4) generated/bridges.json — manifest for import-bridges.mjs ------------
const d = cfg.bridgeDefaults ?? {};
const base = (ice.serverReachableBase ?? `http://${iceHost}:${icePort}`).replace(/\/+$/, "");
const manifest = {
  safet: cfg.safet ?? {},
  bridges: plan.map((p) => ({
    name: p.name ?? `${sys.shortName ?? "sdr"} ${p.channel}`,
    channel: p.channel,
    sourceUrl: `${base}/${p.mount}`,
    voxThreshold: p.voxThreshold ?? d.voxThreshold ?? 0.02,
    voxHangMs: p.voxHangMs ?? d.voxHangMs ?? 1500,
    yieldToUnits: p.yieldToUnits ?? d.yieldToUnits ?? false,
    enabled: p.enabled ?? d.enabled ?? true,
  })),
};
writeFileSync(join(ROOT, "generated", "bridges.json"), JSON.stringify(manifest, null, 2) + "\n");

// --- summary ----------------------------------------------------------------
console.log(`\n  ✓ Generated for ${plan.length} talkgroup(s):\n`);
for (const p of plan) {
  const tag = knownTgs?.get(Number(p.tgid));
  console.log(
    `    • ${p.channel.padEnd(16)} TGID ${String(p.tgid).padEnd(6)} udp:${p.udpPort}  ` +
      `-> /${p.mount}${tag ? `   (${tag})` : ""}`,
  );
}
console.log(`
    trunk-recorder/config.json
    icecast/icecast.xml
    generated/stream-talkgroups.sh
    generated/bridges.json

  Next:
    1. Start Icecast + trunk-recorder + the streamers   (see README "Run it")
    2. Create the SafeT channels & bridges:   npm run import-bridges
`);
