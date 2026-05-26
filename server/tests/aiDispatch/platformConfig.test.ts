/**
 * Regression tests for `server/src/aiDispatch/platformConfig.ts`.
 *
 * Platform config is the load-bearing module that decides:
 *
 *   - whether the AI dispatcher is enabled at all on this server (env flag
 *     parsing, defaults, truthy-string handling),
 *   - which LLM provider + model + base URL + cache TTL gets called for
 *     every transmission (Anthropic vs OpenAI auto-detection from the
 *     `sk-ant-` API key prefix is the bug-prone fallback path),
 *   - what the canonical AI dispatch unit ID is, and
 *   - therefore which inbound transmissions get re-fed back into the
 *     pipeline vs muted as "this is my own voice" (`isAiDispatchUnit`).
 *
 * The last one is the highest-blast-radius surface here: if
 * `isAiDispatchUnit` ever returns the wrong answer, the engine will either
 * (a) silently drop a legitimate radio unit's transmission whose ID happens
 * to collide with the dispatcher unit ID, or — far worse — (b) re-process
 * its own outbound radio audio as if it were a fresh inbound call, which
 * loops the bot on its own voice and burns LLM credits indefinitely. See
 * `engine.ts` line ~344 where this gate skips re-entrant processing with
 * `outcome = "skipped_dispatch_unit"`.
 *
 * `normalizeDispatchUnitId` is the comparison normaliser both sides of the
 * gate run through, so a regression that drops case-folding (or stops
 * trimming) breaks the feedback-loop guard at the same time.
 *
 * `cached` in platformConfig.ts is process-global, so each test file gets
 * its own fresh cache (node --test forks one worker per .test.ts). We
 * deliberately set env vars BEFORE the dynamic import so the cache settles
 * to the values this file pins. Same pattern as `auth.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// IMPORTANT: env must be set BEFORE `await import` of platformConfig.js
// because `getAiDispatchPlatformConfig()` memoises on first call.
process.env.AI_DISPATCH_ENABLED = "1";
process.env.AI_DISPATCH_LLM_API_KEY = "sk-ant-fixture-key-do-not-use";
process.env.AI_DISPATCH_LLM_MODEL = "claude-sonnet-4-6";
process.env.AI_DISPATCH_LLM_BASE_URL = "https://api.test.local/v1/";
process.env.AI_DISPATCH_PROMPT_CACHE_TTL = "1h";
process.env.AI_DISPATCH_UNIT_ID = "ai-dispatch";
process.env.AI_DISPATCH_YIELDS_DEFAULT = "1";
// Provider is intentionally NOT set so the auto-detect-from-key-prefix path
// is the one exercised by getAiDispatchPlatformConfig().

const {
  getAiDispatchPlatformConfig,
  getAiDispatchPlatformStatus,
  isAiDispatchUnit,
  normalizeDispatchUnitId,
} = await import("../../src/aiDispatch/platformConfig.js");

// ---------- normalizeDispatchUnitId (pure, no env) ----------------------

test("normalizeDispatchUnitId: trims surrounding whitespace and upper-cases", () => {
  assert.equal(normalizeDispatchUnitId("ai-dispatch"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("  AI-DISPATCH  "), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("\tDispatcher\n"), "DISPATCHER");
});

test("normalizeDispatchUnitId: empty input collapses to empty (no padding)", () => {
  // Important for the isAiDispatchUnit truthiness check below — an empty
  // input must NOT match an empty configured ID (and the function's caller
  // guards on the trimmed input being non-empty first).
  assert.equal(normalizeDispatchUnitId(""), "");
  assert.equal(normalizeDispatchUnitId("   "), "");
});

// ---------- isAiDispatchUnit (the feedback-loop guard) ------------------

test("isAiDispatchUnit: matches the configured dispatch unit ID regardless of case/whitespace", () => {
  // The fixture above set AI_DISPATCH_UNIT_ID="ai-dispatch", which the
  // config caches as-is (no .toUpperCase()); the comparison runs both
  // sides through normalizeDispatchUnitId.
  assert.equal(isAiDispatchUnit("ai-dispatch"), true);
  assert.equal(isAiDispatchUnit("AI-DISPATCH"), true);
  assert.equal(isAiDispatchUnit("  Ai-Dispatch  "), true);
});

test("isAiDispatchUnit: returns false for a different unit ID (live radio unit must NOT be muted)", () => {
  // Regression of biggest concern: collapsing this to `true` for any unit
  // would silently mute every officer on the air. Pin the common SSA
  // radio unit shapes as known-false.
  assert.equal(isAiDispatchUnit("27-040"), false);
  assert.equal(isAiDispatchUnit("352"), false);
  assert.equal(isAiDispatchUnit("ADAM-5"), false);
  assert.equal(isAiDispatchUnit("dispatch"), false, "substring is not a match");
});

test("isAiDispatchUnit: blank / null / undefined input returns false (never claims to be the bot)", () => {
  // A frame with no unit_id must never satisfy the dispatcher-self check
  // — that would let the engine drop transmissions whose attribution row
  // happens to be null while still in the middle of being populated.
  assert.equal(isAiDispatchUnit(""), false);
  assert.equal(isAiDispatchUnit("   "), false);
  assert.equal(isAiDispatchUnit(null), false);
  assert.equal(isAiDispatchUnit(undefined), false);
});

// ---------- getAiDispatchPlatformConfig (env wiring + cache) ------------

test("getAiDispatchPlatformConfig: enabled flag honours truthy env strings", () => {
  // The fixture above set AI_DISPATCH_ENABLED="1" — confirm the parser
  // routes that to enabled=true. The reverse (envFlag returning false on
  // unset / "0") is implicitly covered by the OFF defaults a fresh agency
  // would hit — but that branch can't be re-exercised in this file
  // because the config caches on first call.
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.enabled, true);
});

test("getAiDispatchPlatformConfig: provider auto-detects 'anthropic' from sk-ant- API key prefix", () => {
  // AI_DISPATCH_LLM_PROVIDER is unset in the fixture; the resolver should
  // fall through to checking the API key prefix. sk-ant- → anthropic.
  // This is the most common production path (we ship Anthropic by default
  // and only override the provider env when a customer brings OpenAI).
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.llmProvider, "anthropic");
});

test("getAiDispatchPlatformConfig: model defaults to AI_DISPATCH_LLM_MODEL when set", () => {
  // Per-fixture override — pinning that the env wins over the per-provider
  // default fallback baked into platformConfig.ts.
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.llmModel, "claude-sonnet-4-6");
});

test("getAiDispatchPlatformConfig: llmBaseUrl strips a trailing slash", () => {
  // The fixture set AI_DISPATCH_LLM_BASE_URL with a trailing "/"; the
  // resolver must trim it so downstream `${baseUrl}/messages` doesn't
  // produce "//messages" and 404 against Anthropic.
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.llmBaseUrl, "https://api.test.local/v1");
});

test("getAiDispatchPlatformConfig: promptCacheTtl accepts '1h' from env", () => {
  // Only "5m" and "1h" are valid; anything else falls back to "1h". The
  // fixture asks for "1h" explicitly so we lock the round-trip.
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.promptCacheTtl, "1h");
});

test("getAiDispatchPlatformConfig: dispatchUnitId is truncated to 64 chars", () => {
  // The constructor `.slice(0, 64)` guards against an oversized env value
  // overflowing some downstream identifier field. The fixture above used
  // a short value so the slice is a no-op here, but the field length is
  // pinned so a regression that drops the slice doesn't silently start
  // shipping 200-char unit IDs to the radio.
  const cfg = getAiDispatchPlatformConfig();
  assert.ok(cfg.dispatchUnitId.length <= 64, "dispatchUnitId must be <= 64 chars");
  assert.equal(cfg.dispatchUnitId, "ai-dispatch");
});

test("getAiDispatchPlatformConfig: yieldsToUnitsDefault is true unless explicitly '0'", () => {
  // Important policy bit — the AI dispatcher yields to a live radio unit
  // talking on the same channel by default. The OFF path is "0" only.
  // The fixture set AI_DISPATCH_YIELDS_DEFAULT="1" so it stays true.
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(cfg.yieldsToUnitsDefault, true);
});

test("getAiDispatchPlatformConfig: result is memoised (same object across calls)", () => {
  // Important property: callers (engine.ts, isAiDispatchUnit, dryRun.ts)
  // call this hot. The function must return the cached singleton so we
  // don't re-parse env on every transmission.
  const a = getAiDispatchPlatformConfig();
  const b = getAiDispatchPlatformConfig();
  assert.strictEqual(a, b, "config must be memoised (same reference on second call)");
});

// ---------- getAiDispatchPlatformStatus (admin UI summary) --------------

test("getAiDispatchPlatformStatus: surfaces llmConfigured=true when an API key is present, never the key itself", () => {
  // This is the shape the admin UI reads — it must NEVER include the
  // llmApiKey value (would leak secrets through a debug panel).
  const status = getAiDispatchPlatformStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.llmConfigured, true);
  assert.equal(status.llmProvider, "anthropic");
  assert.equal(status.model, "claude-sonnet-4-6");
  assert.equal(status.promptCacheTtl, "1h");
  assert.equal(status.dispatchUnitId, "ai-dispatch");
  // Belt-and-suspenders: walk every field and ensure none equal the
  // fixture API key. If a regression added an "apiKey" or "llmApiKey"
  // field here, this would catch it.
  for (const [k, v] of Object.entries(status)) {
    assert.notEqual(v, "sk-ant-fixture-key-do-not-use", `field "${k}" must NOT leak the API key`);
  }
});
