import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_DISPATCH_SEEDED_ACTIVE_GRACE_MS,
  shouldTreatTen8IncidentAsActive,
} from "../../src/ten8/store.js";

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
