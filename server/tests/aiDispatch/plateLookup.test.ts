/**
 * Tests for `server/src/aiDispatch/plateLookup.ts`.
 *
 * Why this file matters: PR #93 (d5aa7e6) fixed a bug where a 961 with an
 * inline plate dispatched the call but never ran the plate or spoke the
 * result back to the unit. The plate / VIN format guards and the readback
 * builders are the pure-logic surface of that flow — a regression silently
 * skips a plate lookup or sends the wrong words on the air.
 *
 * We deliberately do NOT exercise the network paths (PlateToVin / auto.dev).
 * We test:
 *   - input validation guards that short-circuit BEFORE any fetch happens,
 *   - the deterministic readback string builders,
 *   - the 30s in-memory pending-plate cache (consumed exactly once).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlateReadback,
  buildVinReadback,
  consumePendingPlateRequest,
  lookupVin,
  notePendingPlateRequest,
  runPlateLookup,
  type PlateLookupResult,
} from "../../src/aiDispatch/plateLookup.js";

let UNIQ = 0;
function uniqAgency(): number {
  return 950_000 + Math.floor(Date.now() % 100_000) + UNIQ++;
}

test("lookupVin: rejects malformed VINs before any network call", async () => {
  for (const bad of ["", "ABCDEFGHJKLM", "1HGBH41JXMN10918", "1HGBH41JXMN109186I"]) {
    // Length must be exactly 17; I/O/Q are not allowed in a real VIN.
    const result = await lookupVin(uniqAgency(), bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_vin", `expected invalid_vin for "${bad}"`);
  }
});

test("lookupVin: a VIN containing I, O, or Q is rejected before network", async () => {
  // 17 chars including a forbidden 'I' — must short-circuit, not be tried against auto.dev.
  const result = await lookupVin(uniqAgency(), "1HGBH4IJXMN109186");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_vin");
});

test("lookupVin: cleans whitespace and dashes, uppercases the VIN it echoes back", async () => {
  // Still invalid (length wrong), but we want to confirm the echoed `vin` is normalized.
  const result = await lookupVin(uniqAgency(), "  1hg-bh41 jxmn  ");
  assert.equal(result.ok, false);
  assert.equal(result.vin, "1HGBH41JXMN");
});

test("runPlateLookup: rejects empty or too-long plates before network", async () => {
  for (const bad of ["", "A", "TOOLONGPLATE!"]) {
    const result = await runPlateLookup(uniqAgency(), bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_plate", `expected invalid_plate for "${bad}"`);
  }
});

test("runPlateLookup: echoes the uppercased plate on the invalid_plate response", async () => {
  const result = await runPlateLookup(uniqAgency(), "abc!23");
  assert.equal(result.ok, false);
  assert.equal(result.plate, "ABC!23");
});

test("buildPlateReadback: success uses NATO phonetic + spelled-out state and vehicle", () => {
  const lookup: PlateLookupResult = {
    ok: true,
    plate: "8VWV621",
    state: "CA",
    year: "2021",
    make: "Honda",
    model: "Civic",
    color: "Silver",
    vin: "1HGBH41JXMN109186",
  };
  // 27-2009 is a patrol unit: the 27- prefix should be dropped on the air.
  const out = buildPlateReadback("27-2009", lookup);
  assert.match(out, /^2009, /);
  assert.match(out, /California plate/);
  assert.match(out, /eight Victor Whiskey Victor six two one/);
  assert.match(out, /Silver 2021 Honda Civic/);
  assert.match(out, /last six of vin/);
});

test("buildPlateReadback: command-staff unit (27-0XX) keeps the 27- prefix", () => {
  const lookup: PlateLookupResult = {
    ok: true,
    plate: "ABC123",
    state: "CA",
    year: "2020",
    make: "Ford",
    model: "F-150",
  };
  // 27-040 has a three-digit tail starting with 0 → command staff.
  const out = buildPlateReadback("27-040", lookup);
  assert.match(out, /^27-040, /);
});

test("buildPlateReadback: no_record reason includes the plate the unit ran", () => {
  const out = buildPlateReadback("27-2009", {
    ok: false,
    plate: "8VWV621",
    state: "CA",
    reason: "no_record",
  });
  assert.match(out, /no record found/);
  assert.match(out, /eight Victor Whiskey Victor/);
});

test("buildPlateReadback: any other failure says 'unavailable, stand by'", () => {
  for (const reason of ["api_error", "network_error", "auth_error", "insufficient_credit"]) {
    const out = buildPlateReadback("27-2009", { ok: false, reason });
    assert.match(out, /unavailable, stand by/);
  }
});

test("buildPlateReadback: success with no vehicle details says 'no further details'", () => {
  const out = buildPlateReadback("27-2009", {
    ok: true,
    plate: "ABC123",
    state: "CA",
  });
  assert.match(out, /no further details available/);
});

test("buildVinReadback: success speaks year/make/model", () => {
  const out = buildVinReadback("27-2009", {
    ok: true,
    vin: "1HGBH41JXMN109186",
    year: "2020",
    make: "Honda",
    model: "Accord",
  });
  assert.match(out, /^2009, vin comes back to a 2020 Honda Accord\./);
});

test("buildVinReadback: ok=true but no fields → 'unavailable details' phrasing", () => {
  const out = buildVinReadback("27-2009", { ok: true, vin: "1HGBH41JXMN109186" });
  assert.match(out, /vehicle details are unavailable/);
});

test("buildVinReadback: invalid_vin asks the unit to 10-9", () => {
  const out = buildVinReadback("27-2009", { ok: false, reason: "invalid_vin" });
  assert.match(out, /negative on that vin/);
  assert.match(out, /10-9 the transmission/);
});

test("buildVinReadback: no_record vs other errors", () => {
  assert.match(
    buildVinReadback("27-2009", { ok: false, reason: "no_record" }),
    /no record found/,
  );
  for (const reason of ["api_error", "network_error", "auth_error"]) {
    assert.match(
      buildVinReadback("27-2009", { ok: false, reason }),
      /unavailable, stand by/,
    );
  }
});

test("pending plate cache: consume returns true once, then false", () => {
  const agencyId = uniqAgency();
  const unit = "27-040";
  notePendingPlateRequest(agencyId, unit);
  assert.equal(consumePendingPlateRequest(agencyId, unit), true);
  assert.equal(
    consumePendingPlateRequest(agencyId, unit),
    false,
    "second consume must be a no-op (idempotent)",
  );
});

test("pending plate cache: untouched key returns false", () => {
  assert.equal(consumePendingPlateRequest(uniqAgency(), "27-040"), false);
});

test("pending plate cache: keys are agency+unit scoped", () => {
  const a = uniqAgency();
  const b = uniqAgency();
  notePendingPlateRequest(a, "27-040");
  // Same unit on a different agency must not satisfy the request.
  assert.equal(consumePendingPlateRequest(b, "27-040"), false);
  // Same agency, different unit must not satisfy either.
  assert.equal(consumePendingPlateRequest(a, "27-041"), false);
  // Original key still consumable.
  assert.equal(consumePendingPlateRequest(a, "27-040"), true);
});
