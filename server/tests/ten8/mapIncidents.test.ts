/**
 * Tests for the pure helpers in `server/src/ten8/mapIncidents.ts`.
 *
 * `listTen8MapIncidents` is the data source for the dispatch console's
 * "live unit map" pin layer for active 10-8 calls. Two pieces of logic
 * gate every pin the dispatcher sees:
 *
 *  1. `coordsFromPayload` is the FAST PATH: if the 10-8 webhook already
 *     shipped a lat/lon on the incident, we use those coordinates and skip
 *     the (rate-limited, paid, and externally-flaky) geocode call. A
 *     regression here either:
 *       - drops valid coordinates and forces a geocode storm against
 *         OpenStreetMap / Google Maps (rate-limit / cost incident), or
 *       - accepts garbage lat/lon (NaN, out-of-range, swapped sign) and
 *         pins units in the middle of the ocean / outside the country.
 *
 *  2. `callLabel` is what the dispatcher reads in the map tooltip. It must
 *     prefer the SHORT radio code ("415" out of "415 - Disturbing the
 *     Peace") because the tooltip is one short line, but it must NEVER
 *     fall through to the raw call_id when there IS an incident_type —
 *     the call_id is an opaque 10-8 string and the dispatcher can't read
 *     it on the air.
 *
 * The webhook ships at least three different incident shapes in the wild
 * (root vs nested, latitude/longitude vs lat/lng vs locationLat/Lng), all
 * of which must be recognised — the consolidation table is the single
 * point of truth for those variants.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { callLabel, coordsFromPayload } from "../../src/ten8/mapIncidents.js";

// ---------- coordsFromPayload ------------------------------------------

test("coordsFromPayload: returns null for null / undefined / non-object payloads", () => {
  assert.equal(coordsFromPayload(null), null);
  assert.equal(coordsFromPayload(undefined), null);
  assert.equal(coordsFromPayload("not an object"), null);
  assert.equal(coordsFromPayload(123), null);
});

test("coordsFromPayload: reads coordinates nested under incident.latitude / incident.longitude (canonical webhook shape)", () => {
  const out = coordsFromPayload({
    action: "create",
    incident: { latitude: 33.8121, longitude: -117.919 },
  });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: also accepts root-level coordinates (older webhook shape)", () => {
  // Webhook history has shipped both nested and root-level coordinates; both
  // must keep working or older agencies' pins silently vanish from the map.
  const out = coordsFromPayload({ latitude: 33.8121, longitude: -117.919 });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: tolerates the lat/lng spelling variant (Google convention)", () => {
  const out = coordsFromPayload({ incident: { lat: 33.8121, lng: -117.919 } });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: tolerates lat/lon spelling (OpenStreetMap convention)", () => {
  const out = coordsFromPayload({ incident: { lat: 33.8121, lon: -117.919 } });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: tolerates capitalized Latitude/Longitude keys (10-8 export convention)", () => {
  const out = coordsFromPayload({ incident: { Latitude: 33.8, Longitude: -117.9 } });
  assert.deepEqual(out, { lat: 33.8, lon: -117.9 });
});

test("coordsFromPayload: tolerates locationLat / locationLng + snake_case variants", () => {
  assert.deepEqual(
    coordsFromPayload({ incident: { locationLat: 33.8, locationLng: -117.9 } }),
    { lat: 33.8, lon: -117.9 },
  );
  assert.deepEqual(
    coordsFromPayload({ incident: { location_lat: 33.8, location_lng: -117.9 } }),
    { lat: 33.8, lon: -117.9 },
  );
});

test("coordsFromPayload: parses string lat/lon (10-8 sometimes ships strings)", () => {
  // Number(string) is what the helper relies on; the wild-format tolerance
  // is intentional. Pin this so a future "type-safe" refactor doesn't drop it.
  const out = coordsFromPayload({ incident: { latitude: "33.8121", longitude: "-117.919" } });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

test("coordsFromPayload: returns null when lat or lon is missing", () => {
  assert.equal(coordsFromPayload({ incident: { latitude: 33.8 } }), null);
  assert.equal(coordsFromPayload({ incident: { longitude: -117.9 } }), null);
  assert.equal(coordsFromPayload({ incident: {} }), null);
});

test("coordsFromPayload: rejects NaN / Infinity (so map pins can't land at NaN,NaN)", () => {
  assert.equal(
    coordsFromPayload({ incident: { latitude: "not a number", longitude: -117.9 } }),
    null,
  );
  assert.equal(
    coordsFromPayload({ incident: { latitude: 33.8, longitude: Number.POSITIVE_INFINITY } }),
    null,
  );
  // NaN explicitly.
  assert.equal(
    coordsFromPayload({ incident: { latitude: Number.NaN, longitude: -117.9 } }),
    null,
  );
});

test("coordsFromPayload: rejects out-of-range coordinates (>|90| lat, >|180| lon)", () => {
  // A swapped lat/lon ("longitude" of 33.8, "latitude" of -117.9) would land
  // a pin in the wrong hemisphere; the |lat| <= 90 / |lon| <= 180 guard
  // catches that exact case.
  assert.equal(
    coordsFromPayload({ incident: { latitude: -117.919, longitude: 33.8121 } }),
    null,
    "swapped lat/lon must be rejected (lat=-117.9 is out of range)",
  );
  // Exact edge values are still accepted (inclusive bound).
  assert.deepEqual(
    coordsFromPayload({ incident: { latitude: 90, longitude: -180 } }),
    { lat: 90, lon: -180 },
  );
  assert.deepEqual(
    coordsFromPayload({ incident: { latitude: -90, longitude: 180 } }),
    { lat: -90, lon: 180 },
  );
  // One step past the bound must be rejected.
  assert.equal(coordsFromPayload({ incident: { latitude: 90.0001, longitude: 0 } }), null);
  assert.equal(coordsFromPayload({ incident: { latitude: 0, longitude: 180.0001 } }), null);
});

test("coordsFromPayload: incident-nested keys win over root-level keys (canonical wins)", () => {
  // Both shapes present at the same time: incident.* must take priority
  // because that's the explicit 10-8 webhook contract. Mixing root + nested
  // could silently swap the pin when a webhook adds nested fields without
  // dropping the legacy root ones.
  const out = coordsFromPayload({
    latitude: 0,
    longitude: 0,
    incident: { latitude: 33.8, longitude: -117.9 },
  });
  assert.deepEqual(out, { lat: 33.8, lon: -117.9 });
});

test("coordsFromPayload: returns the FIRST matching coordinate pair (key order in the candidates table)", () => {
  // latitude/longitude is checked before lat/lng. A payload that contains
  // both should resolve to the latitude/longitude pair (this protects
  // against subtle precision drift between mirrored fields).
  const out = coordsFromPayload({
    incident: { latitude: 33.8121, longitude: -117.919, lat: 0, lng: 0 },
  });
  assert.deepEqual(out, { lat: 33.8121, lon: -117.919 });
});

// ---------- callLabel ----------------------------------------------------

test("callLabel: extracts the radio code before the dash separator (415 out of '415 - Disturbing the Peace')", () => {
  assert.equal(callLabel("415 - Disturbing the Peace", "C25-001234"), "415");
  assert.equal(callLabel("961 - Car Stop", "C25-001234"), "961");
});

test("callLabel: also accepts en-dash / em-dash separators (10-8 type strings vary)", () => {
  // 10-8 ships incident types with U+2013 (–) and U+2014 (—) separators too.
  assert.equal(callLabel("415 – Disturbing the Peace", "C25-001"), "415");
  assert.equal(callLabel("415 — Disturbing the Peace", "C25-001"), "415");
});

test("callLabel: returns the trimmed type when there is no dash separator", () => {
  assert.equal(callLabel("Welfare Check", "C25-001"), "Welfare Check");
  assert.equal(callLabel("  Welfare Check  ", "C25-001"), "Welfare Check");
});

test("callLabel: long types (>40 chars) get truncated with an ellipsis so the tooltip stays one line", () => {
  const longType = "A".repeat(50);
  const out = callLabel(longType, "C25-001");
  // 38 chars + a single Unicode ellipsis. Total displayed length is 39.
  assert.equal(out, "A".repeat(38) + "…");
  assert.ok(out.length <= 40, `label length ${out.length} must stay <= 40`);
});

test("callLabel: short types are returned verbatim", () => {
  assert.equal(callLabel("BURG", "C25-001"), "BURG");
});

test("callLabel: falls back to the call_id when no incident_type is present", () => {
  // Only when there's literally nothing to render does the opaque call_id
  // surface — and even then it's better than a blank pin tooltip.
  assert.equal(callLabel(null, "C25-001"), "C25-001");
  assert.equal(callLabel("", "C25-001"), "C25-001");
  assert.equal(callLabel("   ", "C25-001"), "C25-001");
});

test("callLabel: when incident_type has the dash but an empty code, the trimmed type is used (not the empty match)", () => {
  // Defensive: an incident_type like " - Disturbing the Peace" must NOT
  // surface as an empty radio code on the tooltip.
  const out = callLabel(" - Disturbing the Peace", "C25-001");
  assert.notEqual(out, "");
  assert.notEqual(out, " ");
});
