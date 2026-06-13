/**
 * Tests for `server/src/dataRetention.ts`.
 *
 * The hourly retention sweep deletes from the `transmissions` table.
 * Anything that turns the env-var parser into "0 days" or a negative
 * cutoff would erase the audit log on every run. Two contracts to pin:
 *
 *  - `parseTransmissionRetentionDays()` must reject 0 / negatives / NaN
 *    / non-numerics by returning `null` (= "skip the global sweep"),
 *    NOT 0 (= "delete everything older than now").
 *  - The 3650-day clamp (10 years) must hold so a typo like
 *    `TRANSMISSION_RETENTION_DAYS=36500` doesn't quietly create a
 *    centuries-long cutoff and keep growing the table.
 *
 * Plus, `runDataRetentionSweeps` must no-op when no DB is configured —
 * matching the same contract the trial sweep upholds.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTransmissionRetentionDays,
  parseEmergencyAutoClearMs,
  runDataRetentionSweeps,
} from "../src/dataRetention.js";

const HOUR_MS = 60 * 60 * 1000;

const ORIGINAL = {
  DATABASE_URL: process.env.DATABASE_URL,
  TRANSMISSION_RETENTION_DAYS: process.env.TRANSMISSION_RETENTION_DAYS,
  EMERGENCY_AUTO_CLEAR_HOURS: process.env.EMERGENCY_AUTO_CLEAR_HOURS,
};

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.TRANSMISSION_RETENTION_DAYS;
  delete process.env.EMERGENCY_AUTO_CLEAR_HOURS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL) as [keyof typeof ORIGINAL, string | undefined][]) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

test("parseTransmissionRetentionDays: returns null when env var is unset (default = no global sweep)", () => {
  delete process.env.TRANSMISSION_RETENTION_DAYS;
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("parseTransmissionRetentionDays: returns null for blank / whitespace-only", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "";
  assert.equal(parseTransmissionRetentionDays(), null);
  process.env.TRANSMISSION_RETENTION_DAYS = "   ";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("parseTransmissionRetentionDays: parses a positive integer", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "30";
  assert.equal(parseTransmissionRetentionDays(), 30);
  process.env.TRANSMISSION_RETENTION_DAYS = "  7  ";
  assert.equal(parseTransmissionRetentionDays(), 7);
});

test("parseTransmissionRetentionDays: rejects 0 (would erase the audit log on the next sweep)", () => {
  // The single most dangerous regression — a 0-day cutoff would
  // run `DELETE FROM transmissions WHERE started_at < now()` and
  // wipe every recording on the platform.
  process.env.TRANSMISSION_RETENTION_DAYS = "0";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("parseTransmissionRetentionDays: rejects negatives", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "-1";
  assert.equal(parseTransmissionRetentionDays(), null);
  process.env.TRANSMISSION_RETENTION_DAYS = "-365";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("parseTransmissionRetentionDays: rejects non-numeric strings", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "forever";
  assert.equal(parseTransmissionRetentionDays(), null);
  process.env.TRANSMISSION_RETENTION_DAYS = "30d";
  // parseInt("30d") === 30, which IS a valid retention window — pin
  // that the helper today accepts the leading integer (matches Node
  // `parseInt` semantics so a typo in the env file degrades gracefully).
  assert.equal(parseTransmissionRetentionDays(), 30);
});

test("parseTransmissionRetentionDays: clamps absurd values to 3650 days (10y) ceiling", () => {
  // A typo (e.g. 36500 instead of 3650) must be capped — a multi-
  // century cutoff never deletes anything and the table grows
  // unbounded. The ceiling matches the hard-coded 3650 in the source.
  process.env.TRANSMISSION_RETENTION_DAYS = "36500";
  assert.equal(parseTransmissionRetentionDays(), 3650);
  process.env.TRANSMISSION_RETENTION_DAYS = "9999999";
  assert.equal(parseTransmissionRetentionDays(), 3650);
});

test("parseTransmissionRetentionDays: 3650 (the ceiling itself) is preserved", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "3650";
  assert.equal(parseTransmissionRetentionDays(), 3650);
});

test("parseTransmissionRetentionDays: floors fractional input via parseInt", () => {
  // parseInt("7.9") === 7. Pin the contract — a refactor to
  // Number.parseFloat would silently accept fractional days and
  // thread them through to `retentionMs = days * 86_400_000`, which
  // works numerically but bypasses the integer expectation.
  process.env.TRANSMISSION_RETENTION_DAYS = "7.9";
  assert.equal(parseTransmissionRetentionDays(), 7);
});

test("parseEmergencyAutoClearMs: defaults to 6h when unset / blank", () => {
  delete process.env.EMERGENCY_AUTO_CLEAR_HOURS;
  assert.equal(parseEmergencyAutoClearMs(), 6 * HOUR_MS);
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "   ";
  assert.equal(parseEmergencyAutoClearMs(), 6 * HOUR_MS);
});

test("parseEmergencyAutoClearMs: '0' / 'off' disables the sweep (returns 0)", () => {
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "0";
  assert.equal(parseEmergencyAutoClearMs(), 0);
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "off";
  assert.equal(parseEmergencyAutoClearMs(), 0);
});

test("parseEmergencyAutoClearMs: parses a positive (possibly fractional) hour count", () => {
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "12";
  assert.equal(parseEmergencyAutoClearMs(), 12 * HOUR_MS);
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "0.5";
  assert.equal(parseEmergencyAutoClearMs(), 0.5 * HOUR_MS);
});

test("parseEmergencyAutoClearMs: NaN / negative fall back to the 6h default (never a 0ms window that clears live emergencies)", () => {
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "soon";
  assert.equal(parseEmergencyAutoClearMs(), 6 * HOUR_MS);
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "-3";
  assert.equal(parseEmergencyAutoClearMs(), 6 * HOUR_MS);
});

test("parseEmergencyAutoClearMs: clamps absurd values to 30 days", () => {
  process.env.EMERGENCY_AUTO_CLEAR_HOURS = "100000";
  assert.equal(parseEmergencyAutoClearMs(), 24 * 30 * HOUR_MS);
});

test("runDataRetentionSweeps: no-op when DATABASE_URL is unset", async () => {
  // Mirrors the trial sweep — Cloud Agent / dev mode boot without a
  // DB must NOT crash the hourly retention timer.
  delete process.env.DATABASE_URL;
  await assert.doesNotReject(runDataRetentionSweeps());
});
