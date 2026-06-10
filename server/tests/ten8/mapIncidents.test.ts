/**
 * Tests for the pure helpers in `server/src/ten8/mapIncidents.ts`.
 *
 * These two helpers decide what the dispatch console map shows for every
 * active 10-8 call:
 *
 *   - `callLabel`: short pin label. A regression makes every pin read
 *     wrong (and overflows the marker tooltip layout if a full
 *     "459 - Burglary in Progress, Single Subject" string lands there).
 *   - `coordsFromPayload`: which 10-8 payload field becomes the pin
 *     coordinates, and the safety bounds. A regression here either
 *     drops live calls off the map silently or plots them somewhere
 *     impossible (lat 91°, lon 200°, "0,0" off the coast of Africa).
 *
 * Both helpers run server-side for every map request, so a regression is
 * felt by every console operator at once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callLabel,
  coordsFromPayload,
} from "../../src/ten8/mapIncidents.js";

// ---------- callLabel ---------------------------------------------------

test("callLabel: '<code> - <description>' is shortened to just '<code>'", () => {
  assert.equal(
    callLabel("459 - Burglary in Progress", "C-1"),
    "459",
  );
  assert.equal(
    callLabel("961 - Vehicle Stop", "C-2"),
    "961",
  );
});

test("callLabel: en-dash and em-dash are also recognized as separators", () => {
  // 10-8 / CAD type strings are sometimes copy-pasted with a unicode dash.
  // The original implementation matches `[-–—]` so all three should split.
  assert.equal(callLabel("459 \u2013 Burglary", "C-3"), "459");
  assert.equal(callLabel("459 \u2014 Burglary", "C-4"), "459");
});

test("callLabel: incident type with no separator is read verbatim when short", () => {
  assert.equal(callLabel("Patrol Check", "C-5"), "Patrol Check");
});

test("callLabel: a long unseparated type is ellipsized rather than overflowing the pin", () => {
  // Pins can't render an arbitrarily-long label without breaking the
  // tooltip layout — the helper caps at ~40 chars with an ellipsis.
  const long = "Very Long Incident Type Description Without Any Dash Separator";
  const out = callLabel(long, "C-6");
  assert.ok(
    out.length <= 40,
    `label must be <= 40 chars, got ${out.length}: ${out}`,
  );
  assert.ok(out.endsWith("\u2026"), `must end with ellipsis, got: ${out}`);
});

test("callLabel: exactly 40 characters is read as-is (no ellipsis)", () => {
  const exactly40 = "x".repeat(40);
  assert.equal(callLabel(exactly40, "C-7"), exactly40);
});

test("callLabel: null / empty / whitespace type falls back to the call id", () => {
  assert.equal(callLabel(null, "C-1234"), "C-1234");
  assert.equal(callLabel("", "C-1234"), "C-1234");
  assert.equal(callLabel("   ", "C-1234"), "C-1234");
});

test("callLabel: leading/trailing whitespace is trimmed before checking separator", () => {
  assert.equal(callLabel("  459 - Burglary  ", "C-8"), "459");
});

// ---------- coordsFromPayload -------------------------------------------

test("coordsFromPayload: reads incident.latitude / incident.longitude", () => {
  const got = coordsFromPayload({
    incident: { latitude: 33.8121, longitude: -117.919 },
  });
  assert.deepEqual(got, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: reads top-level lat/lng when no incident wrapper", () => {
  // Some webhook shapes hand us the incident fields without an outer wrapper.
  const got = coordsFromPayload({ lat: 33.8121, lng: -117.919 });
  assert.deepEqual(got, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: accepts lat/lon spelling as well as lat/lng", () => {
  const got = coordsFromPayload({ incident: { lat: 33.8121, lon: -117.919 } });
  assert.deepEqual(got, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: accepts capitalized Latitude/Longitude", () => {
  const got = coordsFromPayload({
    incident: { Latitude: 33.8121, Longitude: -117.919 },
  });
  assert.deepEqual(got, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: accepts locationLat / locationLng aliases", () => {
  const a = coordsFromPayload({ incident: { locationLat: 33.81, locationLng: -117.91 } });
  assert.deepEqual(a, { lat: 33.81, lon: -117.91 });

  const b = coordsFromPayload({ incident: { location_lat: 33.81, location_lng: -117.91 } });
  assert.deepEqual(b, { lat: 33.81, lon: -117.91 });
});

test("coordsFromPayload: coerces string-shaped numbers (10-8 sometimes ships strings)", () => {
  const got = coordsFromPayload({
    incident: { latitude: "33.8121", longitude: "-117.919" },
  });
  assert.deepEqual(got, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: falls back to coordinates string when no numeric fields", () => {
  // 10-8 also ships a single "33.8121,-117.919" string in coordinates/latlng/latLng.
  const a = coordsFromPayload({ incident: { coordinates: "33.8121,-117.919" } });
  assert.deepEqual(a, { lat: 33.8121, lon: -117.919 });

  const b = coordsFromPayload({ incident: { latlng: "33.8121, -117.919" } });
  assert.deepEqual(b, { lat: 33.8121, lon: -117.919 });

  // Paren-wrapped form is also accepted (Postgres point literal).
  const c = coordsFromPayload({ incident: { latLng: "(33.8121, -117.919)" } });
  assert.deepEqual(c, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: rejects out-of-range latitudes (|lat| > 90)", () => {
  // Anything outside the WGS84 range is almost certainly a CAD field
  // mix-up (lat/lon swapped, lat-in-degrees-times-1e6, etc.). Drop the
  // pin instead of plotting it at the pole.
  assert.equal(
    coordsFromPayload({ incident: { latitude: 91, longitude: 0 } }),
    null,
  );
  assert.equal(
    coordsFromPayload({ incident: { latitude: -91, longitude: 0 } }),
    null,
  );
});

test("coordsFromPayload: rejects out-of-range longitudes (|lon| > 180)", () => {
  assert.equal(
    coordsFromPayload({ incident: { latitude: 0, longitude: 181 } }),
    null,
  );
  assert.equal(
    coordsFromPayload({ incident: { latitude: 0, longitude: -181 } }),
    null,
  );
});

test("coordsFromPayload: rejects NaN (non-numeric string fails Number.isFinite)", () => {
  // `Number("not-a-number")` is NaN, which is not finite, so the entire
  // candidate must be skipped — not coerced to 0 / a default coordinate.
  assert.equal(
    coordsFromPayload({ incident: { latitude: "not-a-number", longitude: -117.9 } }),
    null,
  );
  assert.equal(
    coordsFromPayload({ incident: { latitude: 33.8, longitude: "abc" } }),
    null,
  );
});

test("coordsFromPayload: rejects Infinity values", () => {
  assert.equal(
    coordsFromPayload({ incident: { latitude: Infinity, longitude: 0 } }),
    null,
  );
  assert.equal(
    coordsFromPayload({ incident: { latitude: 0, longitude: -Infinity } }),
    null,
  );
});

test("coordsFromPayload: accepts (0, 0) as a valid coordinate (in-range)", () => {
  // The implementation uses Number.isFinite + |lat| <= 90 + |lon| <= 180.
  // (0, 0) is technically valid (off the coast of Africa) — if a real CAD
  // ever ships this it would surface a misconfigured agency, but the helper
  // itself must not silently filter it out under the guise of validation.
  const got = coordsFromPayload({ incident: { latitude: 0, longitude: 0 } });
  assert.deepEqual(got, { lat: 0, lon: 0 });
});

test("coordsFromPayload: returns null for null / non-object payloads", () => {
  assert.equal(coordsFromPayload(null), null);
  assert.equal(coordsFromPayload(undefined), null);
  assert.equal(coordsFromPayload("33.8,-117.9"), null);
  assert.equal(coordsFromPayload(42), null);
});

test("coordsFromPayload: returns null when no recognized field is present", () => {
  assert.equal(coordsFromPayload({ incident: { other: 1 } }), null);
  assert.equal(coordsFromPayload({ incident: {} }), null);
  assert.equal(coordsFromPayload({}), null);
});

test("coordsFromPayload: rejects coordinate strings that don't parse to two numbers", () => {
  assert.equal(coordsFromPayload({ incident: { coordinates: "not coords" } }), null);
  assert.equal(coordsFromPayload({ incident: { coordinates: "33.8121" } }), null);
});

test("coordsFromPayload: field priority — explicit lat/lng wins over coordinates string", () => {
  // Lock the priority so a "coordinates" field that disagrees with the
  // explicit numeric fields can't override the numeric ones.
  const got = coordsFromPayload({
    incident: { latitude: 33.8, longitude: -117.9, coordinates: "0,0" },
  });
  assert.deepEqual(got, { lat: 33.8, lon: -117.9 });
});
