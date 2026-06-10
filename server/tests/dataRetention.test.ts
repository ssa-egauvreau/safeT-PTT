/**
 * Tests for `server/src/dataRetention.ts` env parsing.
 *
 * The hourly retention sweep deletes rows older than this many days from the
 * global `transmissions` table. The parser is small but high-stakes:
 *
 *  - Unset / blank → null → the global sweep is skipped (per-agency sweep is
 *    still run, which is what we want — never delete a tenant's data unless
 *    they opted in).
 *  - Negative / NaN / zero → null → never silently treat malformed config as
 *    "0 days" (which would wipe every transmission on first run).
 *  - Sane positive integer → that integer.
 *  - Absurdly large values are clamped at 3650 days (10 years) so a typo can't
 *    overflow downstream date math.
 *
 * Pinning these branches keeps a future config refactor from regressing the
 * "do nothing if misconfigured" property.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { parseTransmissionRetentionDays } from "../src/dataRetention.js";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.TRANSMISSION_RETENTION_DAYS;
  delete process.env.TRANSMISSION_RETENTION_DAYS;
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.TRANSMISSION_RETENTION_DAYS;
  } else {
    process.env.TRANSMISSION_RETENTION_DAYS = saved;
  }
});

test("returns null when the env var is unset (skip global sweep, never wipe by default)", () => {
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("returns null for blank / whitespace-only values", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "";
  assert.equal(parseTransmissionRetentionDays(), null);
  process.env.TRANSMISSION_RETENTION_DAYS = "   ";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("returns null for non-numeric input (fail-closed, do not wipe)", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "forever";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("returns null for zero or negative values (would-be 'delete everything' configs)", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "0";
  assert.equal(parseTransmissionRetentionDays(), null, "0 days must not wipe every transmission");
  process.env.TRANSMISSION_RETENTION_DAYS = "-7";
  assert.equal(parseTransmissionRetentionDays(), null);
});

test("returns the integer for a sane positive value", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "30";
  assert.equal(parseTransmissionRetentionDays(), 30);
  process.env.TRANSMISSION_RETENTION_DAYS = "1";
  assert.equal(parseTransmissionRetentionDays(), 1);
});

test("clamps very large values at 3650 days (10 years) to bound the DELETE horizon", () => {
  process.env.TRANSMISSION_RETENTION_DAYS = "100000";
  assert.equal(parseTransmissionRetentionDays(), 3650);
  process.env.TRANSMISSION_RETENTION_DAYS = "3650";
  assert.equal(parseTransmissionRetentionDays(), 3650);
  process.env.TRANSMISSION_RETENTION_DAYS = "3649";
  assert.equal(parseTransmissionRetentionDays(), 3649);
});

test("parses leading-digit strings via parseInt (matches Node behavior)", () => {
  // "30 days" → 30. The env contract is "an integer" but we accept the same
  // forgiving parsing that the rest of the codebase uses for similar knobs.
  process.env.TRANSMISSION_RETENTION_DAYS = "30 days";
  assert.equal(parseTransmissionRetentionDays(), 30);
});
