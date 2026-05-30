import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCadPersonLinkBody,
  buildCadPersonSearchParams,
  buildCadVehicleSearchParams,
  mapTen8ApiIncident,
} from "../../src/ten8/cadRadioLookup.js";

test("buildCadPersonSearchParams: fuzzy q plus optional DOB", () => {
  const p = buildCadPersonSearchParams("John Smith DOB 01/15/1990");
  assert.equal(p.q, "John Smith");
  assert.equal(p.dob, "01/15/1990");
  assert.equal(p.limit, 5);
});

test("buildCadVehicleSearchParams: extracts license plate", () => {
  const p = buildCadVehicleSearchParams("run CA plate 8ABC123");
  assert.equal(p.license, "8ABC123");
  assert.equal(p.state, "CA");
});

test("buildCadVehicleSearchParams: extracts VIN when present", () => {
  const p = buildCadVehicleSearchParams("VIN 1HGBH41JXMN109186");
  assert.equal(p.vin, "1HGBH41JXMN109186");
});

test("mapTen8ApiIncident: maps API incident to radio list shape", () => {
  const mapped = mapTen8ApiIncident({
    id: 99,
    incident_id: "26-2223",
    type: "415 - Disturbing the Peace",
    status: "open",
    location: "123 Main St, Anaheim, CA 92805",
    comments: [{ comment: "RP reports loud party" }],
    units: [{ unit: "352" }],
  });
  assert.equal(mapped.call_id, "26-2223");
  assert.equal(mapped.incident_type, "415 - Disturbing the Peace");
  assert.equal(mapped.status, "open");
  assert.ok(mapped.location?.includes("Anaheim"));
});

test("buildCadPersonLinkBody: nests person fields for POST persons", () => {
  const body = buildCadPersonLinkBody({
    relation: "suspect",
    first_name: "John",
    last_name: "Smith",
    dob: "01/01/1990",
    notes: "M/W 6FT",
  });
  assert.equal(body.relation, "suspect");
  assert.deepEqual(body.person, {
    firstName: "John",
    lastName: "Smith",
    dob: "01/01/1990",
  });
  assert.equal(body.notes, "M/W 6FT");
});
