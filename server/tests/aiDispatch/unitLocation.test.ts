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
  formatUnitIdForRadio,
  parseUnitLocationSubject,
  positionIsFresh,
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

// ---------- formatUnitIdForRadio ----------------------------------------
//
// `formatUnitIdForRadio` is the speech-side mirror of the prefix-strip rule
// used by buildDeterministicDispatchAck and buildInfoRequestAck. It feeds
// distress callouts ("All units 10-33, X needs assistance...") and unit
// 10-20 responses, where saying the wrong callsign is worse than saying
// nothing at all.

test("formatUnitIdForRadio: null / undefined / blank → 'unknown unit' (never empty / undefined)", () => {
  // The downstream callers concatenate this into a TTS line, so an empty
  // string would produce "All units 10-33,  needs assistance" — which the
  // dispatcher must never broadcast. Lock the fallback wording.
  assert.equal(formatUnitIdForRadio(null), "unknown unit");
  assert.equal(formatUnitIdForRadio(undefined), "unknown unit");
  assert.equal(formatUnitIdForRadio(""), "unknown unit");
  assert.equal(formatUnitIdForRadio("   "), "unknown unit");
});

test("formatUnitIdForRadio: command-staff 27-0[0-3]0 keep the 27- prefix on the air", () => {
  // 27-000 / 27-010 / 27-020 / 27-030 are SSA command staff and are
  // addressed with the full prefix on the radio.
  for (const cs of ["27-000", "27-010", "27-020", "27-030"]) {
    assert.equal(formatUnitIdForRadio(cs), cs);
  }
});

test("formatUnitIdForRadio: patrol callsigns drop the 27- prefix", () => {
  // 27-040, 27-205, 27-352 are line patrol units — radio voice is "040".
  assert.equal(formatUnitIdForRadio("27-040"), "040");
  assert.equal(formatUnitIdForRadio("27-205"), "205");
  assert.equal(formatUnitIdForRadio("27-352"), "352");
});

test("formatUnitIdForRadio: trims surrounding whitespace before the prefix check", () => {
  // The check is anchored — without trimming first, "  27-040  " would
  // skip the regex and land on the un-stripped fallback path.
  assert.equal(formatUnitIdForRadio("  27-040  "), "040");
  assert.equal(formatUnitIdForRadio("\t27-020\n"), "27-020");
});

test("formatUnitIdForRadio: non-27 prefixes pass through unchanged (no false strip)", () => {
  // ADAM-5, K-9, EXT-352 — only the 27- prefix is patrol convention.
  assert.equal(formatUnitIdForRadio("ADAM-5"), "ADAM-5");
  assert.equal(formatUnitIdForRadio("K-9"), "K-9");
  assert.equal(formatUnitIdForRadio("EXT-352"), "EXT-352");
});

// ---------- positionIsFresh --------------------------------------------
//
// `positionIsFresh` gates whether a 10-20 / 10-33 location lookup uses the
// stored GPS or refuses ("no recent GPS"). The threshold is 10 minutes —
// older than that and the unit may have moved out of range, so we'd be
// reading a stale position over the radio.

test("positionIsFresh: a position 'now' is fresh", () => {
  assert.equal(positionIsFresh(new Date().toISOString()), true);
});

test("positionIsFresh: a position from 1 minute ago is fresh", () => {
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  assert.equal(positionIsFresh(oneMinAgo), true);
});

test("positionIsFresh: a position older than 10 minutes is stale", () => {
  // 10 minutes is the documented POSITION_MAX_AGE_MS threshold. 11 minutes
  // ago must be stale; if a refactor flips the comparison sign or unit
  // (seconds vs ms), this test catches it.
  const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.equal(positionIsFresh(elevenMinAgo), false);
});

test("positionIsFresh: a position exactly at the 10-minute boundary is still fresh", () => {
  // Boundary contract: <= 10 minutes is fresh (Date.now - t <= 10*60*1000).
  // A regression that flips this to strict less-than would silently mark
  // every position arriving exactly on the cron tick as stale.
  const tenMinAgo = new Date(Date.now() - 10 * 60_000 + 100).toISOString();
  assert.equal(positionIsFresh(tenMinAgo), true);
});

test("positionIsFresh: an unparseable updatedAt is treated as stale (never freshly accepted)", () => {
  // Date.parse('not a date') is NaN. We must NOT treat NaN as recent — the
  // fallback is 'stale', so the radio lookup answers "no recent GPS"
  // instead of broadcasting a phantom address from lat 0,0.
  assert.equal(positionIsFresh("not a date"), false);
  assert.equal(positionIsFresh(""), false);
});

test("positionIsFresh: a future-dated position is still considered fresh (clock skew tolerance)", () => {
  // A position dated slightly in the future means the device clock is ahead
  // of the server's — common for handsets after a daylight-savings flip or
  // a freshly synced GPS. Date.now() - t becomes negative, which is <= the
  // threshold, so it stays fresh. Locking that contract so a future
  // refactor that adds Math.abs() doesn't accidentally start treating
  // future dates as stale (or, worse, throwing on a negative).
  const oneMinFuture = new Date(Date.now() + 60_000).toISOString();
  assert.equal(positionIsFresh(oneMinFuture), true);
});
