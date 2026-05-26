/**
 * Tests for `server/src/clientType.ts`.
 *
 * `normalizeClientType` is the trust boundary between the over-the-wire
 * `client_type` field in `POST /v1/radio/location` and the
 * `radio_positions.client_type` DB column. It feeds the per-row platform
 * badge on the iOS UNITS roster (see PR #125) and the equivalent column
 * any future console adds.
 *
 * A regression here:
 *
 *  - Accepting an out-of-list value writes arbitrary client-supplied
 *    strings into the agency's DB column (data quality + display
 *    correctness).
 *  - Returning the wrong shape on a legacy / missing field flips the
 *    upsert SQL out of its "preserve previously-known value" branch
 *    and silently blanks rows from older clients during a rolling
 *    upgrade.
 *  - Folding case the wrong direction means a value the SQL upsert
 *    later compares with a lowercase comparison silently never matches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_CLIENT_TYPES,
  normalizeClientType,
} from "../src/clientType.js";

test("normalizeClientType: passes every documented platform through unchanged", () => {
  for (const value of ALLOWED_CLIENT_TYPES) {
    assert.equal(
      normalizeClientType(value),
      value,
      `documented platform "${value}" must round-trip`,
    );
  }
});

test("normalizeClientType: lower-cases and trims so handsets can be sloppy", () => {
  // Real handsets have historically been inconsistent about casing — the
  // server must accept "IOS" / " iOS " / "Android" rather than silently
  // demoting them to null and blanking the badge.
  assert.equal(normalizeClientType("IOS"), "ios");
  assert.equal(normalizeClientType(" iOS "), "ios");
  assert.equal(normalizeClientType("Android"), "android");
  assert.equal(normalizeClientType("WEB"), "web");
  assert.equal(normalizeClientType("Desktop"), "desktop");
  assert.equal(normalizeClientType("RADIO"), "radio");
});

test("normalizeClientType: drops empty / whitespace-only strings to null", () => {
  assert.equal(normalizeClientType(""), null);
  assert.equal(normalizeClientType("   "), null);
  assert.equal(normalizeClientType("\t\n"), null);
});

test("normalizeClientType: rejects any string outside the allow-list", () => {
  // Each of these is a realistic "what if a client made one up" scenario.
  // Every one must collapse to null so the column stays clean.
  for (const bad of [
    "iphone",
    "ipad",
    "macos",
    "linux",
    "windows",
    "browser",
    "chrome",
    "firefox",
    "ios2",
    "and",
    "android-tablet",
    "anything",
  ]) {
    assert.equal(
      normalizeClientType(bad),
      null,
      `out-of-list value "${bad}" must be dropped to null`,
    );
  }
});

test("normalizeClientType: refuses non-string input (no coercion)", () => {
  // The route hands us `body.client_type` straight off `req.body`, which can
  // be anything. A naive `String(value)` would write "true" / "[object
  // Object]" into the DB.
  assert.equal(normalizeClientType(undefined), null);
  assert.equal(normalizeClientType(null), null);
  assert.equal(normalizeClientType(0), null);
  assert.equal(normalizeClientType(1), null);
  assert.equal(normalizeClientType(true), null);
  assert.equal(normalizeClientType(false), null);
  assert.equal(normalizeClientType({}), null);
  assert.equal(normalizeClientType({ toString: () => "ios" }), null);
  assert.equal(normalizeClientType(["ios"]), null);
});

test("normalizeClientType: defends against injection-shaped strings", () => {
  // Not a SQL-injection vector (the query is parameterised) but a sanity
  // check that nothing weird about the input survives.
  assert.equal(normalizeClientType("ios; DROP TABLE radio_positions"), null);
  assert.equal(normalizeClientType("'; --"), null);
  assert.equal(normalizeClientType("<script>"), null);
  assert.equal(normalizeClientType("ios,android"), null);
});

test("normalizeClientType: returns the canonical lower-case form (matches DB convention)", () => {
  // The Postgres column stores lower-case strings (see `apiRoutes.ts` and
  // the iOS UnitsScreen renderer). The normaliser is the only piece of
  // code that enforces that — assert the contract explicitly.
  const out = normalizeClientType("Android");
  assert.equal(out, "android");
  assert.notEqual(out, "Android");
});

test("ALLOWED_CLIENT_TYPES: matches the platforms the iOS roster knows how to render", () => {
  // The iOS UnitsScreen renderer maps each tag to a coloured badge
  // (iOS / AND / WEB / DESK / RAD). If a new platform is added to the
  // server allow-list without a matching badge case, units will render
  // as "—" silently. This assertion is a tripwire so any allow-list
  // expansion forces a deliberate review of the test (and, implicitly,
  // of the iOS renderer).
  assert.deepEqual(
    [...ALLOWED_CLIENT_TYPES].sort(),
    ["android", "desktop", "ios", "radio", "web"],
  );
});
