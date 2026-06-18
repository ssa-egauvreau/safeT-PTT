/**
 * Regression tests for `describeTtsFailure` in `server/src/aiDispatch/tts.ts`.
 *
 * When an ElevenLabs synth call fails, the AI dispatcher logs a "reply not
 * aired" outcome that the console surfaces to the agency owner on the
 * transmission's activity card. Before this helper existed, every failure —
 * exhausted credits, a revoked key, a typo'd voice ID — collapsed into the
 * same generic "check the API key and voice ID" string, so an owner staring
 * at a silent radio had no idea which of the three to actually fix.
 *
 * `describeTtsFailure` is the single point that maps the ElevenLabs HTTP
 * status + body into the actionable reason the owner reads. A regression here
 * silently sends them back to guessing, so the contract is pinned:
 *
 *   1. A missing/typo'd voice ID (404, or a body that names the voice) is
 *      called out specifically — it's the one cause the generic message
 *      historically buried, and it's not fixable by topping up credits.
 *   2. Exhausted credits / quota (402 or credit wording) say so, so the owner
 *      tops up instead of rotating a perfectly good key.
 *   3. A bad/revoked key (401/403) points at authentication.
 *   4. Anything else degrades to a generic provider error that still carries
 *      the HTTP status for a support ticket.
 *
 * Cases 2–4 are delegated to `classifyFailure` (pinned in
 * tests/integrations/health.test.ts); these tests assert the TTS-specific
 * voice-ID branch and that the delegation is wired up.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { describeTtsFailure } from "../../../src/aiDispatch/tts.js";

test("404 is reported as a voice-ID problem, not a credit/key problem", (_t: TestContext) => {
  const detail = describeTtsFailure(404, "");
  assert.match(detail, /voice ID/i);
  // Must NOT be misclassified as an auth or credit failure — those send the
  // owner to fix the wrong thing.
  assert.doesNotMatch(detail, /api key|credit|quota/i);
});

test("a body naming the voice is called out as a voice-ID problem regardless of status", (_t: TestContext) => {
  // ElevenLabs returns 422 (not 404) for an unknown voice on some routes, with
  // a `voice_not_found` detail in the body — the wording, not just the status,
  // has to drive the classification.
  const byCode = describeTtsFailure(422, `{"detail":{"status":"voice_not_found"}}`);
  assert.match(byCode, /voice ID/i);

  const byPhrase = describeTtsFailure(400, "The requested voice does not exist");
  assert.match(byPhrase, /voice ID/i);
});

test("exhausted credits delegate to the credit/quota message", (_t: TestContext) => {
  assert.match(describeTtsFailure(402, ""), /credit|quota/i);
  assert.match(
    describeTtsFailure(401, "quota_exceeded for this month"),
    /credit|quota/i,
    "credit wording wins even when the status is 401",
  );
});

test("a bad key (401/403) points at authentication", (_t: TestContext) => {
  assert.match(describeTtsFailure(401, ""), /auth/i);
  assert.match(describeTtsFailure(403, ""), /auth/i);
});

test("an unrecognized failure degrades to a generic provider error carrying the status", (_t: TestContext) => {
  const detail = describeTtsFailure(503, "upstream unavailable");
  assert.match(detail, /503/);
  // Not falsely attributed to the voice ID or a missing key.
  assert.doesNotMatch(detail, /voice ID/i);
});
