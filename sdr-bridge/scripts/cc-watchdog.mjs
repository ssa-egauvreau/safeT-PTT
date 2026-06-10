#!/usr/bin/env node
/**
 * cc-watchdog.mjs — single-dongle "follow the control channel" watchdog.
 *
 * OC CCCS rotates its control channel across two pairs that sit 3.75 MHz
 * apart — more than one dongle can span. When the county parks the CC on the
 * pair OUTSIDE our window, the decoder goes completely deaf (hunting its two
 * covered frequencies at 0/sec forever — field log 2026-06-10 22:49) until
 * the county rotates back. This watchdog watches the decoder's log; when it
 * sees sustained hunting with zero decode, it flips the dongle's center
 * between the LOW window (857.35 MHz: 856.7125c/857.4625c) and the HIGH
 * window (859.8 MHz: 860.2125c/860.4625c), rewrites the live decoder config,
 * and restarts the decoder container.
 *
 * With two+ dongles every control channel is covered and this exits at boot.
 * Launched by run-all.sh; logs to /tmp/sdr-cc-watchdog.log.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");
const TR_CONFIG = join(ROOT, "trunk-recorder", "config.json");
const CONTAINER = "sdr-bridge-trunk-recorder-1";

export const LOW_CENTER = 857350000;
export const HIGH_CENTER = 859800000;
const CHECK_MS = 30_000;
const LOG_WINDOW_S = 240; // how much decoder log each check looks back over
const MIN_RETUNES = 30; // sustained hunting (deaf logs ~20 retunes/min)
const MIN_FLIP_GAP_MS = 600_000; // never flip more than once per 10 min

/** Deaf = sustained control-channel hunting with not one positive decode.
 *  A healthy-but-quiet system shows few retunes (it is LOCKED, not hunting),
 *  so quiet airtime can never trigger a flip. Exported for tests. */
export function isDeaf(logText) {
  const retunes = (logText.match(/Retuning to Control Channel/g) || []).length;
  if (retunes < MIN_RETUNES) return false;
  if (/Decode Rate: [1-9]\d*\/sec/.test(logText)) return false;
  if (/[1-9]\d* msg\/sec/.test(logText)) return false;
  return true;
}

/** Flip both configs to the other window; returns the new center.
 *  Pure on its inputs (mutates the passed objects). Exported for tests. */
export function flipWindow(cfg, tr) {
  const src0 = Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources[0] : null;
  const cur = Number(src0?.centerHz ?? cfg.sdr?.centerHz ?? LOW_CENTER);
  const next = Math.abs(cur - LOW_CENTER) <= Math.abs(cur - HIGH_CENTER) ? HIGH_CENTER : LOW_CENTER;
  if (cfg.sdr) cfg.sdr.centerHz = next;
  if (src0) src0.centerHz = next;

  const trSrc = tr.sources?.[0];
  if (!trSrc) throw new Error("decoder config has no sources");
  trSrc.center = next;
  const rate = Number(trSrc.rate) || 2400000;
  const system = Array.isArray(cfg.systems) && cfg.systems.length ? cfg.systems[0] : cfg.system;
  const allCcs = (system?.controlChannelsHz ?? []).map(Number).filter(Boolean);
  const covered = allCcs.filter((f) => Math.abs(f - next) <= rate * 0.48);
  if (!covered.length) throw new Error(`no control channel covered at center ${next}`);
  if (tr.systems?.[0]) tr.systems[0].control_channels = covered;
  return next;
}

function sh(args, opts = {}) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 30_000, ...opts });
}

function main() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    console.log("[cc-watchdog] no readable config — exiting");
    return;
  }
  if (Array.isArray(cfg.sources) && cfg.sources.length >= 2) {
    console.log("[cc-watchdog] two+ dongles cover every control channel — not needed, exiting");
    return;
  }
  console.log("[cc-watchdog] watching for control-channel rotation (single-dongle mode)");

  let lastFlipMs = 0;
  setInterval(() => {
    let log;
    try {
      log = sh(["docker", "logs", "--since", `${LOG_WINDOW_S}s`, CONTAINER], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return; // decoder not running — nothing to judge
    }
    if (!isDeaf(log)) return;
    if (Date.now() - lastFlipMs < MIN_FLIP_GAP_MS) return;

    try {
      const liveCfg = JSON.parse(readFileSync(CONFIG, "utf8"));
      if (Array.isArray(liveCfg.sources) && liveCfg.sources.length >= 2) process.exit(0);
      const tr = JSON.parse(readFileSync(TR_CONFIG, "utf8"));
      const next = flipWindow(liveCfg, tr);
      writeFileSync(CONFIG, JSON.stringify(liveCfg, null, 2) + "\n");
      writeFileSync(TR_CONFIG, JSON.stringify(tr, null, 2) + "\n");
      console.log(
        `[cc-watchdog] control channel silent for ${LOG_WINDOW_S}s of hunting — ` +
          `county likely rotated to the other pair. Re-centering dongle to ${(next / 1e6).toFixed(2)} MHz and restarting decoder.`,
      );
      sh(["docker", "restart", CONTAINER]);
      lastFlipMs = Date.now();
    } catch (e) {
      console.warn("[cc-watchdog] flip failed:", e.message);
    }
  }, CHECK_MS);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
