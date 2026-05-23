/**
 * Tests for `server/src/ten8/vehicles.ts`.
 *
 * These two helpers are what the AI dispatcher sends to 10-8 CAD when a
 * plate / VIN lookup comes back from the upstream provider:
 *   - `buildTen8AddVehicleBody` → AddVehicleRequest body for the
 *     `POST /v1/incidents/{lookup}/vehicles` API call (structured fields).
 *   - `formatTen8VehicleLookupComment` → ALL-CAPS one-line CAD comment used
 *     as the fallback when the vehicle-add endpoint isn't applied.
 *
 * Why this is worth its own regression suite:
 *   - the structured form decides which lookup fields actually land on the
 *     CAD vehicle record (license / state / VIN / year / make / model /
 *     color),
 *   - the year guard is what stops bogus model years ("2099", "abcd")
 *     from being submitted as numeric `year`,
 *   - the comment formatter is the cop-readable fallback — it must always
 *     include the plate-and-state (or the VIN) and never emit placeholder
 *     junk like "VEHICLE LOOKUP" with nothing after it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { PlateLookupResult } from "../../src/aiDispatch/plateLookup.js";
import {
  buildTen8AddVehicleBody,
  formatTen8VehicleLookupComment,
} from "../../src/ten8/vehicles.js";

function lookup(overrides: Partial<PlateLookupResult> = {}): PlateLookupResult {
  return { ok: true, ...overrides };
}

// -- buildTen8AddVehicleBody ---------------------------------------------

test("buildTen8AddVehicleBody: returns null when the lookup failed", () => {
  assert.equal(
    buildTen8AddVehicleBody(lookup({ ok: false, reason: "no record" })),
    null,
  );
});

test("buildTen8AddVehicleBody: returns null when every vehicle field is empty", () => {
  // Lookup succeeded but the provider returned no usable fields — nothing
  // to send to the AddVehicle endpoint.
  assert.equal(buildTen8AddVehicleBody(lookup({})), null);
  // year string with no digits also yields no usable fields.
  assert.equal(
    buildTen8AddVehicleBody(lookup({ year: "abcd", plate: null, vin: null })),
    null,
  );
});

test("buildTen8AddVehicleBody: trims + uppercases plate / VIN / state", () => {
  const body = buildTen8AddVehicleBody(
    lookup({
      plate: "  8vwv621  ",
      state: " ca ",
      vin: " 1hgbh41jxmn109186 ",
      make: " Honda ",
      model: " Civic ",
      color: " Silver ",
      year: "2018",
    }),
  );
  assert.ok(body, "body must be non-null");
  assert.equal(body!.vehicle.license, "8VWV621");
  assert.equal(body!.vehicle.state, "CA");
  assert.equal(body!.vehicle.vin, "1HGBH41JXMN109186");
  // Non-identifier fields are trimmed but preserve their case.
  assert.equal(body!.vehicle.make, "Honda");
  assert.equal(body!.vehicle.model, "Civic");
  assert.equal(body!.vehicle.color, "Silver");
  assert.equal(body!.vehicle.year, 2018);
});

test("buildTen8AddVehicleBody: year must be 1900..2100 to land on the body", () => {
  // In-range numeric years land.
  assert.equal(
    buildTen8AddVehicleBody(lookup({ plate: "ABC123", year: "1995" }))!.vehicle.year,
    1995,
  );
  // Out-of-range years are dropped (no `year` key on the vehicle body).
  const tooOld = buildTen8AddVehicleBody(lookup({ plate: "ABC123", year: "1800" }));
  assert.equal(tooOld!.vehicle.year, undefined);
  const tooNew = buildTen8AddVehicleBody(lookup({ plate: "ABC123", year: "2999" }));
  assert.equal(tooNew!.vehicle.year, undefined);
  // Garbage with no extractable digits is dropped, but the plate still lands.
  const garbage = buildTen8AddVehicleBody(lookup({ plate: "ABC123", year: "abcd" }));
  assert.equal(garbage!.vehicle.year, undefined);
  assert.equal(garbage!.vehicle.license, "ABC123");
});

test("buildTen8AddVehicleBody: pulls leading digits out of mixed year strings", () => {
  // Some providers return e.g. "2018 model" — the digits should still
  // produce a numeric year.
  const body = buildTen8AddVehicleBody(lookup({ plate: "ABC123", year: "2018 model" }));
  assert.equal(body!.vehicle.year, 2018);
});

test("buildTen8AddVehicleBody: notes line reflects the lookup type (plate / VIN / fallback)", () => {
  // Plate + state → "Plate lookup CA ABC123".
  const plate = buildTen8AddVehicleBody(lookup({ plate: "abc123", state: "ca" }));
  assert.equal(plate!.notes, "Plate lookup CA ABC123");

  // VIN-only → "VIN lookup".
  const vin = buildTen8AddVehicleBody(
    lookup({ plate: null, state: null, vin: "1HGBH41JXMN109186" }),
  );
  assert.equal(vin!.notes, "VIN lookup");

  // Only make/model/color (no plate or VIN) → generic "Vehicle lookup".
  const generic = buildTen8AddVehicleBody(
    lookup({ make: "Honda", model: "Civic", color: "Silver" }),
  );
  assert.equal(generic!.notes, "Vehicle lookup");
});

test("buildTen8AddVehicleBody: omits keys that have no value", () => {
  // Only plate is set — body must not have undefined `vin`/`make`/etc keys.
  const body = buildTen8AddVehicleBody(lookup({ plate: "ABC123" }));
  assert.deepEqual(Object.keys(body!.vehicle).sort(), ["license"]);
});

// -- formatTen8VehicleLookupComment --------------------------------------

test("formatTen8VehicleLookupComment: returns null when callsign is blank", () => {
  assert.equal(formatTen8VehicleLookupComment("", lookup({ plate: "ABC123" })), null);
  assert.equal(
    formatTen8VehicleLookupComment("   ", lookup({ plate: "ABC123" })),
    null,
  );
});

test("formatTen8VehicleLookupComment: success path with full data", () => {
  // CS + VEHICLE LOOKUP + STATE PLATE + year/make/model/color, no trailing
  // VIN segment because plate was used.
  const out = formatTen8VehicleLookupComment(
    "040",
    lookup({
      plate: "8VWV621",
      state: "CA",
      year: "2018",
      make: "Honda",
      model: "Civic",
      color: "Silver",
    }),
  );
  assert.equal(out, "040 VEHICLE LOOKUP CA 8VWV621 2018 Honda Civic Silver");
});

test("formatTen8VehicleLookupComment: drops state-prefix when state is missing", () => {
  const out = formatTen8VehicleLookupComment("040", lookup({ plate: "8VWV621" }));
  assert.equal(out, "040 VEHICLE LOOKUP 8VWV621");
});

test("formatTen8VehicleLookupComment: VIN-only path uses 'VIN <vin>' prefix", () => {
  const out = formatTen8VehicleLookupComment(
    "040",
    lookup({ plate: null, state: null, vin: "1HGBH41JXMN109186", make: "Honda" }),
  );
  // VIN-only: only one "VIN ..." segment, plus the make.
  assert.equal(out, "040 VEHICLE LOOKUP VIN 1HGBH41JXMN109186 Honda");
});

test("formatTen8VehicleLookupComment: appends VIN at the end when both plate and VIN are present", () => {
  // Plate + VIN: lead with plate, then year/make/model/color, then "VIN ...".
  const out = formatTen8VehicleLookupComment(
    "040",
    lookup({
      plate: "8VWV621",
      state: "CA",
      vin: "1HGBH41JXMN109186",
      year: "2018",
      make: "Honda",
      model: "Civic",
    }),
  );
  assert.equal(
    out,
    "040 VEHICLE LOOKUP CA 8VWV621 2018 Honda Civic VIN 1HGBH41JXMN109186",
  );
});

test("formatTen8VehicleLookupComment: failure path uses reason / message in ALL CAPS", () => {
  // `reason` wins over `message` and underscores become spaces.
  const reasoned = formatTen8VehicleLookupComment(
    "040",
    lookup({ ok: false, plate: "ABC123", state: "CA", reason: "no_record" }),
  );
  assert.equal(reasoned, "040 VEHICLE LOOKUP CA ABC123 NO RECORD");

  // Falls through to `message` when no `reason`.
  const messaged = formatTen8VehicleLookupComment(
    "040",
    lookup({ ok: false, plate: "ABC123", state: "CA", message: "provider down" }),
  );
  assert.equal(messaged, "040 VEHICLE LOOKUP CA ABC123 PROVIDER DOWN");

  // Both missing → default "no record" wording.
  const defaulted = formatTen8VehicleLookupComment(
    "040",
    lookup({ ok: false, plate: "ABC123", state: "CA" }),
  );
  assert.equal(defaulted, "040 VEHICLE LOOKUP CA ABC123 NO RECORD");
});

test("formatTen8VehicleLookupComment: caps the comment at 4000 chars", () => {
  // The CAD comment hard-cap is 4000 — `slice(0, 4000)` is what enforces
  // it. A regression here can post a comment that 10-8 rejects.
  const bigMake = "Z".repeat(5000);
  const big = formatTen8VehicleLookupComment(
    "040",
    lookup({ plate: "ABC123", state: "CA", make: bigMake }),
  );
  assert.ok(big);
  assert.equal(big!.length, 4000);
});

test("formatTen8VehicleLookupComment: trims surrounding whitespace on callsign", () => {
  const out = formatTen8VehicleLookupComment(" 040 ", lookup({ plate: "ABC123" }));
  assert.equal(out, "040 VEHICLE LOOKUP ABC123");
});
