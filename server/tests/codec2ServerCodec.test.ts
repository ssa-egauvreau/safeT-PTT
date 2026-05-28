/**
 * Smoke test for `server/src/codec2ServerCodec.ts`.
 *
 * The server-side libcodec2 decoder lets the recorder produce a
 * transcribable PCM stream from Codec2 frames without depending on the
 * clear-PCM sideband. The decoder shares a WASM artifact with the web
 * console; this test verifies the Node runtime can load it and decode a
 * round-tripped frame back to PCM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initServerCodec2, createCodec2Decoder } from "../src/codec2ServerCodec.js";

test("initServerCodec2: loads the libcodec2 WASM module and reports ready", async () => {
  const ok = await initServerCodec2();
  assert.equal(ok, true);
});

test("createCodec2Decoder: produces 16 kHz PCM (640 bytes) from a 10-byte framed packet", async () => {
  await initServerCodec2();
  const decoder = createCodec2Decoder();
  assert.notEqual(decoder, null);
  if (!decoder) return;

  try {
    // Synthesize a plausible codec2 frame: 2-byte magic (0xC2 0x01) + 8
    // zero bytes. A real codeword has non-zero structure, but the decoder
    // is robust to any 8-byte input (codec2 is robust to bit errors by
    // design) and produces a valid PCM frame.
    const framed = Buffer.alloc(10);
    framed[0] = 0xc2;
    framed[1] = 0x01;
    const decoded = decoder.decode(framed);
    assert.notEqual(decoded, null);
    if (!decoded) return;
    // 160 samples @ 8 kHz, doubled to 320 samples @ 16 kHz, × 2 bytes/sample.
    assert.equal(decoded.length, 640);
  } finally {
    decoder.free();
  }
});

test("createCodec2Decoder: rejects malformed frame sizes", async () => {
  await initServerCodec2();
  const decoder = createCodec2Decoder();
  if (!decoder) {
    assert.fail("decoder should be available after initServerCodec2 returned true");
    return;
  }
  try {
    // Wrong magic / wrong size — recorder shouldn't pass these in, but
    // verify the decoder rejects them cleanly rather than crashing on a
    // truncated read.
    assert.equal(decoder.decode(Buffer.alloc(0)), null);
    assert.equal(decoder.decode(Buffer.from([0xc2, 0x01, 0x00])), null); // too short
    assert.equal(decoder.decode(Buffer.alloc(20)), null); // too long
  } finally {
    decoder.free();
  }
});

test("createCodec2Decoder: free() can be called multiple times safely", async () => {
  await initServerCodec2();
  const decoder = createCodec2Decoder();
  if (!decoder) {
    assert.fail("decoder should be available after initServerCodec2 returned true");
    return;
  }
  decoder.free();
  decoder.free(); // idempotent — must not double-free the native state
  assert.equal(decoder.decode(Buffer.alloc(10)), null); // decode after free returns null
});
