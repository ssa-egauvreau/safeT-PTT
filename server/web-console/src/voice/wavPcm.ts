/** Minimal PCM-16 WAV helpers — matches `server/src/wav.ts` layout. */

const WAV_HEADER_BYTES = 44;

/** Linear-interpolation resample for mono Int16 PCM. */
export function resamplePcm16(
  input: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) {
    return input;
  }
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = (i * fromRate) / toRate;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[Math.min(idx, input.length - 1)] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/**
 * Reads sample rate + mono PCM-16 from a RIFF/WAVE blob. Uses the file header
 * (not `decodeAudioData`) so vocoder preview stays at the recorder's rate even
 * when the browser would resample to 48 kHz.
 */
export function parseWavPcm16(buffer: ArrayBuffer): { pcm: Int16Array; sampleRate: number } {
  if (buffer.byteLength < WAV_HEADER_BYTES) {
    throw new Error("Invalid WAV: file too short");
  }
  const view = new DataView(buffer);
  const riff = readAscii(view, 0, 4);
  const wave = readAscii(view, 8, 4);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV: not RIFF/WAVE");
  }

  let sampleRate = 16_000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = WAV_HEADER_BYTES;
  let dataLen = Math.max(0, buffer.byteLength - WAV_HEADER_BYTES);

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (id === "fmt " && size >= 16 && chunkStart + 16 <= buffer.byteLength) {
      const audioFormat = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
      if (audioFormat !== 1) {
        throw new Error(`Unsupported WAV format (expected PCM, got ${audioFormat})`);
      }
      if (channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV layout (${channels} ch, ${bitsPerSample}-bit)`);
      }
    } else if (id === "data") {
      dataStart = chunkStart;
      dataLen = size;
      break;
    }
    offset = chunkStart + size + (size % 2);
  }

  dataLen = Math.min(dataLen, buffer.byteLength - dataStart);
  const sampleCount = Math.floor(dataLen / 2);
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(dataStart + i * 2, true);
  }
  return { pcm, sampleRate };
}

/** Parses a transmission WAV and returns 16 kHz mono PCM for the IMBE roundtrip. */
export function pcm16kFromTransmissionWav(buffer: ArrayBuffer): Int16Array {
  const { pcm, sampleRate } = parseWavPcm16(buffer);
  if (sampleRate === 16_000) {
    return pcm;
  }
  return resamplePcm16(pcm, sampleRate, 16_000);
}

function readAscii(view: DataView, offset: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}
