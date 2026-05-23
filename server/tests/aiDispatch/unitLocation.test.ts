/**
 * Tests for the pure helpers in `server/src/aiDispatch/unitLocation.ts`.
 *
 * `parseUnitLocationSubject` parses the LLM's info_request.subject for a
 * 10-20 (location) request and decides:
 *   - which unit to look up, and
 *   - whether the officer asked for the full street address ("street
 *     address", "full address") vs a short cross-street / POI line.
 *
 * `findRadioMapPosition` looks the unit up in the live position list with
 * the same normalization rules the rest of the engine uses (drop the 27-
 * prefix, drop leading zeros). A regression here returns a stale or wrong
 * unit's GPS — officer would be told another unit's position.
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

function makePos(unit_id: string, over: Partial<RadioPosition> = {}): RadioPosition {
  return {
    unit_id,
    lat: 33.7,
    lon: -117.9,
    updated_at: new Date().toISOString(),
    ...(over as object),
  } as RadioPosition;
}

// ---------- parseUnitLocationSubject ------------------------------------

test("parseUnitLocationSubject returns null on blank / missing subject", () => {
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

test("parseUnitLocationSubject extracts a 3-5 digit unit number", () => {
  assert.deepEqual(parseUnitLocationSubject("2009"), {
    targetUnit: "2009",
    wantFullAddress: false,
  });
  assert.deepEqual(parseUnitLocationSubject("unit 352"), {
    targetUnit: "352",
    wantFullAddress: false,
  });
});

test("parseUnitLocationSubject also keeps a leading 27- prefix when present", () => {
  assert.deepEqual(parseUnitLocationSubject("27-352"), {
    targetUnit: "27-352",
    wantFullAddress: false,
  });
});

test("parseUnitLocationSubject sets wantFullAddress=true on 'full address' / 'street address' phrasing", () => {
  for (const subject of [
    "unit 2009 full address",
    "2009 full street address",
    "what's the street address of 2009",
  ]) {
    const parsed = parseUnitLocationSubject(subject);
    assert.equal(parsed?.wantFullAddress, true, subject);
    assert.equal(parsed?.targetUnit, "2009", subject);
  }
});

test("parseUnitLocationSubject strips conversational fluff before matching the unit number", () => {
  // The helper strips '10-20', 'location', 'where is' before the digit
  // extraction, so all of these resolve to the bare unit number.
  for (const subject of [
    "10-20 on 2009",
    "where is 2009",
    "location of unit 2009",
    "where are 2009",
  ]) {
    assert.equal(
      parseUnitLocationSubject(subject)?.targetUnit,
      "2009",
      subject,
    );
  }
});

// ---------- findRadioMapPosition ----------------------------------------

test("findRadioMapPosition: exact match wins", () => {
  const positions = [makePos("27-352"), makePos("27-040")];
  const hit = findRadioMapPosition(positions, "27-352");
  assert.equal(hit?.unit_id, "27-352");
});

test("findRadioMapPosition: matches after dropping the 27- prefix and leading zeros on both sides", () => {
  // Position list stores '27-040'; caller asks for '40' — must still find it.
  const positions = [makePos("27-040")];
  assert.equal(findRadioMapPosition(positions, "40")?.unit_id, "27-040");
  assert.equal(findRadioMapPosition(positions, "040")?.unit_id, "27-040");
  assert.equal(findRadioMapPosition(positions, "27-040")?.unit_id, "27-040");
});

test("findRadioMapPosition: falls back to suffix-match when neither side matches exactly after normalization", () => {
  // Some agencies report 'EXT-352' while CAD has 'unit 352'. The suffix
  // fallback is what allows that to resolve.
  const positions = [makePos("ext-352")];
  assert.equal(findRadioMapPosition(positions, "352")?.unit_id, "ext-352");
});

test("findRadioMapPosition: returns null when nothing matches", () => {
  const positions = [makePos("27-352"), makePos("27-040")];
  assert.equal(findRadioMapPosition(positions, "999"), null);
});

test("findRadioMapPosition: empty position list returns null without crashing", () => {
  assert.equal(findRadioMapPosition([], "352"), null);
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
