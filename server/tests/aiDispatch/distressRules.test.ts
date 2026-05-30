import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyDistressDispatchRules,
  detectOfficerDistressFromTranscript,
} from "../../src/aiDispatch/distressRules.js";
import type { AiDispatchParseResult } from "../../src/aiDispatch/parse.js";

function parsed(over: Partial<AiDispatchParseResult> = {}): AiDispatchParseResult {
  return {
    actionable: false,
    intent: "unknown",
    unit: "27-334",
    summary: "",
    confidence: 0.5,
    dispatcher_response: "Copy.",
    trigger_emergency_tone: false,
    recommended_action: null,
    plate_request: null,
    code: null,
    location_code: null,
    location_name: null,
    info_request: null,
    comment_text: null,
    cad_person_link: null,
    cad_tag: null,
    cad_tag_remove: null,
    ...over,
  };
}

test("detectOfficerDistressFromTranscript: distress phrases", () => {
  const positives = [
    "334 shots fired at the lot",
    "I'm in a fight with two subjects",
    "im in a fight need backup",
    "I need help now",
    "we need code 3 assistance",
    "officer down at 1811",
    "send backup I'm being assaulted",
  ];
  for (const t of positives) {
    assert.equal(detectOfficerDistressFromTranscript(t), true, t);
  }
});

test("detectOfficerDistressFromTranscript: excludes CAD help context", () => {
  assert.equal(
    detectOfficerDistressFromTranscript("352 I need help with a plate lookup 912"),
    false,
  );
  assert.equal(
    detectOfficerDistressFromTranscript("can you run 968 I need help finding the subject"),
    false,
  );
});

test("detectOfficerDistressFromTranscript: 10-34 clears distress on same transmission", () => {
  assert.equal(detectOfficerDistressFromTranscript("10-34 all clear"), false);
});

test("applyDistressDispatchRules forces emergency intent", () => {
  const out = applyDistressDispatchRules(
    parsed({ intent: "chitchat" }),
    "27-334 shots fired",
  );
  assert.equal(out.intent, "emergency");
  assert.equal(out.trigger_emergency_tone, true);
  assert.equal(out.dispatcher_response, null);
});
