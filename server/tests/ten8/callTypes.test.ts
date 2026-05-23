/**
 * Regression tests for `server/src/ten8/callTypes.ts` and the
 * `cadCallTypes.json` data file behind it.
 *
 * The b50b3f7 fix ("10-8 call types: match exact agency-approved strings from
 * admin export") was caused by a whitespace mismatch: the agency-approved list
 * has a quirky double space between the code and the dash for `459-A` and
 * `905-B`, and 10-8 rejects on close if our string is "almost identical". So
 * the data file is part of the contract — these tests make that explicit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  TEN8_DEFAULT_INCIDENT_TYPE,
  clampPriority,
  listTen8IncidentTypes,
  lookupCadCallType,
  resolveTen8IncidentType,
  resolveTen8PriorityForCode,
} from "../../src/ten8/callTypes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL_TYPES_JSON = join(HERE, "..", "..", "src", "ten8", "data", "cadCallTypes.json");

type Row = { shortcut: string; type: string; priority: number };

function loadRows(): Row[] {
  return JSON.parse(readFileSync(CALL_TYPES_JSON, "utf8")) as Row[];
}

test("lookupCadCallType returns the row for a known shortcut (case-insensitive)", () => {
  const r1 = lookupCadCallType("459");
  assert.equal(r1?.type, "459 - Burglary in Progress");
  assert.equal(r1?.priority, 1);

  const r2 = lookupCadCallType("459A");
  assert.ok(r2, "459A should resolve");
  assert.equal(r2?.shortcut.toLowerCase(), "459a");
});

test("lookupCadCallType returns null for an unknown shortcut", () => {
  assert.equal(lookupCadCallType("definitely-not-a-code"), null);
});

test("lookupCadCallType falls back to 'pc' (Patrol Check) when no shortcut is supplied", () => {
  const r = lookupCadCallType("");
  assert.ok(r, "should resolve to patrol-check default");
  assert.equal(r?.type, TEN8_DEFAULT_INCIDENT_TYPE);
});

test("resolveTen8IncidentType maps shortcut to the exact 10-8 `type` string", () => {
  assert.equal(resolveTen8IncidentType("459"), "459 - Burglary in Progress");
  assert.equal(resolveTen8IncidentType("c7"), "Code 7- Lunch"); // no space after "7-" by design
  assert.equal(resolveTen8IncidentType("pc"), "Patrol Check");
});

test("resolveTen8IncidentType prefers the agency's known-types list when given (case match)", () => {
  // If 10-8's webhook tells us the agency-approved string uses a different
  // case, return that verbatim so the create call matches on the server side.
  const got = resolveTen8IncidentType("459", {
    knownTypes: ["459 - BURGLARY IN PROGRESS", "Patrol Check"],
  });
  assert.equal(got, "459 - BURGLARY IN PROGRESS");
});

test("resolveTen8IncidentType falls back to the bundled type when knownTypes does not match", () => {
  const got = resolveTen8IncidentType("459", {
    knownTypes: ["something-else"],
  });
  assert.equal(got, "459 - Burglary in Progress");
});

test("resolveTen8IncidentType returns the default 'Patrol Check' for an unknown shortcut", () => {
  // We intentionally swallow the console.warn here — the value matters, not the log.
  const got = resolveTen8IncidentType("zzz-not-a-thing");
  assert.equal(got, TEN8_DEFAULT_INCIDENT_TYPE);
});

test("resolveTen8PriorityForCode reads the per-type priority from the CAD table", () => {
  assert.equal(resolveTen8PriorityForCode("187"), 1); // murder
  assert.equal(resolveTen8PriorityForCode("459"), 1); // burglary in progress
  assert.equal(resolveTen8PriorityForCode("484"), 3); // theft
  assert.equal(resolveTen8PriorityForCode("pc"), 4); // patrol check
});

test("resolveTen8PriorityForCode forces priority 1 for emergency intent", () => {
  // Officer-down / 10-33 takes priority 1 regardless of the underlying call type.
  assert.equal(resolveTen8PriorityForCode("c7", "emergency"), 1);
  assert.equal(resolveTen8PriorityForCode(null, "emergency"), 1);
});

test("resolveTen8PriorityForCode falls back to priority 4 for unknown codes", () => {
  assert.equal(resolveTen8PriorityForCode("definitely-not-real"), 4);
  assert.equal(resolveTen8PriorityForCode(null), 4);
  assert.equal(resolveTen8PriorityForCode(undefined), 4);
});

test("clampPriority enforces the 10-8 1..4 contract", () => {
  assert.equal(clampPriority(1), 1);
  assert.equal(clampPriority(4), 4);
  assert.equal(clampPriority(0), 4); // 10-8 has no priority 0
  assert.equal(clampPriority(-3), 4);
  assert.equal(clampPriority(99), 4);
  assert.equal(clampPriority(2.4), 2); // rounds
  assert.equal(clampPriority(2.6), 3);
  assert.equal(clampPriority("3"), 3);
  assert.equal(clampPriority("garbage"), 4);
  assert.equal(clampPriority(null), 4);
  assert.equal(clampPriority(undefined), 4);
});

test("clampPriority honors caller-supplied fallback", () => {
  assert.equal(clampPriority(null, 2), 2);
  assert.equal(clampPriority("garbage", 1), 1);
});

test("listTen8IncidentTypes returns every type string from the bundled CAD table", () => {
  const all = listTen8IncidentTypes();
  const rows = loadRows();
  assert.equal(all.length, rows.length);
  for (const row of rows) {
    assert.ok(all.includes(row.type), `missing ${row.type}`);
  }
});

// -------- data integrity for cadCallTypes.json -----------------------------

test("cadCallTypes.json: every row has a non-empty shortcut + type and a valid 1..4 priority", () => {
  for (const row of loadRows()) {
    assert.ok(row.shortcut.trim(), `shortcut empty for ${JSON.stringify(row)}`);
    assert.ok(row.type.trim(), `type empty for ${JSON.stringify(row)}`);
    assert.ok(
      Number.isInteger(row.priority) && row.priority >= 1 && row.priority <= 4,
      `priority out of range for ${JSON.stringify(row)}`,
    );
  }
});

test("cadCallTypes.json: shortcuts are unique (case-insensitive)", () => {
  // The CallTypes loader lowercases shortcuts into a Map, so a casing-only dup
  // silently overrides the earlier row. Catch that here to keep the dictionary
  // honest. (We allow exact lower/upper pairs that map to the SAME type+priority,
  // which is how 907a / 907A are intentionally listed together.)
  const seen = new Map<string, Row>();
  for (const row of loadRows()) {
    const key = row.shortcut.toLowerCase();
    const prior = seen.get(key);
    if (prior) {
      assert.equal(
        prior.type,
        row.type,
        `duplicate shortcut "${key}" with conflicting types: "${prior.type}" vs "${row.type}"`,
      );
      assert.equal(
        prior.priority,
        row.priority,
        `duplicate shortcut "${key}" with conflicting priorities: ${prior.priority} vs ${row.priority}`,
      );
    } else {
      seen.set(key, row);
    }
  }
});

test("cadCallTypes.json: 459-A and 905-B keep their agency-approved DOUBLE space (b50b3f7 regression)", () => {
  // 10-8 string-matches on close. The agency-approved export lists these with
  // a quirky double space between the code and the dash. The b50b3f7 fix
  // rebuilt the JSON from the export specifically so this exact spacing is
  // preserved — normalizing to a single space causes close to reject the
  // incident with "you must select a valid, agency-approved call type".
  const rows = loadRows();

  const r459a = rows.find((r) => r.shortcut === "459a");
  assert.ok(r459a, "459a row exists");
  assert.equal(r459a?.type, "459-A  - Burglary Alarm (Audible)");
  assert.ok(r459a?.type.includes("  -"), "459-A must have DOUBLE space before the dash");

  const r905b = rows.find((r) => r.shortcut === "905b");
  assert.ok(r905b, "905b row exists");
  assert.equal(r905b?.type, "905-B  - Animal Bite");
  assert.ok(r905b?.type.includes("  -"), "905-B must have DOUBLE space before the dash");
});

test("cadCallTypes.json: agency-quirk strings that look like typos are preserved verbatim", () => {
  // Per b50b3f7 the following are NOT our typos — they match 10-8's config and
  // collapsing the whitespace would break string-match on close.
  const types = listTen8IncidentTypes();
  assert.ok(types.includes("Code 5 - Steakout"), "Code 5 - Steakout preserved");
  assert.ok(types.includes("Code 7- Lunch"), "Code 7- Lunch preserved (no space after dash)");
  assert.ok(types.includes("930- See the Man"), "930- See the Man preserved");
  assert.ok(types.includes("925 - Suspicious Person/ Circumstances"), "925 quirky slash preserved");
});

test("cadCallTypes.json: 907a/A and 907b/B aliases survive (AI-side aliases)", () => {
  // The AI dispatch system prompt can emit either case, so both must round-trip.
  assert.equal(resolveTen8IncidentType("907a"), "Patrol Check");
  assert.equal(resolveTen8IncidentType("907A"), "Patrol Check");
  assert.equal(resolveTen8IncidentType("907b"), "911-B - Contact Officer");
  assert.equal(resolveTen8IncidentType("907B"), "911-B - Contact Officer");
});
