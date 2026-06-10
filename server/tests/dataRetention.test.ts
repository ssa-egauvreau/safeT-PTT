/**
 * Tests for `parseTransmissionRetentionDays` in `server/src/dataRetention.ts`.
 *
 * The transmission-retention sweep is the only thing keeping the Postgres
 * volume from filling up on a small Railway plan. This helper translates the
 * `TRANSMISSION_RETENTION_DAYS` env var into the integer-day window the sweep
 * uses; a regression here either disables the sweep silently (operator pain
 * later) or, worse, deletes more than intended.
 *
 * Properties pinned by this file:
 *
 *  1. Unset / empty / whitespace env → `null` (sweep is skipped — the safe
 *     default).
 *  2. Non-integer / NaN / `0` / negative values → `null`. We never want a
 *     fat-fingered "0" to expand into "delete everything".
 *  3. Values are clamped to a `3650` (10-year) ceiling so an absurd
 *     `TRANSMISSION_RETENTION_DAYS=999999` doesn't hand the sweep a multi-
 *     century millisecond window that would overflow downstream `new Date(...)`
 *     math.
 *  4. Sane positive integers (and integers with surrounding whitespace) parse
 *     to themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransmissionRetentionDays } from "../src/dataRetention.js";

const ENV_KEY = "TRANSMISSION_RETENTION_DAYS";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  }
}

test("parseTransmissionRetentionDays: unset env returns null", () => {
  withEnv(undefined, () => {
    assert.equal(parseTransmissionRetentionDays(), null);
  });
});

test("parseTransmissionRetentionDays: empty / whitespace env returns null", () => {
  withEnv("", () => assert.equal(parseTransmissionRetentionDays(), null));
  withEnv("   ", () => assert.equal(parseTransmissionRetentionDays(), null));
});

test("parseTransmissionRetentionDays: non-numeric env returns null", () => {
  withEnv("forever", () => assert.equal(parseTransmissionRetentionDays(), null));
  withEnv("abc", () => assert.equal(parseTransmissionRetentionDays(), null));
});

test("parseTransmissionRetentionDays: 0 returns null (never delete-all)", () => {
  withEnv("0", () => assert.equal(parseTransmissionRetentionDays(), null));
});

test("parseTransmissionRetentionDays: negative integer returns null", () => {
  withEnv("-7", () => assert.equal(parseTransmissionRetentionDays(), null));
});

test("parseTransmissionRetentionDays: trims surrounding whitespace before parsing", () => {
  withEnv("  30  ", () => assert.equal(parseTransmissionRetentionDays(), 30));
});

test("parseTransmissionRetentionDays: typical positive integers pass through", () => {
  withEnv("1", () => assert.equal(parseTransmissionRetentionDays(), 1));
  withEnv("3", () => assert.equal(parseTransmissionRetentionDays(), 3));
  withEnv("90", () => assert.equal(parseTransmissionRetentionDays(), 90));
});

test("parseTransmissionRetentionDays: clamps absurd values to the 3650-day ceiling", () => {
  withEnv("3650", () => assert.equal(parseTransmissionRetentionDays(), 3650));
  withEnv("3651", () => assert.equal(parseTransmissionRetentionDays(), 3650));
  withEnv("9999999", () => assert.equal(parseTransmissionRetentionDays(), 3650));
});

test("parseTransmissionRetentionDays: parseInt swallows trailing junk (documented behaviour)", () => {
  // `Number.parseInt("30days", 10) = 30`. We want this test as a tripwire: if
  // someone refactors to `Number(value)` (which returns NaN for "30days"),
  // existing operator configs would silently start being rejected. Pinning
  // the current behaviour avoids that surprise.
  withEnv("30days", () => assert.equal(parseTransmissionRetentionDays(), 30));
});
