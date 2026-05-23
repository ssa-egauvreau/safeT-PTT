/**
 * Tests for `server/src/wav.ts`.
 *
 * These two helpers wrap and unwrap the WAV container used for every
 * recorded radio transmission and every clip the on-server transcriber
 * sees. A regression in the header layout corrupts every recording the
 * agency archives (and breaks transcription) without any visible error
 * until someone tries to play one back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeWavToFloat32, encodeWavPcm16 } from "../src/wav.js";

const SR = 16_000;

function pcmFromSamples(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, i * 2);
  }
  return buf;
}

test("encodeWavPcm16: emits a well-formed RIFF/WAVE header", () => {
  const pcm = pcmFromSamples([0, 100, -100, 32000, -32000]);
  const wav = encodeWavPcm16(pcm, SR);

  assert.equal(wav.length, 44 + pcm.length, "total = 44-byte header + pcm");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");

  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "ChunkSize = 36 + dataLen");
  assert.equal(wav.readUInt32LE(16), 16, "fmt chunk size = 16");
  assert.equal(wav.readUInt16LE(20), 1, "audio format = PCM (1)");
  assert.equal(wav.readUInt16LE(22), 1, "channels = mono (1)");
  assert.equal(wav.readUInt32LE(24), SR, "sample rate echoed");
  assert.equal(wav.readUInt32LE(28), SR * 2, "byte rate = SR * 2 (16-bit mono)");
  assert.equal(wav.readUInt16LE(32), 2, "block align = 2");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample = 16");
  assert.equal(wav.readUInt32LE(40), pcm.length, "Subchunk2Size = pcm length");
});

test("encodeWavPcm16: empty PCM still produces a valid 44-byte header", () => {
  const wav = encodeWavPcm16(Buffer.alloc(0), SR);
  assert.equal(wav.length, 44);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(40), 0);
});

test("encodeWavPcm16 → decodeWavToFloat32 round-trips to normalized Float32 samples", () => {
  // Pick samples that exercise both extremes and a couple of midpoints.
  const samples = [0, 1000, -1000, 16384, -16384, 32767, -32768];
  const wav = encodeWavPcm16(pcmFromSamples(samples), SR);
  const out = decodeWavToFloat32(wav);

  assert.equal(out.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    // The decoder divides by 32768 — verify the same.
    const expected = samples[i]! / 32768;
    assert.ok(
      Math.abs(out[i]! - expected) < 1e-9,
      `sample ${i}: got ${out[i]} expected ${expected}`,
    );
  }
});

test("decodeWavToFloat32: skips an unknown subchunk before 'data'", () => {
  // Build a WAV manually with an extra "LIST" subchunk between fmt and data
  // (some recording stacks emit one). The decoder must walk past it.
  const pcm = pcmFromSamples([100, -100, 200, -200]);
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(SR, 12);
  fmt.writeUInt32LE(SR * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  // Use an even-length payload so we don't have to think about the trailing
  // padding byte that RIFF requires for odd-size chunks.
  const extraPayload = Buffer.from("INFOIART safeT-PTT", "ascii");
  assert.equal(extraPayload.length % 2, 0, "test fixture must be even-length");
  const extra = Buffer.alloc(8 + extraPayload.length);
  extra.write("LIST", 0, "ascii");
  extra.writeUInt32LE(extraPayload.length, 4);
  extraPayload.copy(extra, 8);

  const data = Buffer.alloc(8 + pcm.length);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(pcm.length, 4);
  pcm.copy(data, 8);

  const riffPayload = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    fmt,
    extra,
    data,
  ]);
  const wav = Buffer.alloc(8 + riffPayload.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(riffPayload.length, 4);
  riffPayload.copy(wav, 8);

  const out = decodeWavToFloat32(wav);
  assert.equal(out.length, 4);
  assert.ok(Math.abs(out[0]! - 100 / 32768) < 1e-9);
  assert.ok(Math.abs(out[1]! - -100 / 32768) < 1e-9);
});

test("decodeWavToFloat32: clamps a dataLen that overshoots the buffer", () => {
  const samples = [0, 1, -1];
  const pcm = pcmFromSamples(samples);
  const wav = encodeWavPcm16(pcm, SR);
  // Forge a too-large data size in the header — the decoder must clamp to
  // what's actually in the buffer rather than reading past the end.
  wav.writeUInt32LE(pcm.length + 10_000, 40);
  const out = decodeWavToFloat32(wav);
  assert.equal(out.length, samples.length);
});
