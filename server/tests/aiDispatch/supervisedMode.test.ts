/**
 * Tests for `server/src/aiDispatch/supervisedMode.ts`.
 *
 * Supervised mode is the keyword-gated middle setting between OFF and full-auto:
 * the dispatcher only engages when a transmission opens with the wake word "AI".
 * A false positive here means she barges onto the air on ordinary chatter; a
 * false negative means she ignores a unit who correctly addressed her.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aiDispatchModeEnabled,
  DEFAULT_WAKE_WORD,
  hasSupervisedWakeWord,
  normalizeAiDispatchMode,
  normalizeWakeHint,
  normalizeWakeWord,
  stripSupervisedWakeWord,
} from "../../src/aiDispatch/supervisedMode.js";

test("normalizeAiDispatchMode: maps strings, legacy booleans, and junk", () => {
  assert.equal(normalizeAiDispatchMode("supervised"), "supervised");
  assert.equal(normalizeAiDispatchMode("full_auto"), "full_auto");
  assert.equal(normalizeAiDispatchMode("full-auto"), "full_auto");
  assert.equal(normalizeAiDispatchMode("off"), "off");
  assert.equal(normalizeAiDispatchMode(true), "full_auto"); // legacy enabled=true
  assert.equal(normalizeAiDispatchMode(false), "off");
  assert.equal(normalizeAiDispatchMode("on"), "full_auto");
  assert.equal(normalizeAiDispatchMode("garbage"), "off");
  assert.equal(normalizeAiDispatchMode(undefined), "off");
});

test("aiDispatchModeEnabled: only off is disabled", () => {
  assert.equal(aiDispatchModeEnabled("off"), false);
  assert.equal(aiDispatchModeEnabled("supervised"), true);
  assert.equal(aiDispatchModeEnabled("full_auto"), true);
});

test("stripSupervisedWakeWord: strips the leading wake word in its STT variants", () => {
  assert.equal(stripSupervisedWakeWord("AI, 27-000 show me on a patrol check"), "27-000 show me on a patrol check");
  assert.equal(stripSupervisedWakeWord("AI 27-000 show me"), "27-000 show me");
  assert.equal(stripSupervisedWakeWord("A.I. run a plate"), "run a plate");
  assert.equal(stripSupervisedWakeWord("A I run a plate"), "run a plate");
  assert.equal(stripSupervisedWakeWord("Hey AI, what's the plate"), "what's the plate");
  assert.equal(stripSupervisedWakeWord("  ai 352 traffic stop"), "352 traffic stop");
});

test("stripSupervisedWakeWord: returns null when no wake word, and never on ordinary speech", () => {
  assert.equal(stripSupervisedWakeWord("27-000 show me on a patrol check"), null);
  assert.equal(stripSupervisedWakeWord("I see a vehicle"), null);
  assert.equal(stripSupervisedWakeWord("Aim for the exit"), null);
  assert.equal(stripSupervisedWakeWord("eye on the suspect"), null);
});

test("hasSupervisedWakeWord mirrors strip", () => {
  assert.equal(hasSupervisedWakeWord("AI, run a plate"), true);
  assert.equal(hasSupervisedWakeWord("run a plate"), false);
});

test("default wake word is 'hey ai' and keeps the tolerant AI-family matcher", () => {
  assert.equal(DEFAULT_WAKE_WORD, "hey ai");
  // explicit "hey ai" / "ai" behave like the default (no regression for existing channels).
  assert.equal(stripSupervisedWakeWord("AI go", "hey ai"), "go");
  assert.equal(stripSupervisedWakeWord("hey AI go", "ai"), "go");
});

test("normalizeWakeWord trims, lowercases, collapses whitespace", () => {
  assert.equal(normalizeWakeWord("  Hey   AI "), "hey ai");
  assert.equal(normalizeWakeWord("DISPATCH"), "dispatch");
  assert.equal(normalizeWakeWord(123 as unknown), "");
  assert.equal(normalizeWakeWord(null), "");
});

test("a custom phrase matches its tokens at the start, with optional leading 'hey'", () => {
  assert.equal(stripSupervisedWakeWord("dispatch, start a call", "dispatch"), "start a call");
  assert.equal(stripSupervisedWakeWord("hey dispatch start a call", "dispatch"), "start a call");
  assert.equal(stripSupervisedWakeWord("I see a vehicle", "dispatch"), null);
  assert.equal(hasSupervisedWakeWord("dispatch run a plate", "dispatch"), true);
});

test("a multi-word custom phrase tolerates flexible separators", () => {
  assert.equal(stripSupervisedWakeWord("hey dispatch one 27-000", "dispatch one"), "27-000");
  assert.equal(stripSupervisedWakeWord("dispatch-one 27-000", "dispatch one"), "27-000");
  assert.equal(stripSupervisedWakeWord("dispatch two 27-000", "dispatch one"), null);
});

test("bare wake word with no body returns empty string (engaged), blank config falls back to default", () => {
  assert.equal(stripSupervisedWakeWord("dispatch", "dispatch"), "");
  assert.equal(stripSupervisedWakeWord("AI go", "   "), "go");
});

test("normalizeWakeHint accepts only the three known hints, else undefined", () => {
  assert.equal(normalizeWakeHint("clear"), "clear");
  assert.equal(normalizeWakeHint(" MAYBE "), "maybe");
  assert.equal(normalizeWakeHint("none"), "none");
  assert.equal(normalizeWakeHint("nope"), undefined);
  assert.equal(normalizeWakeHint(""), undefined);
  assert.equal(normalizeWakeHint(undefined), undefined);
  assert.equal(normalizeWakeHint(42 as unknown), undefined);
});
