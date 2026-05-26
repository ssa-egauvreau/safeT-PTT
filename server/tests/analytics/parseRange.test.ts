/**
 * Regression tests for `parseAnalyticsRange` — the input-coercion helper
 * that every `/v1/analytics/*` route uses to turn `req.query.range` into
 * a known-good {@link AnalyticsRange} token.
 *
 * The narrowing predicate `isAnalyticsRange` is tested separately in
 * `range.test.ts`; this file covers the coercion layer that sits on top
 * of it. Together they form the SQL-safety gate for the analytics
 * module: `analytics.ts` interpolates the matching RANGE_WINDOWS row
 * (`bucketUnit`, `buckets`) into SQL by name, so the route MUST hand it
 * a whitelisted token for every request.
 *
 * These tests pin:
 *
 *   1. Canonical tokens pass through unchanged.
 *   2. Case + whitespace tolerance the helper added when it moved out
 *      of the route handler, so common URL variants don't silently fall
 *      back to the default. Without this, `?range=24H` or `?range=%2024h`
 *      (a URL-decoded leading space) would have landed every user on the
 *      7-day dashboard instead of the 24-hour one.
 *   3. Default-on-garbage behaviour (always returns 7d, never throws) —
 *      the route handler does NOT wrap the parser in a try/catch, so a
 *      regression that started throwing would produce a 500 instead of
 *      a usable default.
 *   4. Non-string inputs (undefined, arrays from duplicated query keys,
 *      objects from a quirky middleware, etc.) coerce safely.
 *   5. Hostile-looking strings never resolve to anything but the
 *      whitelisted set, even when they happen to start with a valid
 *      token prefix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAnalyticsRange } from "../../src/analytics.js";

test("parseAnalyticsRange: passes through canonical tokens unchanged", () => {
  assert.equal(parseAnalyticsRange("24h"), "24h");
  assert.equal(parseAnalyticsRange("7d"), "7d");
  assert.equal(parseAnalyticsRange("30d"), "30d");
});

test("parseAnalyticsRange: folds case and trims whitespace before matching", () => {
  assert.equal(parseAnalyticsRange("24H"), "24h");
  assert.equal(parseAnalyticsRange("7D"), "7d");
  assert.equal(parseAnalyticsRange("30D"), "30d");
  assert.equal(parseAnalyticsRange(" 24h "), "24h");
  assert.equal(parseAnalyticsRange("\t7d\n"), "7d");
  assert.equal(parseAnalyticsRange("30D  "), "30d");
});

test("parseAnalyticsRange: unknown strings fall back to the 7d default", () => {
  // The default is contractually 7d (documented in the helper's JSDoc, and
  // the front-end's localStorage default also assumes this); a regression
  // that defaulted to 24h or 30d would change which dashboard a returning
  // user lands on after a code update.
  assert.equal(parseAnalyticsRange(""), "7d");
  assert.equal(parseAnalyticsRange("   "), "7d");
  assert.equal(parseAnalyticsRange("1h"), "7d");
  assert.equal(parseAnalyticsRange("365d"), "7d");
  assert.equal(parseAnalyticsRange("all"), "7d");
});

test("parseAnalyticsRange: non-string inputs are coerced to default, not thrown", () => {
  // req.query.range can legitimately come through as undefined (no query),
  // an array (?range=24h&range=7d), or a number-y object — the helper must
  // never throw or the route returns 500 instead of a useful default.
  assert.equal(parseAnalyticsRange(undefined), "7d");
  assert.equal(parseAnalyticsRange(null), "7d");
  assert.equal(parseAnalyticsRange(42 as unknown), "7d");
  assert.equal(parseAnalyticsRange(["24h", "7d"] as unknown), "7d");
  assert.equal(parseAnalyticsRange({ range: "24h" } as unknown), "7d");
  assert.equal(parseAnalyticsRange(true as unknown), "7d");
});

test("parseAnalyticsRange: hostile-looking strings still resolve to the default", () => {
  // The parser is the SQL-safety gate for the analytics module — any
  // attempt to smuggle in a fragment that would land in an interpolated
  // SQL position must end up as the default token.
  for (const v of [
    "24h; DROP TABLE transmissions;--",
    "7d OR 1=1",
    "30d'; SELECT pg_sleep(10);--",
    "%2724h%27",
  ]) {
    const out = parseAnalyticsRange(v);
    assert.ok(
      out === "24h" || out === "7d" || out === "30d",
      `expected ${JSON.stringify(v)} to resolve to a whitelisted token, got ${out}`,
    );
    // And specifically: none of these strings happen to *contain* a valid
    // token prefix in a way that the parser could mistakenly accept.
    assert.equal(out, "7d");
  }
});
