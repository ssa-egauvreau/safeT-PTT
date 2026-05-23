/**
 * Tests for `server/src/aiDispatch/emergencyCodes.ts`.
 *
 * 10-33 / 10-34 detection is the belt-and-suspenders path that triggers (and
 * clears) emergency tones outside the LLM. A regression here can miss an
 * officer-down call, which is the worst-case failure for this product.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adaptDispatcherResponseForChannel,
  detectEmergencyCodeFromTranscript,
} from "../../src/aiDispatch/emergencyCodes.js";

test("detectEmergencyCodeFromTranscript: 10-33 in any form triggers activate", () => {
  const positives = [
    "10-33 10-33 officer down",
    "10 33 at the bank",
    "ten thirty three",
    "Ten-thirty-three",
    "we have a 10-33",
  ];
  for (const t of positives) {
    assert.equal(detectEmergencyCodeFromTranscript(t), "activate", t);
  }
});

test("detectEmergencyCodeFromTranscript: 10-34 in any form triggers clear", () => {
  const positives = [
    "10-34 clear the channel",
    "10 34",
    "ten thirty four",
    "Ten-thirty-four",
  ];
  for (const t of positives) {
    assert.equal(detectEmergencyCodeFromTranscript(t), "clear", t);
  }
});

test("detectEmergencyCodeFromTranscript: 10-34 wins when both codes appear (caller is clearing)", () => {
  // 10-34 is checked first so a transmission that references both
  // ("10-34, 10-33 resolved") is read as the clear — keeps us from
  // re-arming the tone after a clear.
  assert.equal(
    detectEmergencyCodeFromTranscript("10-34, prior 10-33 resolved"),
    "clear",
  );
});

test("detectEmergencyCodeFromTranscript: returns null when neither code is present", () => {
  assert.equal(detectEmergencyCodeFromTranscript("10-4 copy"), null);
  assert.equal(detectEmergencyCodeFromTranscript("standby"), null);
  assert.equal(detectEmergencyCodeFromTranscript(""), null);
  assert.equal(detectEmergencyCodeFromTranscript("   "), null);
});

test("detectEmergencyCodeFromTranscript: does not match the digits across a word boundary that isn't 10-33/34", () => {
  // "100-33" or "1033" without word-boundary 10-33 must NOT trigger.
  // The current pattern uses \b so a leading digit ("100-33") doesn't qualify
  // as 10-33 — guard against accidentally loosening the regex.
  assert.equal(detectEmergencyCodeFromTranscript("100-33 unit count"), null);
});

test("adaptDispatcherResponseForChannel rewrites 'green 1' to the active channel name", () => {
  assert.equal(
    adaptDispatcherResponseForChannel("Dispatch on green 1, copy", "OPS-2"),
    "Dispatch on OPS-2, copy",
  );
  assert.equal(
    adaptDispatcherResponseForChannel("green-1 is live", "OPS-2"),
    "OPS-2 is live",
  );
  assert.equal(
    adaptDispatcherResponseForChannel("GREEN 1 copies", "OPS-2"),
    "OPS-2 copies",
  );
});

test("adaptDispatcherResponseForChannel leaves the input alone when channel name is blank", () => {
  assert.equal(
    adaptDispatcherResponseForChannel("green 1 is live", ""),
    "green 1 is live",
  );
  assert.equal(
    adaptDispatcherResponseForChannel("green 1 is live", "   "),
    "green 1 is live",
  );
});
