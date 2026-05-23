/**
 * Tests for `server/src/aiDispatch/dedupe.ts`.
 *
 * The duplicate-AI-dispatch guard is what stops a single radio transmission
 * from being processed by the AI engine N times when simulcast / bridges
 * mirror the same audio onto multiple channels — without it the engine
 * creates N CAD incidents for the same call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldSkipDuplicateAiDispatch } from "../../src/aiDispatch/dedupe.js";

// Each test uses a unique agency id + transcript prefix so that earlier tests
// can't leak their cached entries into later ones. The dedupe map is process-
// global by design (it's keyed off `${agencyId}:${normalizedTranscript}`).
let UNIQ = 0;
function uniqAgency(): number {
  // Pad with the run timestamp to make collisions with prior process state
  // (e.g. test runner re-runs) effectively impossible.
  return 900_000 + Math.floor(Date.now() % 100_000) + UNIQ++;
}

test("first transmission for an agency is never a duplicate", () => {
  const agencyId = uniqAgency();
  assert.equal(
    shouldSkipDuplicateAiDispatch(agencyId, "27-040 in service"),
    false,
  );
});

test("immediate repeat of the same transcript is flagged as a duplicate", () => {
  const agencyId = uniqAgency();
  const tx = "27-040 961 at 100 Disney Way 8VWV621";
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, tx), false);
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, tx), true);
});

test("case + whitespace differences still count as the same transcript", () => {
  const agencyId = uniqAgency();
  const a = "27-040 961 AT 100 Disney Way";
  const b = "27-040   961    at  100 Disney Way";
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, a), false);
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, b), true);
});

test("different agencies do NOT collide on the same transcript", () => {
  const tx = "in service";
  const a = uniqAgency();
  const b = uniqAgency();
  assert.equal(shouldSkipDuplicateAiDispatch(a, tx), false);
  assert.equal(shouldSkipDuplicateAiDispatch(b, tx), false);
});

test("empty / whitespace-only transcripts are never deduped (let the caller decide)", () => {
  const agencyId = uniqAgency();
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, ""), false);
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, ""), false);
  assert.equal(shouldSkipDuplicateAiDispatch(agencyId, "   "), false);
});

test("different transcripts on the same agency are not flagged", () => {
  const agencyId = uniqAgency();
  assert.equal(
    shouldSkipDuplicateAiDispatch(agencyId, "27-040 on scene"),
    false,
  );
  assert.equal(
    shouldSkipDuplicateAiDispatch(agencyId, "27-040 clear"),
    false,
  );
});
