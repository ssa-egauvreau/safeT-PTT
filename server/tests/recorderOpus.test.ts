/**
 * Recorder relies on clear-PCM sideband for Opus until a server Opus decoder exists.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectFrameCodec } from "../src/voiceCodecs.js";

describe("recorder Opus path", () => {
  test("Opus wire magic is detected for routing", () => {
    const frame = Buffer.from([0x4f, 0x70, 0x01, 0x02]);
    assert.equal(detectFrameCodec(frame), "opus");
  });
});
