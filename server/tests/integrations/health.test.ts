/**
 * Tests for the pure provider-failure classifier in
 * `server/src/integrations/health.ts`.
 *
 * `classifyFailure` drives every "credit/quota health" badge on the admin
 * Integrations dashboard. The dashboard surfaces a different alert per
 * status:
 *
 *   - `"out"`   → red, "Out of credits / quota exceeded" — calls the admin
 *                  to action (top up before 911 traffic falls over).
 *   - `"error"` → orange, "Authentication failed — check the API key" or
 *                  "Rate limited" — points at a misconfig vs a credit issue.
 *
 * The classification feeds these alerts for Anthropic / OpenAI (LLM),
 * ElevenLabs (TTS), and plate / VIN lookup providers. A regression here
 * either silently swallows a real credit outage (admin never sees it) or
 * nags the admin about transient 5xx errors as if they were credit issues.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure } from "../../src/integrations/health.js";

test("classifyFailure: HTTP 402 → 'out' (Stripe-style payment required)", () => {
  // 402 is the universal "payment required" status; surface as a credit
  // outage even if the body is missing.
  const got = classifyFailure(402);
  assert.equal(got.status, "out");
  assert.match(got.detail, /credits|quota/i);
});

test("classifyFailure: body containing 'quota_exceeded' → 'out' regardless of status", () => {
  // Some providers return 200/4xx with a structured error body. Surface the
  // credit outage based on the body string so we don't miss it.
  const got = classifyFailure(200, '{"error":{"type":"quota_exceeded"}}');
  assert.equal(got.status, "out");
});

test("classifyFailure: body containing 'insufficient' → 'out'", () => {
  // Anthropic returns "insufficient_quota" / "insufficient credit balance".
  const got = classifyFailure(400, "Your account has insufficient credit balance");
  assert.equal(got.status, "out");
});

test("classifyFailure: body containing 'credit balance' → 'out'", () => {
  const got = classifyFailure(400, "Credit balance is too low");
  assert.equal(got.status, "out");
});

test("classifyFailure: body containing 'out of credit' → 'out'", () => {
  const got = classifyFailure(500, "Account is out of credit");
  assert.equal(got.status, "out");
});

test("classifyFailure: body matching is case-insensitive", () => {
  // Some providers SHOUT in errors, others lowercase. Classification must
  // not depend on which.
  assert.equal(classifyFailure(400, "QUOTA_EXCEEDED").status, "out");
  assert.equal(classifyFailure(400, "Insufficient Credit").status, "out");
});

test("classifyFailure: HTTP 401 → 'error' with auth wording (not credit)", () => {
  // 401 is a key/secret problem, not a credit problem. The admin needs the
  // dashboard to point at the right fix.
  const got = classifyFailure(401);
  assert.equal(got.status, "error");
  assert.match(got.detail, /authentication/i);
});

test("classifyFailure: HTTP 403 → 'error' with auth wording", () => {
  const got = classifyFailure(403);
  assert.equal(got.status, "error");
  assert.match(got.detail, /authentication/i);
});

test("classifyFailure: HTTP 429 → 'error' with rate-limit wording", () => {
  // 429 is throttling, not credit exhaustion — present as a transient error.
  // (Some providers do return 429 when over-quota; that's why the body
  //  check for 'quota_exceeded' runs first.)
  const got = classifyFailure(429);
  assert.equal(got.status, "error");
  assert.match(got.detail, /rate limited|over quota/i);
});

test("classifyFailure: credit-wording in body wins over a 401 status", () => {
  // If both the status AND the body have signal, the credit classification
  // takes precedence — 401 + "quota exceeded" should NOT down-grade the
  // alert to "check the API key".
  const got = classifyFailure(401, "quota_exceeded");
  assert.equal(got.status, "out");
});

test("classifyFailure: unknown 5xx falls through to generic 'error' with HTTP status", () => {
  const got = classifyFailure(500);
  assert.equal(got.status, "error");
  // The detail should mention the HTTP code so the operator can correlate
  // it with provider status pages / their own logs.
  assert.match(got.detail, /HTTP 500/);
});

test("classifyFailure: 4xx not specifically handled falls through to 'error'", () => {
  // 400 / 404 / 422 without credit wording — generic provider error.
  for (const code of [400, 404, 422]) {
    const got = classifyFailure(code);
    assert.equal(got.status, "error", `HTTP ${code} must classify as error`);
    assert.match(got.detail, new RegExp(`HTTP ${code}`));
  }
});

test("classifyFailure: undefined status + empty body → generic 'Provider error'", () => {
  // Network failure / TLS error / DNS hiccup — no HTTP status at all.
  // The classifier still has to return something usable.
  const got = classifyFailure();
  assert.equal(got.status, "error");
  assert.match(got.detail, /Provider error/);
  // Must NOT pretend it's an auth or credit issue.
  assert.doesNotMatch(got.detail, /credit|quota|authentication|HTTP/i);
});

test("classifyFailure: undefined body never throws (defensive)", () => {
  // The body string is best-effort (`res.text().catch(() => "")`); the
  // classifier must tolerate undefined / null without throwing — otherwise
  // the dashboard endpoint 500s instead of rendering a degraded badge.
  assert.doesNotThrow(() => classifyFailure(500, undefined));
  assert.doesNotThrow(() => classifyFailure(undefined, undefined));
});

test("classifyFailure: a 200 with no credit wording → generic 'error' (not 'out')", () => {
  // A 200 with a non-credit body is a recordCall caller bug, but the
  // classifier must not invent a credit outage when there is no signal of
  // one.
  const got = classifyFailure(200, "Some other error");
  assert.equal(got.status, "error");
  assert.doesNotMatch(got.detail, /credit|quota/i);
});

test("classifyFailure: never returns 'ok', 'low', or 'unknown' (only 'out' or 'error')", () => {
  // `classifyFailure` is only called on a failed provider call — by
  // contract it must always indicate a problem (out vs error). The
  // healthy/low/unknown branches are owned by the proactive ElevenLabs
  // poll, not this classifier. Lock that contract in: a regression that
  // returns "ok" from a failure would silently hide live outages.
  const samples = [
    classifyFailure(),
    classifyFailure(500),
    classifyFailure(401),
    classifyFailure(402),
    classifyFailure(429),
    classifyFailure(200, "quota_exceeded"),
    classifyFailure(undefined, "insufficient credit"),
  ];
  for (const s of samples) {
    assert.ok(
      s.status === "out" || s.status === "error",
      `classifier must report a problem, got "${s.status}"`,
    );
  }
});
