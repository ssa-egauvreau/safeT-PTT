/**
 * Tests for `server/src/aiDispatch/unitLocation.ts`.
 *
 * `parseUnitLocationSubject` is how AI-dispatch turns the dispatcher's
 * `info_request.subject` into "which unit do they want a 10-20 on, and do
 * they want the full street address or just the natural answer". A bug here
 * causes the dispatcher to either pick the wrong unit or strip the unit
 * number entirely and answer "I don't have a location for that unit."
 *
 * `findRadioMapPosition` is the unit-id matcher used to resolve a query
 * against the GPS positions table. It must tolerate the 27-XXXX vs XXXX
 * naming, leading zeros, and short/long forms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findRadioMapPosition,
  parseUnitLocationSubject,
} from "../../src/aiDispatch/unitLocation.js";
import type { RadioPosition } from "../../src/store.js";

function pos(unit_id: string): RadioPosition {
  return {
    unit_id,
    user_id: null,
    display_name: null,
    channel_name: null,
    lat: 33.7,
    lon: -117.8,
    accuracy_m: null,
    heading: null,
    speed_mps: null,
    device_type: null,
    updated_at: new Date().toISOString(),
  };
}

test("parseUnitLocationSubject: null / empty / whitespace → null", () => {
  assert.equal(parseUnitLocationSubject(null), null);
  assert.equal(parseUnitLocationSubject(""), null);
  assert.equal(parseUnitLocationSubject("   "), null);
});

test("parseUnitLocationSubject: bare unit number returns the number", () => {
  const got = parseUnitLocationSubject("2009");
  assert.deepEqual(got, { targetUnit: "2009", wantFullAddress: false });
});

test('parseUnitLocationSubject: strips "10-20" / "location" / "where is" phrasing', () => {
  for (const subject of [
    "10-20 unit 2009",
    "location of 2009",
    "where is 2009",
    "where are unit 2009",
    "unit 2009 location",
  ]) {
    const got = parseUnitLocationSubject(subject);
    assert.equal(got?.targetUnit, "2009", `subject "${subject}"`);
    assert.equal(got?.wantFullAddress, false);
  }
});

test('parseUnitLocationSubject: "full address" / "street address" flips wantFullAddress', () => {
  const a = parseUnitLocationSubject("unit 2009 full address");
  assert.equal(a?.targetUnit, "2009");
  assert.equal(a?.wantFullAddress, true);

  const b = parseUnitLocationSubject("unit 2009 street address");
  assert.equal(b?.targetUnit, "2009");
  assert.equal(b?.wantFullAddress, true);

  const c = parseUnitLocationSubject("unit 2009 full street address");
  assert.equal(c?.targetUnit, "2009");
  assert.equal(c?.wantFullAddress, true);
});

test("parseUnitLocationSubject: keeps the 27- prefix on command-staff style ids", () => {
  const got = parseUnitLocationSubject("10-20 27-040");
  assert.equal(got?.targetUnit, "27-040");
  assert.equal(got?.wantFullAddress, false);
});

test("parseUnitLocationSubject: too-short numeric subject is rejected (avoid '0' false positives)", () => {
  // After stripping noise, residual "1" is too short — must not be treated as a unit.
  assert.equal(parseUnitLocationSubject("location 1"), null);
});

test("findRadioMapPosition: exact match wins", () => {
  const ps = [pos("2009"), pos("2010")];
  assert.equal(findRadioMapPosition(ps, "2009")?.unit_id, "2009");
});

test("findRadioMapPosition: matches 27-2009 against a 2009 position (and vice versa)", () => {
  const ps = [pos("2009")];
  assert.equal(findRadioMapPosition(ps, "27-2009")?.unit_id, "2009");

  const ps2 = [pos("27-2009")];
  assert.equal(findRadioMapPosition(ps2, "2009")?.unit_id, "27-2009");
});

test("findRadioMapPosition: tolerates leading zeros", () => {
  const ps = [pos("0040")];
  assert.equal(findRadioMapPosition(ps, "40")?.unit_id, "0040");

  const ps2 = [pos("40")];
  assert.equal(findRadioMapPosition(ps2, "0040")?.unit_id, "40");
});

test("findRadioMapPosition: returns null when no unit matches", () => {
  assert.equal(findRadioMapPosition([pos("2009"), pos("2010")], "9999"), null);
  assert.equal(findRadioMapPosition([], "2009"), null);
});

test("findRadioMapPosition: suffix match catches partial radio numbers", () => {
  // Dispatcher said '40' but the unit is '27-2040' on the map → still found
  // by the endsWith fall-through (normalized "2040" endsWith "40").
  const ps = [pos("27-2040")];
  assert.equal(findRadioMapPosition(ps, "40")?.unit_id, "27-2040");
});
