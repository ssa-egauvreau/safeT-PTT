/**
 * Smoke test for `server/src/ambeServerCodec.ts`.
 *
 * The server-side AMBE+2 half-rate decoder (the P25 Phase 2 / DMR vocoder
 * rate) lets the recorder produce a transcribable PCM stream from AMBE
 * frames without depending on the clear-PCM sideband. It shares the
 * dvmvocoder WASM artifact with the IMBE decoder; this test verifies the
 * Node runtime can load it and decode framed codewords back to PCM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initServerAmbe, createAmbeDecoder } from "../src/ambeServerCodec.js";

test("initServerAmbe: loads the dvmvocoder WASM module and reports ready", async () => {
  const ok = await initServerAmbe();
  assert.equal(ok, true);
});

test("createAmbeDecoder: produces 16 kHz PCM (640 bytes) from an 11-byte framed packet", async () => {
  await initServerAmbe();
  const decoder = createAmbeDecoder();
  assert.notEqual(decoder, null);
  if (!decoder) return;

  try {
    // Synthesize a plausible AMBE frame: 2-byte magic (0xA2 0x45) + 9-byte
    // DMR-interleaved codeword. A real codeword has non-zero structure, but
    // the decoder's FEC tolerates arbitrary input and still produces a valid
    // PCM frame (possibly silence).
    const framed = Buffer.alloc(11);
    framed[0] = 0xa2;
    framed[1] = 0x45;
    const decoded = decoder.decode(framed);
    assert.notEqual(decoded, null);
    if (!decoded) return;
    // 160 samples @ 8 kHz, doubled to 320 samples @ 16 kHz, × 2 bytes/sample.
    assert.equal(decoded.length, 640);
  } finally {
    decoder.free();
  }
});

test("createAmbeDecoder: rejects malformed frame sizes", async () => {
  await initServerAmbe();
  const decoder = createAmbeDecoder();
  if (!decoder) {
    assert.fail("decoder should be available after initServerAmbe returned true");
    return;
  }
  try {
    assert.equal(decoder.decode(Buffer.alloc(0)), null);
    assert.equal(decoder.decode(Buffer.from([0xa2, 0x45, 0x00])), null); // too short
    assert.equal(decoder.decode(Buffer.alloc(13)), null); // IMBE-sized frame, not AMBE
  } finally {
    decoder.free();
  }
});

test("createAmbeDecoder: free() can be called multiple times safely", async () => {
  await initServerAmbe();
  const decoder = createAmbeDecoder();
  if (!decoder) {
    assert.fail("decoder should be available after initServerAmbe returned true");
    return;
  }
  decoder.free();
  decoder.free(); // idempotent — must not double-free the native state
  assert.equal(decoder.decode(Buffer.alloc(11)), null); // decode after free returns null
});
