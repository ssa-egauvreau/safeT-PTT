// Tests for the single-dongle "follow the control channel" watchdog.
//
// Field outage 2026-06-10 22:49: the county rotated its control channel to
// the high pair (860.2125/860.4625) and the rig hunted its two low-pair
// frequencies at 0/sec for 38+ minutes — totally deaf. These tests lock in
// the deaf detector (must never false-positive on a healthy-but-quiet
// system) and the window flip (centers, covered control channels).

import test from "node:test";
import assert from "node:assert/strict";

import { HIGH_CENTER, LOW_CENTER, flipWindow, isDeaf } from "./cc-watchdog.mjs";

const hunt = (freq) =>
  `[2026-06-10 22:47:01.0] (error)   [occcs] Retuning to Control Channel: ${freq} MHz\n` +
  `[2026-06-10 22:47:01.0] (error)   [occcs]\tfreq: ${freq} MHz\tControl Channel Message Decode Rate: 0/sec, count:  1\n`;

test("deaf: sustained hunting with zero decode flips the detector", () => {
  let log = "";
  for (let i = 0; i < 20; i++) log += hunt("856.712500") + hunt("857.462500");
  assert.equal(isDeaf(log), true);
});

test("not deaf: healthy locked system (status blocks, no hunting)", () => {
  const log =
    "[occcs] Control Channel Decode Rates:\n[occcs]\t857.462500 MHz\t34 msg/sec\n".repeat(3) +
    hunt("856.712500"); // one stray retune is normal
  assert.equal(isDeaf(log), false);
});

test("not deaf: hunting but a positive decode appears (re-locking on its own)", () => {
  let log = "";
  for (let i = 0; i < 20; i++) log += hunt("856.712500");
  log += "[occcs]\tfreq: 857.462500 MHz\tControl Channel Message Decode Rate: 9/sec, count: 27\n";
  assert.equal(isDeaf(log), false);
});

test("not deaf: quiet log (decoder idle or just started)", () => {
  assert.equal(isDeaf(""), false);
});

const OCCCS_CCS = [857462500, 860212500, 860462500, 856712500];
function configs(center) {
  return {
    cfg: {
      sdr: { centerHz: center, rateHz: 2400000 },
      sources: [{ device: 0, centerHz: center, rateHz: 2400000 }],
      system: { shortName: "occcs", controlChannelsHz: [...OCCCS_CCS] },
    },
    tr: {
      sources: [{ center, rate: 2400000 }],
      systems: [{ shortName: "occcs", control_channels: [] }],
    },
  };
}

test("flip low -> high: center moves, high-pair CCs covered", () => {
  const { cfg, tr } = configs(LOW_CENTER);
  const next = flipWindow(cfg, tr);
  assert.equal(next, HIGH_CENTER);
  assert.equal(cfg.sdr.centerHz, HIGH_CENTER);
  assert.equal(cfg.sources[0].centerHz, HIGH_CENTER);
  assert.equal(tr.sources[0].center, HIGH_CENTER);
  assert.deepEqual(tr.systems[0].control_channels.sort(), [860212500, 860462500]);
});

test("flip high -> low: returns to the low pair", () => {
  const { cfg, tr } = configs(HIGH_CENTER);
  const next = flipWindow(cfg, tr);
  assert.equal(next, LOW_CENTER);
  assert.deepEqual(tr.systems[0].control_channels.sort(), [856712500, 857462500]);
});

test("flip is symmetric: two flips land back where it started", () => {
  const { cfg, tr } = configs(LOW_CENTER);
  flipWindow(cfg, tr);
  const back = flipWindow(cfg, tr);
  assert.equal(back, LOW_CENTER);
});
