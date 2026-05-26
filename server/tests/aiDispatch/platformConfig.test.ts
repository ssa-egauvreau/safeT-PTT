/**
 * Tests for `server/src/aiDispatch/platformConfig.ts`.
 *
 * `isAiDispatchUnit` is the *exact* gate that decides whether a finalized
 * transmission gets re-processed by the AI dispatcher. The check happens
 * in the very first branch of the engine's transcription handler
 * (`aiDispatch/engine.ts`, "if (isAiDispatchUnit(tx.unit_id)) { outcome =
 * 'skipped_dispatch_unit'; return; }"). A regression goes both ways:
 *
 *   - False POSITIVE (returns true for a real unit) → the officer's
 *     transmission is silently dropped as "AI dispatch unit (not
 *     re-processed)". No incident, no comment, no dispatcher ack. The
 *     only signal is an `ai_dispatch_log` row with outcome=skipped.
 *
 *   - False NEGATIVE (returns false for the AI unit) → the AI's own
 *     acknowledgement transmission is re-fed to the engine, which
 *     generates a reply, which is re-fed, ... A runaway loop on a
 *     metered LLM is expensive in seconds.
 *
 * `normalizeDispatchUnitId` is the comparator on both sides. The trim +
 * upper-case fold is what lets `isAiDispatchUnit` match a transmission
 * the relay tagged as `ai-dispatch` or `  AI-Dispatch  ` against a
 * config that stored `AI-DISPATCH`. A regression that, say, stopped
 * upper-casing means an `ai-dispatch` lowercase transmission slips past
 * the gate and triggers the loop above.
 *
 * IMPORTANT — these tests do not set `AI_DISPATCH_UNIT_ID`. The platform
 * config is process-cached on first call, so a test-time `process.env`
 * write is racey with whatever code path imported the module first. We
 * pin only the documented default (`AI-DISPATCH`) and the env-independent
 * `normalizeDispatchUnitId` contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAiDispatchPlatformConfig,
  getAiDispatchPlatformStatus,
  isAiDispatchUnit,
  normalizeDispatchUnitId,
} from "../../src/aiDispatch/platformConfig.js";

// --- normalizeDispatchUnitId ---------------------------------------------

test("normalizeDispatchUnitId: trims surrounding whitespace and upper-cases", () => {
  // The comparator must produce the SAME key for the spelling stored in
  // config and the spelling the relay tagged on a live transmission, no
  // matter which side has padding or casing inconsistencies.
  assert.equal(normalizeDispatchUnitId("AI-DISPATCH"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("ai-dispatch"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("  ai-dispatch  "), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("Ai-Dispatch"), "AI-DISPATCH");
});

test("normalizeDispatchUnitId: empty / whitespace-only input is normalized to empty string", () => {
  // The empty-string case is special: it means `getAiDispatchPlatformConfig`
  // would never let dispatchUnitId be empty (the env fallback is
  // "AI-DISPATCH"), so a normalized empty string here can only come from
  // the *transmission* side. `isAiDispatchUnit` handles that with its
  // own early-return guard.
  assert.equal(normalizeDispatchUnitId(""), "");
  assert.equal(normalizeDispatchUnitId("   "), "");
  assert.equal(normalizeDispatchUnitId("\t\n"), "");
});

test("normalizeDispatchUnitId: preserves the dash (the AI unit id is dashed, not a number)", () => {
  // Don't get cute and strip the dash — the dispatchUnitId is "AI-DISPATCH"
  // and a transmission tagged "AI-DISPATCH" must match it exactly.
  assert.equal(normalizeDispatchUnitId("AI-DISPATCH"), "AI-DISPATCH");
  assert.ok(normalizeDispatchUnitId("AI-DISPATCH").includes("-"));
});

test("normalizeDispatchUnitId: leaves an internal mixed-case unit unchanged after upper-casing", () => {
  // Any future operator that picks a custom dispatch unit id ("ai-bot-1",
  // "DispatchAI", …) must end up with a consistent comparison key.
  assert.equal(normalizeDispatchUnitId("ai-bot-1"), "AI-BOT-1");
  assert.equal(normalizeDispatchUnitId("DispatchAI"), "DISPATCHAI");
});

// --- isAiDispatchUnit ----------------------------------------------------

test("isAiDispatchUnit: returns false for null / undefined / empty / whitespace input", () => {
  // The engine reads this BEFORE asserting any other property of the
  // transmission — it must never throw on a row whose `unit_id` is null
  // (legacy bridge rows in particular often are).
  assert.equal(isAiDispatchUnit(null), false);
  assert.equal(isAiDispatchUnit(undefined), false);
  assert.equal(isAiDispatchUnit(""), false);
  assert.equal(isAiDispatchUnit("   "), false);
  assert.equal(isAiDispatchUnit("\t\n"), false);
});

test("isAiDispatchUnit: matches the default 'AI-DISPATCH' literal", () => {
  // This is the documented default the platform config falls back to when
  // AI_DISPATCH_UNIT_ID is unset (see platformConfig.ts:70). A regression
  // that breaks this match unblocks the loopback: the AI's own ack is
  // re-processed as a real transmission.
  assert.equal(isAiDispatchUnit("AI-DISPATCH"), true);
});

test("isAiDispatchUnit: matches case-insensitively (relay-tagged values may be lower-case)", () => {
  // The relay normalizes unit_id at insert time, but historical rows and
  // the legacy bridge can land lower-case strings. The gate must catch
  // them either way.
  assert.equal(isAiDispatchUnit("ai-dispatch"), true);
  assert.equal(isAiDispatchUnit("Ai-Dispatch"), true);
  assert.equal(isAiDispatchUnit("AI-Dispatch"), true);
});

test("isAiDispatchUnit: matches even when the value has surrounding whitespace", () => {
  // Whitespace at the edges is common on hand-edited admin overrides and
  // CSV imports; the gate must trim before comparing.
  assert.equal(isAiDispatchUnit("  AI-DISPATCH  "), true);
  assert.equal(isAiDispatchUnit("\tai-dispatch\n"), true);
});

test("isAiDispatchUnit: returns false for any real radio unit id", () => {
  // Cross-check against the actual unit-id shapes the relay produces.
  // A regression that classified any of these as the AI unit would
  // silently drop a real officer's transmission with no dispatch
  // outcome and no incident created.
  for (const unit of [
    "27-040",
    "27-020",
    "27-000",
    "151",
    "352",
    "403",
    "BRIDGE-1",
    "DISP1",
    "USER42",
    "AI",
    "DISPATCH",
    "AI_DISPATCH", // underscore, not dash
    "AIDISPATCH", // no separator at all
    "AI-DISPATCHER", // trailing 'er'
  ]) {
    assert.equal(
      isAiDispatchUnit(unit),
      false,
      `expected real unit "${unit}" to NOT match the AI dispatch unit`,
    );
  }
});

test("isAiDispatchUnit: does NOT match a substring or prefix of the AI unit id", () => {
  // The check is full-string after normalization, not a substring search.
  // A future change that, say, swapped to `.startsWith(...)` for "tolerance"
  // would silently classify "AI-DISPATCH-2" as the AI unit and drop its
  // transmissions; pin the exact-match contract here.
  assert.equal(isAiDispatchUnit("AI-DISPATCH-2"), false);
  assert.equal(isAiDispatchUnit("AI-DISP"), false);
  assert.equal(isAiDispatchUnit("AI"), false);
});

// --- getAiDispatchPlatformConfig (defaults / cached singleton) -----------

test("getAiDispatchPlatformConfig: returns the documented defaults (env-free run)", () => {
  // The test runner doesn't set AI_DISPATCH_* env. The defaults committed
  // in platformConfig.ts must hold so a fresh server boot doesn't ship
  // surprise values to the live engine. (The function caches on first
  // call — these defaults are what every later call sees too.)
  const cfg = getAiDispatchPlatformConfig();
  assert.equal(typeof cfg.dispatchUnitId, "string");
  assert.ok(cfg.dispatchUnitId.length > 0, "dispatchUnitId must never be empty");
  // The fallback baked into the helper.
  assert.equal(cfg.dispatchUnitId, "AI-DISPATCH");
  // ENABLED must default to OFF — a fresh deploy with no env must NOT
  // start engaging the AI engine.
  assert.equal(cfg.enabled, false);
  // The default model is documented per-provider.
  assert.ok(["claude-sonnet-4-6", "gpt-4o-mini"].includes(cfg.llmModel));
  // The base URL must not have a trailing slash (paths concat without "//").
  assert.ok(!cfg.llmBaseUrl.endsWith("/"));
  // The prompt cache TTL is one of the two ElevenLabs-documented values.
  assert.ok(cfg.promptCacheTtl === "5m" || cfg.promptCacheTtl === "1h");
});

test("getAiDispatchPlatformConfig: returns the SAME object on repeated calls (singleton cache)", () => {
  // The config is process-cached intentionally so a hot-path call doesn't
  // re-read process.env on every transmission. Pin the singleton contract
  // explicitly — a regression that drops the cache would multiply the
  // env reads per transmission.
  const a = getAiDispatchPlatformConfig();
  const b = getAiDispatchPlatformConfig();
  assert.strictEqual(a, b, "expected the same cached singleton on repeated calls");
});

test("getAiDispatchPlatformStatus: never exposes the LLM API key (safe summary contract)", () => {
  // The admin UI calls this through GET /v1/admin/ai-dispatch/status; the
  // payload is rendered to operators (and shows up in browser dev tools).
  // The API key MUST stay platform-scoped — a regression that surfaced
  // it would leak credentials to any agency admin.
  const status = getAiDispatchPlatformStatus();
  const json = JSON.stringify(status);
  assert.ok(!Object.prototype.hasOwnProperty.call(status, "llmApiKey"));
  assert.ok(!json.includes("llmApiKey"));
  // The status MUST report whether a key is configured — without leaking it.
  assert.equal(typeof status.llmConfigured, "boolean");
});

test("getAiDispatchPlatformStatus: surfaces the dispatchUnitId so the admin UI can show 'AI talks as X'", () => {
  // The admin UI's "AI talks as <unit>" row is the *only* way an operator
  // sees what string the AI tags its transmissions with. A regression that
  // dropped this field hides the value that drives `isAiDispatchUnit`.
  const status = getAiDispatchPlatformStatus();
  assert.equal(typeof status.dispatchUnitId, "string");
  assert.equal(status.dispatchUnitId, getAiDispatchPlatformConfig().dispatchUnitId);
});

test("isAiDispatchUnit: matches the dispatchUnitId surfaced in the admin status payload", () => {
  // Belt-and-braces contract between the admin-visible status and the
  // engine-side gate: if an operator sees "AI talks as AI-DISPATCH", then
  // a transmission tagged "AI-DISPATCH" MUST be the one the engine skips.
  // The two values come from the same cached config, so they must stay
  // pinned to each other.
  const { dispatchUnitId } = getAiDispatchPlatformStatus();
  assert.equal(isAiDispatchUnit(dispatchUnitId), true);
});
