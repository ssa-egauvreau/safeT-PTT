/**
 * Tests for `server/src/ten8/cadComments.ts`.
 *
 * - `formatTen8RadioComment` is the only thing that decides what text we
 *   POST to the 10-8 New Comment API. A regression that lets a blank
 *   call-sign or blank transcript through writes a meaningless comment
 *   onto an open CAD call.
 * - `isVerifiedOpenCallId` is the safety check that prevents the engine
 *   from posting a comment to the wrong (or stale) call_id.
 * - `extractCallIdFromCreateResponse` is how we read the call_id back
 *   out of the New Incident response so follow-up comments / status
 *   updates land on the right call. The shape varies between
 *   environments (array, single object, wrapped { incidents: [...] })
 *   and a regression silently breaks call linking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractCallIdFromCreateResponse,
  formatTen8RadioComment,
  isVerifiedOpenCallId,
} from "../../src/ten8/cadComments.js";

test("formatTen8RadioComment joins callsign and transcript with a space", () => {
  assert.equal(
    formatTen8RadioComment("27-040", "10-97 on scene"),
    "27-040 10-97 on scene",
  );
});

test("formatTen8RadioComment trims surrounding whitespace on both fields", () => {
  assert.equal(
    formatTen8RadioComment("  27-040  ", "  10-97 on scene  "),
    "27-040 10-97 on scene",
  );
});

test("formatTen8RadioComment returns null when either side is blank", () => {
  assert.equal(formatTen8RadioComment("", "anything"), null);
  assert.equal(formatTen8RadioComment("27-040", ""), null);
  assert.equal(formatTen8RadioComment("  ", "anything"), null);
  assert.equal(formatTen8RadioComment("27-040", "  "), null);
});

test("formatTen8RadioComment caps the comment at 4000 chars (10-8 API limit)", () => {
  const big = "x".repeat(5000);
  const out = formatTen8RadioComment("27-040", big);
  assert.ok(out);
  assert.equal(out!.length, 4000);
  // Callsign + space lead must survive the cap.
  assert.ok(out!.startsWith("27-040 "));
});

test("isVerifiedOpenCallId is true only when the id is in the active list", () => {
  const active = [{ call_id: "C-1001" }, { call_id: "C-1002" }];
  assert.equal(isVerifiedOpenCallId("C-1001", active), true);
  assert.equal(isVerifiedOpenCallId("C-1002", active), true);
  assert.equal(isVerifiedOpenCallId("C-9999", active), false);
});

test("isVerifiedOpenCallId is whitespace-tolerant on both sides", () => {
  assert.equal(
    isVerifiedOpenCallId("  C-1001  ", [{ call_id: "C-1001" }]),
    true,
  );
  assert.equal(
    isVerifiedOpenCallId("C-1001", [{ call_id: "  C-1001  " }]),
    true,
  );
});

test("isVerifiedOpenCallId rejects empty / whitespace-only ids", () => {
  assert.equal(isVerifiedOpenCallId("", [{ call_id: "C-1001" }]), false);
  assert.equal(isVerifiedOpenCallId("   ", [{ call_id: "C-1001" }]), false);
});

test("extractCallIdFromCreateResponse handles array shape", () => {
  assert.equal(
    extractCallIdFromCreateResponse([{ incident_id: "C-501" }]),
    "C-501",
  );
});

test("extractCallIdFromCreateResponse handles single-object shape", () => {
  assert.equal(
    extractCallIdFromCreateResponse({ incident_id: "C-502" }),
    "C-502",
  );
});

test("extractCallIdFromCreateResponse handles wrapped { incidents: [...] }", () => {
  assert.equal(
    extractCallIdFromCreateResponse({ incidents: [{ id: "C-503" }] }),
    "C-503",
  );
});

test("extractCallIdFromCreateResponse accepts any of the known field aliases", () => {
  for (const field of ["incident_id", "incidentId", "id", "callID", "callId"]) {
    const data = { [field]: "C-AL" } as Record<string, unknown>;
    assert.equal(
      extractCallIdFromCreateResponse(data),
      "C-AL",
      `field "${field}" must be honored`,
    );
  }
});

test("extractCallIdFromCreateResponse coerces numeric ids to strings", () => {
  assert.equal(
    extractCallIdFromCreateResponse({ incident_id: 12345 }),
    "12345",
  );
});

test("extractCallIdFromCreateResponse returns null for non-incident shapes", () => {
  assert.equal(extractCallIdFromCreateResponse(null), null);
  assert.equal(extractCallIdFromCreateResponse(undefined), null);
  assert.equal(extractCallIdFromCreateResponse([]), null);
  assert.equal(extractCallIdFromCreateResponse({}), null);
  assert.equal(
    extractCallIdFromCreateResponse([{ unrelated: "value" }]),
    null,
  );
  // Empty / whitespace id is treated as missing.
  assert.equal(
    extractCallIdFromCreateResponse({ incident_id: "  " }),
    null,
  );
});
