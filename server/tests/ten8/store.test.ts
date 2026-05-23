/**
 * Regression tests for `server/src/ten8/store.ts`.
 *
 * The AI dispatcher writes a "seed" row into `ten8_incidents` the moment it
 * triggers a new call, so subsequent radio traffic on that call has somewhere
 * to land while we wait for the real 10-8 webhook to confirm the incident.
 *
 * Commit 5a65ae0 ("Expire stale AI-seeded 10-8 incidents") added a 15-minute
 * age cap to {@link buildListTen8ActiveIncidentsQuery} so that if the real
 * webhook never lands, the seed row stops being treated as an active call.
 * Without that filter, the dispatcher would keep dedup-matching new traffic
 * against an indefinitely stale "ghost" call.
 *
 * These tests pin the SQL/parameter shape rather than spinning up Postgres so
 * the regression guard is fast and deterministic. They specifically guard
 * against three quiet failure modes:
 *
 *   1. The `seeded_by` filter literal getting renamed on one side but not the
 *      other (writer is in {@link "../../src/aiDispatch/engine.ts"}). A drift
 *      here either lets every seed linger forever or starts expiring real
 *      CAD-sourced rows.
 *   2. The 15-minute age cap getting bumped (or dropped to 0) by accident.
 *   3. The `is_closed = FALSE` constraint getting weakened so closed calls
 *      bleed back into the active list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_DISPATCH_SEED_MAX_AGE_MINUTES,
  AI_DISPATCH_SEED_PAYLOAD_KEY,
  AI_DISPATCH_SEED_PAYLOAD_VALUE,
  AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS,
  buildListTen8ActiveIncidentsQuery,
  shouldTreatTen8IncidentAsActive,
} from "../../src/ten8/store.js";

test("AI_DISPATCH_SEED_MAX_AGE_MINUTES is the 15-minute cap commit 5a65ae0 introduced", () => {
  // The exact value matters because the comment in engine.ts/store.ts and the
  // operational behavior ("if the webhook never lands, the seed stops matching
  // after ~15 minutes") assume this number. Anything <= 0 would expire seeds
  // instantly (and break dedup of fresh radio traffic against the AI-created
  // call); anything excessively large defeats the purpose of expiring at all.
  assert.equal(AI_DISPATCH_SEED_MAX_AGE_MINUTES, 15);
});

test("AI dispatch seed payload marker matches the writer side (engine.ts)", () => {
  // The writer in engine.ts hardcodes `seeded_by: "ai_dispatch_create"` into
  // the payload it persists. If that string drifts on either side, the filter
  // either matches nothing (every seed lingers forever) or matches everything
  // (real CAD rows get expired). These constants are the contract.
  assert.equal(AI_DISPATCH_SEED_PAYLOAD_KEY, "seeded_by");
  assert.equal(AI_DISPATCH_SEED_PAYLOAD_VALUE, "ai_dispatch_create");
});

test("buildListTen8ActiveIncidentsQuery binds the agency id as $1 and the age cap as $2", () => {
  const q = buildListTen8ActiveIncidentsQuery(42);
  assert.deepEqual(q.values, [42, AI_DISPATCH_SEED_MAX_AGE_MINUTES]);
  assert.equal(q.values[1], 15);
});

test("buildListTen8ActiveIncidentsQuery filters by agency_id and is_closed = FALSE", () => {
  const q = buildListTen8ActiveIncidentsQuery(1);
  // Whitespace-insensitive substring checks — the regression risk is in the
  // logic, not in formatting.
  assert.match(q.text, /WHERE\s+agency_id\s*=\s*\$1/i);
  assert.match(q.text, /AND\s+is_closed\s*=\s*FALSE/i);
});

test("buildListTen8ActiveIncidentsQuery includes the AI-seed stale-row filter", () => {
  const q = buildListTen8ActiveIncidentsQuery(1);

  // 1. The filter references the exact payload key/value pair the writer puts
  //    on AI-created rows, so it only narrows to those rows. The `payload->>K`
  //    extraction may be wrapped in COALESCE(..., '') for NULL safety (eaf6a80),
  //    so the test accepts either bare or COALESCE-wrapped form.
  assert.match(
    q.text,
    /payload->>'seeded_by'[\s\S]{0,30}=\s*'ai_dispatch_create'/,
    "stale-row filter must key off the same payload marker engine.ts writes",
  );

  // 2. The filter compares updated_at against `now() - ($2::int * interval '1 minute')`
  //    — i.e., the cap is parameter-driven (so a constant rename can't silently
  //    skip the filter) and it is measured in minutes.
  assert.match(
    q.text,
    /updated_at\s*<\s*now\(\)\s*-\s*\(\s*\$2::int\s*\*\s*interval\s*'1 minute'\s*\)/i,
    "stale-row filter must use the parameter-bound minute interval",
  );

  // 3. The whole clause is negated (NOT (...)) — without the NOT, the query
  //    would return ONLY stale AI seeds, which is the opposite of what we want.
  assert.match(
    q.text,
    /AND\s+NOT\s*\(\s*[\s\S]*payload->>'seeded_by'[\s\S]{0,30}=\s*'ai_dispatch_create'[\s\S]*updated_at\s*<\s*now\(\)/i,
    "stale-row filter must be wrapped in NOT(...) so it EXCLUDES stale seeds, not selects them",
  );
});

test("buildListTen8ActiveIncidentsQuery orders newest-first and caps the result set", () => {
  // The console renders the call list in update-time order, newest first, and
  // relies on the LIMIT to keep payload sizes bounded. Both have caused incident
  // reports in the past when accidentally dropped, so they are part of the
  // regression contract.
  const q = buildListTen8ActiveIncidentsQuery(1);
  assert.match(q.text, /ORDER\s+BY\s+updated_at\s+DESC/i);
  assert.match(q.text, /LIMIT\s+100/i);
});

test("buildListTen8ActiveIncidentsQuery is pure — repeated calls return equivalent SQL", () => {
  // The query is constructed from constants only; there must be no hidden
  // state (cached pool, mutable closure) that would let one call observe a
  // different SQL string than another with the same agency id.
  const a = buildListTen8ActiveIncidentsQuery(7);
  const b = buildListTen8ActiveIncidentsQuery(7);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.values, b.values);
});

test("buildListTen8ActiveIncidentsQuery passes the agency id through without coercion", () => {
  // Bound parameters are forwarded to pg as-is; tests guard against an accidental
  // toString/clamp on the agency id that would break tenant isolation.
  const q = buildListTen8ActiveIncidentsQuery(0);
  assert.equal(q.values[0], 0);
  const q2 = buildListTen8ActiveIncidentsQuery(999_999);
  assert.equal(q2.values[0], 999_999);
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test("shouldTreatTen8IncidentAsActive: non-seeded incidents stay active regardless of age", () => {
  const now = Date.now();
  const veryOld = now - AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS * 100;
  const keep = shouldTreatTen8IncidentAsActive(
    {
      payload: { action: "updated", incident: { callID: "C-1" } },
      updated_at: iso(veryOld),
    },
    now,
  );
  assert.equal(keep, true);
});

test("shouldTreatTen8IncidentAsActive: seeded incidents remain active inside grace window", () => {
  const now = Date.now();
  const seededAt = now - AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS + 5_000;
  const keep = shouldTreatTen8IncidentAsActive(
    {
      payload: { seeded_by: "ai_dispatch_create", incident: { callID: "C-2" } },
      updated_at: iso(seededAt),
    },
    now,
  );
  assert.equal(keep, true);
});

test("shouldTreatTen8IncidentAsActive: seeded incidents expire after grace window", () => {
  const now = Date.now();
  const seededAt = now - AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS - 1;
  const keep = shouldTreatTen8IncidentAsActive(
    {
      payload: { seeded_by: "ai_dispatch_create", incident: { callID: "C-3" } },
      updated_at: iso(seededAt),
    },
    now,
  );
  assert.equal(keep, false);
});

test("shouldTreatTen8IncidentAsActive: malformed seeded timestamp is treated as expired", () => {
  const keep = shouldTreatTen8IncidentAsActive(
    {
      payload: { seeded_by: "ai_dispatch_create", incident: { callID: "C-4" } },
      updated_at: "not-a-date",
    },
    Date.now(),
  );
  assert.equal(keep, false);
});
