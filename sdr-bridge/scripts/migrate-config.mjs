#!/usr/bin/env node
/**
 * migrate-config.mjs — one-shot, idempotent RF profile fixes for known systems.
 *
 * Runs at the top of every `npm start` (run-all.sh) BEFORE the sync step, so the
 * regenerated decoder config picks the fixes up. Each profile is applied once and
 * recorded in `_rfProfile`, so a user's later manual tuning is never overwritten.
 *
 * occcs-countywide-v1 (Orange County CCCS, site 021 "Countywide"):
 *   The site rotates its control channel across FOUR cc-capable frequencies
 *   (856.7125 / 857.4625 / 860.2125 / 860.4625 MHz) and spans 855.7125–860.9625
 *   MHz. Earlier configs listed only the two low control channels inside a fixed
 *   2.4 MHz window — whenever the site rested on a high control channel the
 *   decoder went completely deaf for hours. With ONE dongle the best fix is the
 *   chip's max 3.2 MHz window centered 858.98 MHz: covers 3 of the 4 control
 *   channels and 13 of 22 site frequencies (deaf only while the site sits on
 *   856.7125c). Two+ dongles: only the control-channel list is corrected; the
 *   per-dongle centers are left to the user/config.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");

const PROFILE = "occcs-countywide-v1";
const OCCCS_CCS = [857462500, 860212500, 860462500, 856712500];
const ONE_DONGLE_CENTER = 858980000;
const ONE_DONGLE_RATE = 3200000;

if (!existsSync(CONFIG)) process.exit(0); // nothing to migrate yet

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch {
  process.exit(0); // unreadable — let the real consumers report it
}

if (cfg._rfProfile === PROFILE) process.exit(0); // already applied

const system = Array.isArray(cfg.systems) && cfg.systems.length ? cfg.systems[0] : cfg.system;
if (!system || (system.shortName ?? "occcs") !== "occcs") process.exit(0);

const changes = [];

const haveCcs = (system.controlChannelsHz ?? []).map(Number);
if (!OCCCS_CCS.every((f) => haveCcs.includes(f))) {
  system.controlChannelsHz = [...OCCCS_CCS];
  changes.push("control channels -> 857.4625 / 860.2125 / 860.4625 / 856.7125 MHz (all four the site rotates across)");
}

const multiDongle = Array.isArray(cfg.sources) && cfg.sources.length >= 2;
if (!multiDongle) {
  const retune = (s) => {
    if (!s) return;
    s.centerHz = ONE_DONGLE_CENTER;
    s.rateHz = ONE_DONGLE_RATE;
    if (!s.gain) s.gain = 40; // auto-AGC rarely decodes P25
  };
  retune(cfg.sdr);
  if (Array.isArray(cfg.sources) && cfg.sources.length === 1) retune(cfg.sources[0]);
  changes.push("single dongle -> 3.2 MHz window centered 858.98 MHz (covers 3 of 4 control channels)");
}

cfg._rfProfile = PROFILE;
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");

if (changes.length) {
  console.log(`[migrate] applied RF profile ${PROFILE}:`);
  for (const c of changes) console.log(`    • ${c}`);
}
