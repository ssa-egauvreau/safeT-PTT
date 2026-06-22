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
  hasSupervisedWakeWord,
  normalizeAiDispatchMode,
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
