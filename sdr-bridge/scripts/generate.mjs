#!/usr/bin/env node
/**
 * generate.mjs — OFFLINE path. Build the runtime files from the talkgroups you
 * list in config/system.json's `bridges[]`, plus a generated/bridges.json that
 * import-bridges.mjs can push to SafeT.
 *
 * Prefer the console workflow instead? Create bridges in the SafeT console
 * (Bridges → Import from RadioReference) and run `npm run sync` here — it pulls
 * the talkgroups straight from those bridges, no local list to maintain.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifacts } from "./lib/build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");
const TALKGROUPS = join(ROOT, "config", "talkgroups.csv");

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
    if (!knownTgs.has(Number(b.tgid)))
      console.warn(`  ! tgid ${b.tgid} ("${b.channel}") is not in talkgroups.csv — double-check it.`);
  }
}

const plan = bridges.map((b) => ({
  tgid: Number(b.tgid),
  mount: b.mount,
  channel: b.channel,
  name: b.name ?? `${cfg.system?.shortName ?? "sdr"} ${b.channel}`,
}));

let withPorts;
try {
  withPorts = writeArtifacts(ROOT, cfg, plan);
} catch (e) {
  die(e.message);
}

// generated/bridges.json — manifest for import-bridges.mjs (offline -> SafeT).
const ice = cfg.icecast ?? {};
const d = cfg.bridgeDefaults ?? {};
const base = (ice.serverReachableBase ?? `http://${ice.host ?? "127.0.0.1"}:${ice.port ?? 8000}`).replace(
  /\/+$/,
  "",
);
const manifest = {
  safet: cfg.safet ?? {},
  bridges: bridges.map((b) => ({
    name: b.name ?? `${cfg.system?.shortName ?? "sdr"} ${b.channel}`,
    channel: b.channel,
    sourceUrl: `${base}/${b.mount}`,
    voxThreshold: b.voxThreshold ?? d.voxThreshold ?? 0.02,
    voxHangMs: b.voxHangMs ?? d.voxHangMs ?? 1500,
    yieldToUnits: b.yieldToUnits ?? d.yieldToUnits ?? false,
    enabled: b.enabled ?? d.enabled ?? true,
  })),
};
writeFileSync(join(ROOT, "generated", "bridges.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`\n  ✓ Generated for ${withPorts.length} talkgroup(s):\n`);
for (const p of withPorts) {
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
    1. Start everything:        bash scripts/run-all.sh
    2. Create SafeT channels:   npm run import-bridges
`);
