// Minimal WAV (PCM 16-bit) helpers for transmission recordings.

const WAV_HEADER_BYTES = 44;

/** Wraps raw 16-bit signed little-endian mono PCM in a WAV container. */
export function encodeWavPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reads a PCM-16 WAV back into normalized Float32 samples (for the transcriber). */
export function decodeWavToFloat32(wav: Buffer): Float32Array {
  let dataStart = WAV_HEADER_BYTES;
  let dataLen = Math.max(0, wav.length - WAV_HEADER_BYTES);

  // Walk subchunks to find "data" (handles any extra chunks before it).
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  dataLen = Math.min(dataLen, wav.length - dataStart);
  const sampleCount = Math.max(0, Math.floor(dataLen / 2));
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = wav.readInt16LE(dataStart + i * 2) / 32768;
  }
  return out;
}
