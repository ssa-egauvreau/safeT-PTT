/**
 * Second-snapshot tests for `server/src/aiDispatch/platformConfig.ts`.
 *
 * The platform config caches its env-derived snapshot for the lifetime of
 * the process. That means we cannot test multiple env shapes in a single
 * file — once the first call to `getAiDispatchPlatformConfig()` runs, the
 * snapshot is frozen. The companion `platformConfig.test.ts` exercises the
 * "anthropic provider + explicit env" branch; this file exercises the
 * "openai provider + defaults" branch in a separate process (node:test
 * runs each test file as its own child process under --test).
 *
 * Specifically pinned here:
 *
 *   - When AI_DISPATCH_LLM_PROVIDER=openai, the model defaults to
 *     `gpt-4o-mini` rather than the anthropic default. A regression that
 *     fell through to the anthropic default model would silently 404
 *     every OpenAI call.
 *
 *   - Default LLM base URL is `https://api.openai.com/v1` (no trailing
 *     slash) when no env override is set. `llm.ts` appends
 *     `/chat/completions` directly, so a trailing slash drifts to 404.
 *
 *   - Default dispatchUnitId is `AI-DISPATCH` when no env override.
 *
 *   - `promptCacheTtl` defaults to `1h` when env is unset or anything
 *     other than `5m`.
 *
 *   - `yieldsToUnitsDefault` is the literal "AI_DISPATCH_YIELDS_DEFAULT
 *     !== '0'" — empty / unset env means TRUE (yield ON by default), and
 *     ONLY the literal string "0" disables yielding. Lock this in: a
 *     regression to "==='1'" would silently disable yielding for every
 *     operator that never set the var.
 *
 *   - `enabled` defaults to false when AI_DISPATCH_ENABLED is unset
 *     (envFlag(name, false)). An operator must opt in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Set env BEFORE the dynamic import so the cached snapshot reflects this
// state. Deliberately leave most env vars unset so we exercise the
// default branches.
process.env.AI_DISPATCH_LLM_PROVIDER = "openai";
process.env.AI_DISPATCH_LLM_API_KEY = "sk-openai-fixture";
// AI_DISPATCH_ENABLED unset → must default to false
delete process.env.AI_DISPATCH_ENABLED;
// AI_DISPATCH_LLM_MODEL unset → must default to gpt-4o-mini (openai branch)
delete process.env.AI_DISPATCH_LLM_MODEL;
// AI_DISPATCH_LLM_BASE_URL unset → must default to https://api.openai.com/v1
delete process.env.AI_DISPATCH_LLM_BASE_URL;
// AI_DISPATCH_PROMPT_CACHE_TTL unset → must default to 1h
delete process.env.AI_DISPATCH_PROMPT_CACHE_TTL;
// AI_DISPATCH_SYSTEM_PROMPT unset → must default to the bundled string
delete process.env.AI_DISPATCH_SYSTEM_PROMPT;
// AI_DISPATCH_UNIT_ID unset → must default to "AI-DISPATCH"
delete process.env.AI_DISPATCH_UNIT_ID;
// AI_DISPATCH_YIELDS_DEFAULT unset → must default to true (yield ON)
delete process.env.AI_DISPATCH_YIELDS_DEFAULT;

const { getAiDispatchPlatformConfig, getAiDispatchPlatformStatus } = await import(
  "../../src/aiDispatch/platformConfig.js"
);

test("default-env: enabled is FALSE when AI_DISPATCH_ENABLED is unset (must opt in)", () => {
  // envFlag(name, false) — operators must explicitly enable AI dispatch.
  // A regression that flipped this default to true would silently turn
  // the dispatcher on for every server that upgrades without setting
  // the flag.
  assert.equal(getAiDispatchPlatformConfig().enabled, false);
});

test("openai-explicit-provider: provider is openai and model defaults to gpt-4o-mini", () => {
  const c = getAiDispatchPlatformConfig();
  assert.equal(c.llmProvider, "openai");
  // Model default depends on provider — anthropic uses claude-sonnet-4-6.
  // A regression that swapped them would silently 404 every parse call.
  assert.equal(c.llmModel, "gpt-4o-mini");
});

test("default-env: base URL is https://api.openai.com/v1 with NO trailing slash", () => {
  const c = getAiDispatchPlatformConfig();
  // llm.ts appends `/chat/completions` directly — a trailing slash drifts
  // to a 404 from OpenAI's gateway.
  assert.equal(c.llmBaseUrl, "https://api.openai.com/v1");
  assert.ok(!c.llmBaseUrl.endsWith("/"));
});

test("default-env: promptCacheTtl defaults to '1h' (large SSA system prompt)", () => {
  // 1h cache is the cheaper hot-path option; 5m is only worth picking
  // when the prompt rotates often. Default must stay on 1h.
  assert.equal(getAiDispatchPlatformConfig().promptCacheTtl, "1h");
});

test("default-env: dispatchUnitId defaults to 'AI-DISPATCH'", () => {
  // This is the callsign isAiDispatchUnit matches against — the voice
  // relay uses it to gate the AI's own transmissions out of the
  // recording / re-transcription pipeline. A regression that changed
  // the default would silently send the dispatcher back through the
  // recorder (echo loop).
  assert.equal(getAiDispatchPlatformConfig().dispatchUnitId, "AI-DISPATCH");
});

test("default-env: defaultSystemPrompt falls back to the bundled brief sentence", () => {
  const c = getAiDispatchPlatformConfig();
  // The bundled fallback is intentionally generic but functional — a
  // regression that fell back to an empty string would make every LLM
  // parse call run without a system prompt.
  assert.ok(c.defaultSystemPrompt.length > 0);
  assert.match(c.defaultSystemPrompt, /dispatcher/i);
});

test("default-env: yieldsToUnitsDefault is TRUE when env is unset (yield ON by default)", () => {
  // The contract is `process.env.AI_DISPATCH_YIELDS_DEFAULT?.trim() !== "0"`.
  // Unset means TRUE — the AI must yield to a unit keying up unless an
  // operator explicitly sets the env to "0". A regression that flipped
  // the default to false would silently stop the AI from yielding and
  // dispatchers would have their transmissions stepped on.
  assert.equal(getAiDispatchPlatformConfig().yieldsToUnitsDefault, true);
});

test("default-env: getAiDispatchPlatformStatus reports llmConfigured=true (key is present)", () => {
  // The status endpoint must reflect llmApiKey.length > 0, not enabled.
  // The fixture sets a key but leaves AI_DISPATCH_ENABLED unset.
  const s = getAiDispatchPlatformStatus();
  assert.equal(s.enabled, false);
  assert.equal(s.llmConfigured, true);
  assert.equal(s.llmProvider, "openai");
  assert.equal(s.model, "gpt-4o-mini");
  assert.equal(s.dispatchUnitId, "AI-DISPATCH");
});
