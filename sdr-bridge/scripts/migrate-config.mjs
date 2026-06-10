#!/usr/bin/env node
/**
 * migrate-config.mjs — one-shot, idempotent RF profile fixes for known systems.
 *
 * Runs at the top of every `npm start` (run-all.sh) BEFORE the sync step, so the
 * regenerated decoder config picks the fixes up. Each profile is applied once and
 * recorded in `_rfProfile`, so a user's later manual tuning is never overwritten.
 *
 * occcs-countywide-v2 (Orange County CCCS, site 021 "Countywide"):
 *   The site rotates its control channel across FOUR cc-capable frequencies
 *   (856.7125 / 857.4625 / 860.2125 / 860.4625 MHz) and spans 855.7125–860.9625
 *   MHz. Field logs show the site parks mostly on the HIGH pair — and that
 *   The sample rate must be a MULTIPLE OF 24000 (the P25 symbol rate) or
 *   trunk-recorder aborts on boot — 2,544,000 (106 x 24000) is the closest
 *   valid rate to the chip's reliable ceiling. Only ONE of the site's four
 *   cc-capable frequencies is the active control channel at a time, and the
 *   pairs sit 3.75 MHz apart — more than any single dongle can span. Field
 *   logs show the rig decoding on 857.4625 (low pair), so v4 centers the
 *   window at 857.35 MHz: both LOW control channels plus ten voice
 *   frequencies. When the county rotates the control channel to the high
 *   pair (860.2125/860.4625) a single dongle goes deaf until it rotates
 *   back — the second dongle (sources[1] on the high pair) removes that gap.
 *   Two+ dongles: only the control-channel list is corrected; per-dongle
 *   centers stay user-set.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");

const PROFILE = "occcs-countywide-v5";
const OCCCS_CCS = [860212500, 860462500, 857462500, 856712500];
const ONE_DONGLE_CENTER = 857350000;
const ONE_DONGLE_RATE = 2544000; // must be a multiple of 24000 (P25 symbol rate)

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
  changes.push("control channels -> 860.2125 / 860.4625 / 857.4625 / 856.7125 MHz (all four the site rotates across)");
}

const multiDongle = Array.isArray(cfg.sources) && cfg.sources.length >= 2;
if (!multiDongle) {
  const retune = (s) => {
    if (!s) return;
    s.centerHz = ONE_DONGLE_CENTER;
    s.rateHz = ONE_DONGLE_RATE;
    if (!s.gain) s.gain = 40; // auto-AGC rarely decodes P25
    // Field recordings showed consistently NEGATIVE TuningErr (-0.3 to -3.9 kHz
    // at 857 MHz) with ppm +2 — the correction was overshooting, degrading
    // decode quality. Zero it; re-tune in Settings if your dongle truly drifts.
    s.ppm = 0;
  };
  retune(cfg.sdr);
  if (Array.isArray(cfg.sources) && cfg.sources.length === 1) retune(cfg.sources[0]);
  changes.push("single dongle -> 857.35 MHz window, ppm 0 (TuningErr showed the +2 correction overshooting by 1-2 kHz)");
}

cfg._rfProfile = PROFILE;
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");

if (changes.length) {
  console.log(`[migrate] applied RF profile ${PROFILE}:`);
  for (const c of changes) console.log(`    • ${c}`);
}
