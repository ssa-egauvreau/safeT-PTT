import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlateCadLeadReadback,
  buildPlateCombinedReadback,
  buildPlateDmvTailReadback,
  cadMissingDmvVehicleFields,
} from "../../src/aiDispatch/plateLookup.js";
import type { CadPlateLookupHit } from "../../src/ten8/cadRadioLookup.js";
import { buildStaleUnassignedCallout } from "../../src/aiDispatch/dispatchWatchdog.js";
import { buildTen8AddVehicleBodyCombined } from "../../src/ten8/vehicles.js";
import { incidentHasAssignedUnits } from "../../src/aiDispatch/infoRequest.js";

test("buildPlateCadLeadReadback: NO MAKE when 10-8 has no vehicle record", () => {
  const out = buildPlateCadLeadReadback("27-205", "8VWV621", "CA", {
    found: false,
    vehicleSummary: null,
    stateOnFile: null,
    historyLine: null,
  });
  assert.match(out, /comes back NO MAKE/i);
  assert.match(out, /victor whiskey victor/i);
});

test("buildPlateCadLeadReadback: includes 10-8 vehicle and history when on file", () => {
  const cad: CadPlateLookupHit = {
    found: true,
    vehicleSummary: "2018 white Honda Civic",
    stateOnFile: "CA",
    historyLine: "CA on file; 961 3/15/24 call 25-0100",
  };
  const out = buildPlateCadLeadReadback("27-205", "8VWV621", "CA", cad);
  assert.match(out, /comes back 2018 white Honda Civic/i);
  assert.match(out, /CA on file/i);
});

test("buildPlateDmvTailReadback: DMV API down speaks license plate system is down", () => {
  const tail = buildPlateDmvTailReadback(
    "27-205",
    { ok: false, plate: "8VWV621", state: "CA", reason: "network_error" },
    { found: false, vehicleSummary: null, stateOnFile: null, historyLine: null },
  );
  assert.match(tail!, /license plate system is down right now/i);
});

test("buildPlateDmvTailReadback: NO MAKE path gets DMV year make model and vin last six", () => {
  const tail = buildPlateDmvTailReadback(
    "27-205",
    {
      ok: true,
      plate: "8VWV621",
      state: "CA",
      year: "2018",
      make: "Honda",
      model: "Civic",
      vin: "1HGCM82633A123456",
    },
    { found: false, vehicleSummary: null, stateOnFile: null, historyLine: null },
  );
  assert.match(tail!, /to a 2018 Honda Civic/i);
  assert.match(tail!, /last six of the vin/i);
});

test("cadMissingDmvVehicleFields detects missing make on CAD hit", () => {
  assert.equal(
    cadMissingDmvVehicleFields(
      { found: true, vehicleSummary: "2018 white Honda", stateOnFile: "CA", historyLine: null },
      { ok: true, make: "Toyota", model: "Camry", year: "2019" },
    ),
    true,
  );
});

test("buildTen8AddVehicleBodyCombined uses plate from parse when DMV lookup failed", () => {
  const body = buildTen8AddVehicleBodyCombined(
    { plate: "8VWV621", state: "CA", vin: null },
    { ok: false, plate: "8VWV621", state: "CA", reason: "no_record" },
  );
  assert.equal(body?.vehicle.license, "8VWV621");
  assert.equal(body?.vehicle.state, "CA");
});

test("buildStaleUnassignedCallout names priority and pending time", () => {
  const line = buildStaleUnassignedCallout("25-0129", "961 - Car Stop", "1806 N Batavia St, Orange, CA", 1, 3);
  assert.match(line, /unassigned priority 1/i);
  assert.match(line, /961/i);
  assert.match(line, /3 minutes/i);
});

test("incidentHasAssignedUnits is false with empty units array", () => {
  assert.equal(
    incidentHasAssignedUnits({
      payload: { incident: { units: [] } },
    }),
    false,
  );
});

test("incidentHasAssignedUnits is true when a unit is listed", () => {
  assert.equal(
    incidentHasAssignedUnits({
      payload: { incident: { units: [{ unit: "352" }] } },
    }),
    true,
  );
});

test("buildPlateCombinedReadback: NO MAKE + DMV return is one fluid line, single call sign", () => {
  const cad: CadPlateLookupHit = {
    found: false,
    vehicleSummary: null,
    stateOnFile: null,
    historyLine: null,
  };
  const dmv = {
    ok: true as const,
    plate: "8VWV621",
    state: "CA",
    color: "blue",
    year: "2018",
    make: "Honda",
    model: "Civic",
    vin: "1HGBH41JXMN109186",
  };
  const out = buildPlateCombinedReadback("27-205", "8VWV621", "CA", cad, dmv);
  // One transmission: NO MAKE lead AND the DMV/vin tail in the same string.
  assert.match(out, /comes back NO MAKE/i);
  assert.match(out, /vin/i);
  // Call sign appears exactly once (no repeated prefix from the old 2nd transmission).
  // callSignForReadback shortens "27-205" → "205".
  const callSignHits = (out.match(/\b205\b/g) ?? []).length;
  assert.equal(callSignHits, 1, `call sign should appear once, got ${callSignHits}: ${out}`);
});

test("buildPlateCombinedReadback: 10-8 hit + DMV confirm reads as one line", () => {
  const cad: CadPlateLookupHit = {
    found: true,
    vehicleSummary: "2018 white Honda Civic",
    stateOnFile: "CA",
    historyLine: "CA on file; 961 3/15/24 call 25-0100",
  };
  const dmv = {
    ok: true as const,
    plate: "8VWV621",
    state: "CA",
    color: "white",
    year: "2018",
    make: "Honda",
    model: "Civic",
    vin: "1HGBH41JXMN109186",
  };
  const out = buildPlateCombinedReadback("27-205", "8VWV621", "CA", cad, dmv);
  assert.match(out, /2018 white Honda Civic/i);
  assert.match(out, /CA on file/i);
  assert.match(out, /vin/i);
});
