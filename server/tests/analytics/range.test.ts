/**
 * Tests for the `isAnalyticsRange` type guard in `server/src/analytics.ts`.
 *
 * Every analytics endpoint (`/v1/analytics/summary`, `/timeseries`,
 * `/channels`, `/units`, `/ai-dispatch`) funnels its `?range=` query
 * parameter through this guard. The server-side `parseRange` then falls
 * back to "7d" for anything that doesn't pass — that fallback is
 * deliberate (a client must not be able to ask for an arbitrary
 * window and time out the connection pool with a year of data).
 *
 * Regressions to watch for:
 *
 *  - The guard accepting a new value the SQL layer doesn't know about →
 *    a runtime error on every dashboard load (RANGE_WINDOWS lookup
 *    returns undefined).
 *  - The guard rejecting one of the three valid values → the route
 *    silently degrades every request to the "7d" default, masking the
 *    user's 24h / 30d choice.
 *  - Case-folding / whitespace creeping into the guard itself — that
 *    work is done by `parseRange` in the route, so the guard must stay
 *    strictly literal so the contract is shared between server and any
 *    future call sites (e.g. the daily summary email worker).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isAnalyticsRange } from "../../src/analytics.js";

test("isAnalyticsRange: accepts exactly the three documented values", () => {
  assert.equal(isAnalyticsRange("24h"), true);
  assert.equal(isAnalyticsRange("7d"), true);
  assert.equal(isAnalyticsRange("30d"), true);
});

test("isAnalyticsRange: rejects close-but-wrong strings", () => {
  // These are realistic shapes a future client might try; each must be
  // rejected so the route falls back to the documented default rather than
  // crashing on a missing RANGE_WINDOWS lookup.
  for (const bad of [
    "1h",
    "12h",
    "48h",
    "1d",
    "14d",
    "60d",
    "90d",
    "365d",
    "all",
    "today",
    "yesterday",
    "week",
    "month",
  ]) {
    assert.equal(
      isAnalyticsRange(bad),
      false,
      `must reject look-alike value "${bad}"`,
    );
  }
});

test("isAnalyticsRange: is strictly case- and whitespace-sensitive", () => {
  // Case-folding and trimming happen in the route's `parseRange` wrapper —
  // the underlying guard must stay literal so other callers can't accidentally
  // depend on a normalisation that lives elsewhere.
  for (const bad of ["24H", "7D", "30D", " 24h", "24h ", "Twenty-four hours"]) {
    assert.equal(
      isAnalyticsRange(bad),
      false,
      `case/whitespace must not be tolerated by the guard: "${bad}"`,
    );
  }
});

test("isAnalyticsRange: rejects empty string and obviously hostile input", () => {
  assert.equal(isAnalyticsRange(""), false);
  // A SQL fragment slipped into the query — irrelevant because the SQL layer
  // uses parameterised queries, but still: the guard must refuse it loudly so
  // we don't lookup a phantom RANGE_WINDOWS entry.
  assert.equal(isAnalyticsRange("1 day"), false);
  assert.equal(isAnalyticsRange("7d; DROP TABLE transmissions"), false);
});

test("isAnalyticsRange: narrows the TypeScript type for downstream callers", () => {
  // This test is really for the TS compiler — if `isAnalyticsRange` ever
  // stops being a proper type guard, the assignment below stops compiling.
  // The runtime assertion is just to keep the test framework happy.
  const v: string = "7d";
  if (isAnalyticsRange(v)) {
    const narrowed: "24h" | "7d" | "30d" = v;
    assert.equal(narrowed, "7d");
  } else {
    assert.fail('"7d" must pass the guard');
  }
});
