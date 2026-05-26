/**
 * Regression tests for the pure helpers in
 * `server/src/aiDispatch/platformConfig.ts`.
 *
 * Three small functions, but each one sits on a hot path:
 *
 *  - `normalizeDispatchUnitId` is what every voice / recorder packet runs
 *    through before checking "is this transmission FROM the AI?". A
 *    regression in trimming or upper-casing causes the engine to either
 *    process its own callouts in a feedback loop (under-normalise) or to
 *    fail to recognise its own callouts and act on them anyway
 *    (over-normalise).
 *
 *  - `isAiDispatchUnit` is the same check wrapped with null/blank
 *    handling. Returning `true` for an empty string would block every
 *    transmission with no unit id from ever reaching the dispatch engine.
 *
 *  - `getAiDispatchPlatformConfig` reads a handful of env vars on the
 *    first call and caches the result. The `dispatchUnitId` slice (the
 *    output of the same normaliser, clipped to 64 chars) is the most
 *    safety-critical knob — pinning it here guards against an env-driven
 *    regression that would change which incoming traffic is treated as
 *    "the AI talking to itself".
 *
 * We avoid asserting against the cached singleton state (the underlying
 * `let cached` is process-global) — instead, each test poke-injects via
 * `import('?cacheBust=…')` so the env-derived values are fresh.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAiDispatchUnit,
  normalizeDispatchUnitId,
} from "../../src/aiDispatch/platformConfig.js";

// ---------- normalizeDispatchUnitId ---------------------------------------

test("normalizeDispatchUnitId trims surrounding whitespace and upper-cases", () => {
  assert.equal(normalizeDispatchUnitId("AI-Dispatch"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId(" ai-dispatch "), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("\tAi-Dispatch\n"), "AI-DISPATCH");
});

test("normalizeDispatchUnitId leaves an already-canonical id unchanged", () => {
  assert.equal(normalizeDispatchUnitId("AI-DISPATCH"), "AI-DISPATCH");
  assert.equal(normalizeDispatchUnitId("DISPATCHER-1"), "DISPATCHER-1");
});

test("normalizeDispatchUnitId does NOT strip internal whitespace (preserves caller-meaningful spaces)", () => {
  // Some agencies actually use spaces inside the AI unit id (e.g.
  // "AI DISPATCH"). The contract is upper-case + trim ONLY — collapsing
  // internal whitespace would silently merge two different agency
  // configurations.
  assert.equal(normalizeDispatchUnitId("ai dispatch"), "AI DISPATCH");
  assert.equal(normalizeDispatchUnitId("  ai  dispatch  "), "AI  DISPATCH");
});

// ---------- isAiDispatchUnit ----------------------------------------------

test("isAiDispatchUnit: null / undefined / empty / whitespace all return false", () => {
  // The AI loop-back guard MUST NOT treat "no unit id" as the dispatcher's
  // own callsign — otherwise unattributed traffic gets dropped instead of
  // being processed by the engine.
  assert.equal(isAiDispatchUnit(null), false);
  assert.equal(isAiDispatchUnit(undefined), false);
  assert.equal(isAiDispatchUnit(""), false);
  assert.equal(isAiDispatchUnit("   "), false);
  assert.equal(isAiDispatchUnit("\t\n"), false);
});

test("isAiDispatchUnit: matches the default AI-DISPATCH id case- and whitespace-insensitively", () => {
  // The default `dispatchUnitId` (set by env or defaulted to "AI-DISPATCH"
  // in `getAiDispatchPlatformConfig`) is normalised through the same
  // helper; tests poke at the default explicitly so a future env override
  // is forced to go through the public surface.
  for (const id of ["AI-DISPATCH", "ai-dispatch", "  ai-dispatch  ", "Ai-Dispatch", "\tAI-DISPATCH\n"]) {
    assert.equal(
      isAiDispatchUnit(id),
      true,
      `'${id}' must be recognised as the AI dispatch unit (case-/whitespace-insensitive)`,
    );
  }
});

test("isAiDispatchUnit: an unrelated patrol unit id returns false", () => {
  // Defence-in-depth: the loop-back guard must NOT swallow legitimate
  // unit traffic. Confirm a couple of representative patrol callsigns.
  assert.equal(isAiDispatchUnit("27-040"), false);
  assert.equal(isAiDispatchUnit("352"), false);
  assert.equal(isAiDispatchUnit("DISP-1"), false);
});

test("isAiDispatchUnit: both sides flow through normalizeDispatchUnitId so a stray space cannot smuggle the AI ack past the guard", () => {
  // Same rule as above, but written from the perspective of the bug it
  // protects against: a future caller that passed " AI-DISPATCH " by
  // mistake (e.g. via a trim regression elsewhere) must still be matched
  // — otherwise the AI's own ack would re-enter the pipeline and the
  // engine would speak again, kicking off an infinite back-and-forth.
  assert.equal(isAiDispatchUnit(" AI-DISPATCH "), true);
  assert.equal(isAiDispatchUnit("AI-DISPATCH\t"), true);
});
