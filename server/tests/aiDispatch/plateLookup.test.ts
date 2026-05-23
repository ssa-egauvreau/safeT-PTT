/**
 * Tests for the pure helpers in `server/src/aiDispatch/plateLookup.ts`.
 *
 * These are the helpers that:
 *   - turn a PlateLookupResult into the on-air radio readback the officer
 *     actually hears (`buildPlateReadback`, `buildVinReadback`), and
 *   - track the 912 "plate request" window so the engine knows whether the
 *     next transmission is a plate readout from the unit
 *     (`notePendingPlateRequest` / `consumePendingPlateRequest`).
 *
 * Wrong readback wording = officer acts on the wrong vehicle info on a
 * felony stop. Wrong pending-window logic = engine either fires plate
 * lookups on unrelated traffic or never recognizes the plate when it
 * arrives.
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
  notePendingPlateRequest,
} from "../../src/aiDispatch/plateLookup.js";

// Each test uses a unique agency+unit pair so the process-global pendingPlate
// Map from a prior test cannot leak into later tests.
let UNIQ = 0;
function uniqAgency(): number {
  return 800_000 + Math.floor(Date.now() % 100_000) + UNIQ++;
}

// ---------- buildPlateReadback ------------------------------------------

test("buildPlateReadback: success path speaks unit, plate phonetically, and decoded vehicle", () => {
  const out = buildPlateReadback("27-205", {
    ok: true,
    plate: "ABC123",
    state: "CA",
    year: "2014",
    make: "Honda",
    model: "Civic",
    color: "White",
  });
  // callSignForReadback (platePhonetics): patrol (27-1XX..27-9XX) drops 27- prefix.
  assert.match(out, /^205, /, "patrol callsign drops the 27- prefix");
  assert.match(out, /California/, "state code is spoken as the full state name");
  assert.match(out, /alpha bravo charlie one two three/i, "plate is read NATO-phonetic");
  assert.match(out, /comes back to a White 2014 Honda Civic\.?$|White 2014 Honda Civic.+\.$/);
});

test("buildPlateReadback: success path appends 'last six of vin ...' when VIN is present", () => {
  const out = buildPlateReadback("27-205", {
    ok: true,
    plate: "ABC123",
    state: "CA",
    make: "Honda",
    model: "Civic",
    vin: "1HGCM82633A123456",
  });
  assert.match(out, /last six of vin/i);
  assert.match(out, /\.$/, "ends in a period for clean TTS phrasing");
});

test("buildPlateReadback: success but no decoded vehicle details still names the plate clearly", () => {
  const out = buildPlateReadback("27-205", {
    ok: true,
    plate: "ABC123",
    state: "CA",
  });
  assert.match(out, /no further details available/i);
  assert.match(out, /alpha bravo charlie one two three/i);
});

test("buildPlateReadback: no_record failure path explicitly says 'no record found' with the run plate", () => {
  const out = buildPlateReadback("27-205", {
    ok: false,
    plate: "ABC123",
    state: "CA",
    reason: "no_record",
  });
  assert.match(out, /no record found/i);
  assert.match(out, /alpha bravo charlie one two three/i);
});

test("buildPlateReadback: generic failure path says 'plate lookup unavailable, stand by'", () => {
  const out = buildPlateReadback("27-205", {
    ok: false,
    reason: "network_error",
    message: "Whatever",
  });
  assert.match(out, /plate lookup unavailable, stand by\.?$/i);
});

test("buildPlateReadback: command-staff callsign 27-020 KEEPS the 27- prefix on the air", () => {
  // 27-0XX (three-digit tail starting with 0) is command staff: keeps prefix.
  const out = buildPlateReadback("27-020", {
    ok: true,
    plate: "ABC123",
    state: "CA",
    make: "Honda",
  });
  assert.match(out, /^27-020, /);
});

test("buildPlateReadback: 27-040 (command-staff tail starts with 0) keeps the 27- prefix", () => {
  // Locks in the readback rule (different from dispatchAck's 27-0[0-3]0
  // rule). 27-040 here is COMMAND STAFF for plate readback purposes.
  const out = buildPlateReadback("27-040", {
    ok: true,
    plate: "ABC123",
    state: "CA",
    make: "Honda",
  });
  assert.match(out, /^27-040, /);
});

test("buildPlateReadback: empty/blank unitId is tolerated (no leading 'undefined,' prefix)", () => {
  const out = buildPlateReadback("", {
    ok: false,
    plate: "ABC123",
    state: "CA",
    reason: "no_record",
  });
  assert.equal(
    /^undefined/.test(out),
    false,
    "must not leak 'undefined' into the readback when unitId is empty",
  );
});

// ---------- buildVinReadback --------------------------------------------

test("buildVinReadback: success path speaks year/make/model", () => {
  const out = buildVinReadback("27-205", {
    ok: true,
    vin: "1HGCM82633A123456",
    year: "2014",
    make: "Honda",
    model: "Civic",
  });
  assert.equal(out, "205, vin comes back to a 2014 Honda Civic.");
});

test("buildVinReadback: success but no decoded fields falls back to 'vin comes back valid but vehicle details are unavailable'", () => {
  const out = buildVinReadback("27-205", { ok: true, vin: "1HGCM82633A123456" });
  assert.match(out, /vin comes back valid but vehicle details are unavailable\.?$/i);
});

test("buildVinReadback: no_record failure says 'vin lookup shows no record found'", () => {
  const out = buildVinReadback("27-205", {
    ok: false,
    vin: "1HGCM82633A123456",
    reason: "no_record",
  });
  assert.match(out, /vin lookup shows no record found\.?$/i);
});

test("buildVinReadback: invalid_vin failure asks for a 10-9", () => {
  // Officer mis-spoke the VIN — speak back '10-9' (repeat your last
  // transmission) instead of saying "no record" which would imply the
  // VIN was valid and unknown.
  const out = buildVinReadback("27-205", {
    ok: false,
    vin: "BADVIN",
    reason: "invalid_vin",
  });
  assert.match(out, /10-9/);
});

test("buildVinReadback: generic failure path says 'vin lookup unavailable, stand by'", () => {
  const out = buildVinReadback("27-205", {
    ok: false,
    vin: "1HGCM82633A123456",
    reason: "network_error",
  });
  assert.match(out, /vin lookup unavailable, stand by\.?$/i);
});

// ---------- pending 912 plate request window ----------------------------

test("consumePendingPlateRequest: returns false when no pending request was noted", () => {
  const agencyId = uniqAgency();
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), false);
});

test("notePending + consumePending: matches the first follow-up within the TTL window", () => {
  const agencyId = uniqAgency();
  notePendingPlateRequest(agencyId, "27-205");
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), true);
});

test("consumePendingPlateRequest is one-shot (a second consume after a hit returns false)", () => {
  // If we left the pending flag set, every later transmission from the unit
  // would be treated as a plate readout. Must be one-shot.
  const agencyId = uniqAgency();
  notePendingPlateRequest(agencyId, "27-205");
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), true);
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), false);
});

test("pending requests are isolated per (agencyId, unitId)", () => {
  const a = uniqAgency();
  const b = uniqAgency();
  notePendingPlateRequest(a, "27-205");
  assert.equal(consumePendingPlateRequest(b, "27-205"), false, "cross-agency leak");
  assert.equal(consumePendingPlateRequest(a, "27-205"), true);

  notePendingPlateRequest(a, "27-205");
  assert.equal(consumePendingPlateRequest(a, "27-352"), false, "cross-unit leak");
  assert.equal(consumePendingPlateRequest(a, "27-205"), true);
});

test("repeated notePendingPlateRequest refreshes the timestamp instead of stacking", () => {
  // A unit that asks for a plate twice in a row should still be one pending
  // (last-write wins).
  const agencyId = uniqAgency();
  notePendingPlateRequest(agencyId, "27-205");
  notePendingPlateRequest(agencyId, "27-205");
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), true);
  assert.equal(consumePendingPlateRequest(agencyId, "27-205"), false);
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
