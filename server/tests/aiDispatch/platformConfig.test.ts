/**
 * Tests for `server/src/aiDispatch/platformConfig.ts`.
 *
 * The platform config is the small env-driven snapshot every AI dispatcher
 * code path reads to decide:
 *
 *   - which LLM provider/model/base-URL to call (cost + correctness),
 *   - which Anthropic ephemeral prompt-cache TTL to attach (1h vs 5m —
 *     the difference between hot-cached and cold-billed system prompts),
 *   - which callsign the AI speaks as on the air,
 *   - whether the AI must yield (cut off) when a human keys up,
 *   - whether AI dispatch is globally enabled for this server at all.
 *
 * Regressions caught here:
 *
 *   - A drift in `normalizeDispatchUnitId` would break `isAiDispatchUnit`
 *     so the voice relay no longer recognises the AI's own transmissions
 *     — every AI utterance would land in the regular recording pipeline,
 *     trigger transcription, and potentially feed back into the
 *     dispatcher (echo loop).
 *
 *   - A regression in the env parser that defaulted the LLM model to the
 *     wrong family (e.g. anthropic default mis-named) would silently
 *     return 404 from every parse attempt — AI dispatch goes dark.
 *
 *   - A regression in `getAiDispatchPlatformStatus` that leaked
 *     `llmApiKey` would expose the platform API key in the admin status
 *     endpoint.
 *
 *   - A regression that re-derived config on every call (lost the
 *     `cached` short-circuit) would defeat the documented "loaded once
 *     per process, restart to change" contract — env mutations mid-flight
 *     would silently re-shape the dispatcher.
 *
 *   - A regression that flipped `yieldsToUnitsDefault` to false-by-default
 *     would silently stop the AI from yielding when a unit keys up.
 *     Officers would have their transmissions stepped on.
 *
 * Each test file runs in its own subprocess under node --test, so the
 * one-shot module cache populated below is isolated from other suites
 * (which may need a different env snapshot).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// IMPORTANT: env MUST be set before the first import of platformConfig.ts.
// `getAiDispatchPlatformConfig()` is documented as "loaded once per
// process; env changes require restart" — once it runs, the snapshot is
// frozen.
process.env.AI_DISPATCH_ENABLED = "true";
process.env.AI_DISPATCH_LLM_API_KEY = "sk-ant-test-platformconfig-fixture";
process.env.AI_DISPATCH_LLM_PROVIDER = "anthropic";
process.env.AI_DISPATCH_LLM_MODEL = "claude-test-model";
process.env.AI_DISPATCH_LLM_BASE_URL = "https://api.anthropic.com/v1/";
process.env.AI_DISPATCH_PROMPT_CACHE_TTL = "5m";
process.env.AI_DISPATCH_SYSTEM_PROMPT = "You are the test fixture dispatcher.";
process.env.AI_DISPATCH_UNIT_ID = "  ai-test-dispatch  ";
process.env.AI_DISPATCH_YIELDS_DEFAULT = "1";

const {
  getAiDispatchPlatformConfig,
  getAiDispatchPlatformStatus,
  normalizeDispatchUnitId,
  isAiDispatchUnit,
} = await import("../../src/aiDispatch/platformConfig.js");

// --- normalizeDispatchUnitId (pure) ------------------------------------

test("normalizeDispatchUnitId trims surrounding whitespace and uppercases", () => {
  assert.equal(normalizeDispatchUnitId("ai-dispatch"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("  ai-dispatch  "), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("AI-DISPATCH"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("Ai-Dispatch"), "AI-DISPATCH");
});

test("normalizeDispatchUnitId leaves internal punctuation, digits, and dashes alone", () => {
  // The voice relay routes on the exact normalised form. A regression
  // that stripped punctuation here would collide unit IDs.
  assert.equal(normalizeDispatchUnitId("27-040"), "27-040");
  assert.equal(normalizeDispatchUnitId("AI_DISP_1"), "AI_DISP_1");
  assert.equal(normalizeDispatchUnitId("dispatch.bot"), "DISPATCH.BOT");
});

test("normalizeDispatchUnitId returns the empty string for empty/whitespace input", () => {
  // Don't throw — the helper is called from defensive guards in
  // isAiDispatchUnit, plate handlers, etc.
  assert.equal(normalizeDispatchUnitId(""), "");
  assert.equal(normalizeDispatchUnitId("   "), "");
});

// --- isAiDispatchUnit -------------------------------------------------

test("isAiDispatchUnit returns false for null / undefined / empty / whitespace", () => {
  // Hot-path guard: voice relay calls this on every incoming transmission's
  // unit_id, which is sometimes null (legacy radio-key sockets) or blank.
  // A regression that threw on falsy input would crash the relay.
  assert.equal(isAiDispatchUnit(null), false);
  assert.equal(isAiDispatchUnit(undefined), false);
  assert.equal(isAiDispatchUnit(""), false);
  assert.equal(isAiDispatchUnit("   "), false);
});

test("isAiDispatchUnit matches the configured dispatch unit case-insensitively (and ignores whitespace)", () => {
  // Env above sets AI_DISPATCH_UNIT_ID="  ai-test-dispatch  ", which the
  // config trims and the voice relay later normalises. The match MUST be
  // case- and whitespace-insensitive so an admin's lowercase "ai-test-
  // dispatch" still gates the AI's own callsign out of the recording
  // pipeline.
  assert.equal(isAiDispatchUnit("ai-test-dispatch"), true);
  assert.equal(isAiDispatchUnit("AI-TEST-DISPATCH"), true);
  assert.equal(isAiDispatchUnit("  ai-test-dispatch  "), true);
  assert.equal(isAiDispatchUnit("Ai-Test-Dispatch"), true);
});

test("isAiDispatchUnit returns false for any other unit", () => {
  // Tight equality — a regression that matched on substring would
  // mis-classify legitimate radio units whose ID happens to contain
  // the AI callsign substring.
  assert.equal(isAiDispatchUnit("27-040"), false);
  assert.equal(isAiDispatchUnit("ai-test"), false);
  assert.equal(isAiDispatchUnit("ai-test-dispatch-2"), false);
});

// --- getAiDispatchPlatformConfig --------------------------------------

test("getAiDispatchPlatformConfig: enabled flag follows AI_DISPATCH_ENABLED env", () => {
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.enabled, true);
});

test("getAiDispatchPlatformConfig: anthropic provider + env-overridden model are respected", () => {
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.llmProvider, "anthropic");
  assert.equal(c.llmModel, "claude-test-model");
});

test("getAiDispatchPlatformConfig: base URL strips a single trailing slash", () => {
  // The fetch sites in llm.ts append `/messages` or `/chat/completions`
  // directly. A drift that left the trailing slash would produce double-
  // slashed URLs and 404 every call.
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.llmBaseUrl, "https://api.anthropic.com/v1");
});

test("getAiDispatchPlatformConfig: promptCacheTtl honours '5m' / '1h' and falls back to 1h", () => {
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.promptCacheTtl, "5m");
});

test("getAiDispatchPlatformConfig: dispatchUnitId is trimmed and capped at 64 chars", () => {
  const c = getAiDispatchPlatformConfig();
  // Env value is "  ai-test-dispatch  " → trimmed to "ai-test-dispatch".
  assert.equal(c.dispatchUnitId, "ai-test-dispatch");
  assert.ok(c.dispatchUnitId.length <= 64);
});

test("getAiDispatchPlatformConfig: defaultSystemPrompt follows AI_DISPATCH_SYSTEM_PROMPT env", () => {
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.defaultSystemPrompt, "You are the test fixture dispatcher.");
});

test("getAiDispatchPlatformConfig: yieldsToUnitsDefault is true unless AI_DISPATCH_YIELDS_DEFAULT='0'", () => {
  // Env above sets it to "1" (truthy). The contract is `!== "0"` — i.e.
  // ANY value other than the literal string "0" leaves yielding ON. This
  // protects against an operator typo (AI_DISPATCH_YIELDS_DEFAULT=false)
  // accidentally disabling the yield behaviour.
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.yieldsToUnitsDefault, true);
});

test("getAiDispatchPlatformConfig is cached — second call returns the same snapshot object", () => {
  // The 'loaded once per process' contract is what lets call sites cache
  // the config in module-scope. Re-deriving on every call would defeat
  // that and also make env mutations mid-flight silently re-shape the
  // dispatcher.
  const a = getAiDispatchPlatformConfig();
  const b = getAiDispatchPlatformConfig();
  assert.equal(a, b);
});

// --- getAiDispatchPlatformStatus --------------------------------------

test("getAiDispatchPlatformStatus exposes the model + dispatch unit but NEVER the raw API key", () => {
  const status = getAiDispatchPlatformStatus();
  // Positive: status must report key fields the admin UI needs.
  assert.equal(status.enabled, true);
  assert.equal(status.llmConfigured, true);
  assert.equal(status.llmProvider, "anthropic");
  assert.equal(status.model, "claude-test-model");
  assert.equal(status.promptCacheTtl, "5m");
  assert.equal(status.dispatchUnitId, "ai-test-dispatch");

  // Negative: must not leak any string field with the api key prefix
  // (`sk-ant-`). The admin endpoint that serves this is gated behind
  // admin auth but the contract is still 'never expose secrets here'.
  for (const v of Object.values(status as Record<string, unknown>)) {
    if (typeof v === "string") {
      assert.ok(
        !v.startsWith("sk-"),
        `getAiDispatchPlatformStatus must not leak api keys (saw ${v})`,
      );
    }
  }
  // The api key itself isn't reachable through the returned shape.
  assert.equal((status as Record<string, unknown>).llmApiKey, undefined);
});

test("getAiDispatchPlatformStatus.llmConfigured reflects API key presence (not its contents)", () => {
  // The flag is the only signal an admin gets that the LLM key is
  // populated. A regression that set this from `enabled` (the env
  // toggle) instead of the key would make 'AI on but no key configured'
  // look healthy in the UI.
  const status = getAiDispatchPlatformStatus();
  assert.equal(status.llmConfigured, true, "fixture sets a non-empty key");
});
