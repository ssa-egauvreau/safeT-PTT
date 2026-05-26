/**
 * Tests for `isAnalyticsRange` in `server/src/analytics.ts`.
 *
 * Every analytics endpoint in `apiRoutes.ts` (`/v1/analytics/summary`,
 * `/timeseries`, `/channels`, `/units`, `/ai-outcomes`) funnels through this
 * predicate to coerce the `range` query string into one of the three
 * server-defined windows (24h / 7d / 30d).
 *
 * The defence layer matters: range strings are substituted directly into
 * the SQL via a constant interval mapping, and `getTimeSeries` interpolates
 * the `bucketUnit` literal into the date_trunc() call. If a future change
 * accidentally accepts a free-form range, that interpolation becomes the
 * SQL-injection surface the predicate exists to prevent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isAnalyticsRange } from "../src/analytics.js";

test("isAnalyticsRange: accepts exactly the three server-defined windows", () => {
  assert.equal(isAnalyticsRange("24h"), true);
  assert.equal(isAnalyticsRange("7d"), true);
  assert.equal(isAnalyticsRange("30d"), true);
});

test("isAnalyticsRange: rejects every other value (no implicit normalization)", () => {
  // Uppercase / whitespace / synonyms are NOT accepted — `parseRange` in
  // apiRoutes is the only place allowed to massage the input. If this
  // predicate ever loosens, the SQL interpolation in getTimeSeries opens
  // up.
  const rejects = [
    "",
    " ",
    "24H",
    "7D",
    "1d",
    "31d",
    "day",
    "24 hours",
    "24h ",
    " 7d",
    "all",
    "lifetime",
    "drop table;",
    "7d OR 1=1",
  ];
  for (const v of rejects) {
    assert.equal(isAnalyticsRange(v), false, `must reject ${JSON.stringify(v)}`);
  }
});
