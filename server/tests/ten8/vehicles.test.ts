/**
 * Tests for `server/src/ten8/vehicles.ts`.
 *
 * These helpers build the AddVehicleRequest body that gets POSTed to
 * 10-8 CAD `POST /v1/incidents/{lookup}/vehicles` and the structured
 * comment that gets posted to a call when the structured AddVehicle API
 * is not available.
 *
 * A regression here means a plate-lookup result either:
 *   - never makes it onto the incident (officer's run never shows on
 *     the call sheet), or
 *   - is posted with the wrong year / make / VIN (officer sees a
 *     mismatched record for the car they actually have stopped).
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
import type { PlateLookupResult } from "../../src/aiDispatch/plateLookup.js";

// ---------- buildTen8AddVehicleBody --------------------------------------

test("buildTen8AddVehicleBody returns null when lookup.ok is false", () => {
  const failed: PlateLookupResult = {
    ok: false,
    plate: "8VWV621",
    state: "CA",
    reason: "no_record",
  };
  assert.equal(buildTen8AddVehicleBody(failed), null);
});

test("buildTen8AddVehicleBody returns null when ok but every vehicle field is empty", () => {
  // A 'success' response with no usable fields would otherwise POST an
  // empty vehicle row to 10-8 and clutter the incident.
  const empty: PlateLookupResult = { ok: true, plate: "", vin: "", state: "" };
  assert.equal(buildTen8AddVehicleBody(empty), null);
});

test("buildTen8AddVehicleBody uppercases plate/state/VIN and includes only present fields", () => {
  const lookup: PlateLookupResult = {
    ok: true,
    plate: " 8vwv621 ",
    state: " ca ",
    vin: " 1HGCM82633A123456 ",
    make: "Honda",
    model: "Civic",
    color: "White",
    year: "2014",
  };
  const out = buildTen8AddVehicleBody(lookup);
  assert.deepEqual(out, {
    notes: "Plate lookup CA 8VWV621",
    vehicle: {
      license: "8VWV621",
      vin: "1HGCM82633A123456",
      state: "CA",
      make: "Honda",
      model: "Civic",
      color: "White",
      year: 2014,
    },
  });
});

test("buildTen8AddVehicleBody parses 4-digit year, rejects garbage and out-of-range years", () => {
  const base: PlateLookupResult = {
    ok: true,
    plate: "ABC123",
    state: "CA",
    make: "Ford",
  };
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "2020" })?.vehicle.year, 2020);
  // Digit-strip happens before parseInt, but a 2-digit "year" (e.g. "'14")
  // falls below the 1900 floor and gets discarded — we never post a 2-digit
  // year to 10-8 because it would otherwise be displayed as the year 14 AD.
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "  '14 " })?.vehicle.year, undefined);
  // year < 1900 or > 2100 must be dropped.
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "1800" })?.vehicle.year, undefined);
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "9999" })?.vehicle.year, undefined);
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "abc" })?.vehicle.year, undefined);
  assert.equal(buildTen8AddVehicleBody({ ...base, year: null })?.vehicle.year, undefined);
  // Reasonable model years all pass.
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "1995" })?.vehicle.year, 1995);
  assert.equal(buildTen8AddVehicleBody({ ...base, year: "2026" })?.vehicle.year, 2026);
});

test("buildTen8AddVehicleBody notes prefer plate+state, then VIN-only, then generic", () => {
  // Plate + state
  assert.equal(
    buildTen8AddVehicleBody({ ok: true, plate: "ABC123", state: "CA", make: "Ford" })?.notes,
    "Plate lookup CA ABC123",
  );
  // VIN-only
  assert.equal(
    buildTen8AddVehicleBody({
      ok: true,
      vin: "1HGCM82633A123456",
      make: "Ford",
    })?.notes,
    "VIN lookup",
  );
  // Neither plate+state nor VIN — just decoded fields
  assert.equal(
    buildTen8AddVehicleBody({ ok: true, make: "Ford", model: "F-150", color: "Red" })?.notes,
    "Vehicle lookup",
  );
});

test("buildTen8AddVehicleBody omits absent optional fields (no undefined keys leak into the body)", () => {
  const lookup: PlateLookupResult = { ok: true, plate: "ABC123", state: "CA" };
  const out = buildTen8AddVehicleBody(lookup);
  assert.ok(out);
  assert.deepEqual(Object.keys(out!.vehicle).sort(), ["license", "state"]);
});

// ---------- formatTen8VehicleLookupComment ------------------------------

test("formatTen8VehicleLookupComment: success comment carries plate, state, and decoded car", () => {
  const out = formatTen8VehicleLookupComment("27-040", {
    ok: true,
    plate: "8VWV621",
    state: "CA",
    year: "2014",
    make: "Honda",
    model: "Civic",
    color: "White",
  });
  assert.equal(out, "27-040 VEHICLE LOOKUP CA 8VWV621 2014 Honda Civic White");
});

test("formatTen8VehicleLookupComment: includes VIN suffix when both plate and VIN are present", () => {
  const out = formatTen8VehicleLookupComment("27-040", {
    ok: true,
    plate: "8VWV621",
    state: "CA",
    make: "Honda",
    model: "Civic",
    vin: "1HGCM82633A123456",
  });
  assert.ok(out);
  assert.match(out!, /VIN 1HGCM82633A123456$/);
});

test("formatTen8VehicleLookupComment: VIN-only success drops the plate slot", () => {
  const out = formatTen8VehicleLookupComment("27-040", {
    ok: true,
    vin: "1HGCM82633A123456",
    make: "Honda",
    model: "Civic",
  });
  assert.equal(out, "27-040 VEHICLE LOOKUP VIN 1HGCM82633A123456 Honda Civic");
});

test("formatTen8VehicleLookupComment: failure path uppercases reason and replaces underscores with spaces", () => {
  // 'no_record' must NOT be left in machine form — dispatchers read this on
  // the screen.
  assert.equal(
    formatTen8VehicleLookupComment("27-040", {
      ok: false,
      plate: "8VWV621",
      state: "CA",
      reason: "no_record",
    }),
    "27-040 VEHICLE LOOKUP CA 8VWV621 NO RECORD",
  );
});

test("formatTen8VehicleLookupComment: failure path prefers message over generic 'no record'", () => {
  assert.equal(
    formatTen8VehicleLookupComment("27-040", {
      ok: false,
      plate: "8VWV621",
      state: "CA",
      message: "Out of credits",
    }),
    "27-040 VEHICLE LOOKUP CA 8VWV621 OUT OF CREDITS",
  );
});

test("formatTen8VehicleLookupComment: returns null when callsign is blank", () => {
  assert.equal(
    formatTen8VehicleLookupComment("", {
      ok: true,
      plate: "8VWV621",
      state: "CA",
      make: "Honda",
    }),
    null,
  );
  assert.equal(
    formatTen8VehicleLookupComment("   ", {
      ok: true,
      plate: "8VWV621",
    }),
    null,
  );
});

test("formatTen8VehicleLookupComment: success with no decoded fields skips the description segment", () => {
  // Common case: plate is valid but DMV record has no vehicle details.
  const out = formatTen8VehicleLookupComment("27-040", {
    ok: true,
    plate: "8VWV621",
    state: "CA",
  });
  assert.equal(out, "27-040 VEHICLE LOOKUP CA 8VWV621");
});

test("formatTen8VehicleLookupComment caps comment at 4000 characters", () => {
  const out = formatTen8VehicleLookupComment("27-040", {
    ok: true,
    plate: "ABC123",
    state: "CA",
    make: "x".repeat(5000),
  });
  assert.ok(out);
  assert.equal(out!.length, 4000);

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
