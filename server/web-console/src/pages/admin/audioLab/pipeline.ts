// Audio Lab processing pipeline. Operates on Int16 PCM @ 16 kHz mono, end-to-end:
//   raw mic clip → pre-IMBE conditioning → IMBE encode/decode (or bypass) → post-decode shaping
// Everything runs in plain JS so a 10-second clip stays well under a frame budget. Mirrors
// the production TX/RX paths (imbeTxConditioner.ts, imbeVocoder.ts) so the lab's "Default"
// preset reproduces what a real talker would sound like today.

import { ImbeTxConditioner } from "../../../voice/imbeTxConditioner";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "../../../voice/imbeVocoder";

/** Worklet frame length the production capture path emits — 40 ms @ 16 kHz. The TX
 *  conditioner's adaptive AGC / gate update once per frame, so running the lab's
 *  "live settings" pipeline in the same chunk size keeps the behaviour faithful. */
const PRODUCTION_FRAME_16K = 640;

const FS = 16_000;

export type UpsampleMode = "duplicate" | "linear" | "polyphase";

export interface AudioLabConfig {
  preImbe: {
    hpfEnabled: boolean;
    hpfHz: number;
    lpfEnabled: boolean;
    lpfHz: number;
    agcEnabled: boolean;
    agcTargetRms: number;
    agcMaxGain: number;
  };
  vocoder: {
    bypass: boolean;
  };
  postDecode: {
    upsampleMode: UpsampleMode;
    hpfEnabled: boolean;
    hpfHz: number;
    lpfEnabled: boolean;
    lpfHz: number;
    highShelfEnabled: boolean;
    highShelfHz: number;
    highShelfDb: number;
  };
}

/** RBJ-cookbook biquad — direct-form-II transposed. Identical math to the
 *  TX-side Biquad class so the same coefficients give the same sound. */
class Biquad {
  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  private z1 = 0;
  private z2 = 0;

  static highpass(fc: number, q: number, fs: number): Biquad {
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad(
      (1 + cw) / 2 / a0,
      -(1 + cw) / a0,
      (1 + cw) / 2 / a0,
      (-2 * cw) / a0,
      (1 - alpha) / a0,
    );
  }

  static lowpass(fc: number, q: number, fs: number): Biquad {
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad(
      (1 - cw) / 2 / a0,
      (1 - cw) / a0,
      (1 - cw) / 2 / a0,
      (-2 * cw) / a0,
      (1 - alpha) / a0,
    );
  }

  /** RBJ high-shelf. Positive gainDb lifts the top end, negative cuts. */
  static highshelf(fc: number, gainDb: number, fs: number): Biquad {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    // shelf "S" = 1 → β = sqrt(A); avoids the Q knob for shelving (cleaner UI).
    const beta = Math.sqrt(A);
    const a0 = A + 1 - (A - 1) * cw + beta * sw;
    return new Biquad(
      (A * (A + 1 + (A - 1) * cw + beta * sw)) / a0,
      (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
      (A * (A + 1 + (A - 1) * cw - beta * sw)) / a0,
      (2 * (A - 1 - (A + 1) * cw)) / a0,
      (A + 1 - (A - 1) * cw - beta * sw) / a0,
    );
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function clamp16(x: number): number {
  return x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x);
}

function applyBiquadInPlace(pcm: Int16Array, biquad: Biquad): void {
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = clamp16(biquad.process(pcm[i]));
  }
}

/** Simple RMS-target AGC. One-pass — applies a single gain to the whole clip so the
 *  user hears a consistent level regardless of how loud they recorded. Production TX
 *  conditioner uses a more elaborate per-frame AGC; here we just need "loud enough." */
function applyClipAgc(pcm: Int16Array, targetRms: number, maxGain: number): void {
  if (pcm.length === 0) {
    return;
  }
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    sumSq += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  if (rms < 1) {
    return; // pure silence — nothing to lift
  }
  let gain = targetRms / rms;
  if (gain > maxGain) gain = maxGain;
  if (gain < 1) gain = 1; // never attenuate, only lift
  // Headroom check: don't allow gain that would clip the peak past full-scale.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const peakLimit = 30000 / peak;
    if (gain > peakLimit) gain = peakLimit;
  }
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = clamp16(pcm[i] * gain);
  }
}

/** 16 kHz → 8 kHz by sample-pair averaging (matches encodeImbeFrames). */
function downsample16To8(pcm16k: Int16Array): Int16Array {
  const out = new Int16Array(pcm16k.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = (pcm16k[2 * i] + pcm16k[2 * i + 1]) >> 1;
  }
  return out;
}

/** Sample-duplicate upsample — the production default. Aliases in the high band, gives
 *  IMBE that characteristic "crunchy" top end. Kept so the lab can demonstrate the gap. */
function upsampleDup8To16(pcm8k: Int16Array): Int16Array {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    out[i * 2] = pcm8k[i];
    out[i * 2 + 1] = pcm8k[i];
  }
  return out;
}

/** Linear-interpolation upsample: insert the midpoint between each sample. One-sample
 *  carryover keeps frame boundaries seamless. Cheap and removes most of the duplicate
 *  upsample's aliasing crunch — the cheapest quality win available. */
function upsampleLinear8To16(pcm8k: Int16Array): Int16Array {
  const out = new Int16Array(pcm8k.length * 2);
  let prev = pcm8k[0] ?? 0;
  for (let i = 0; i < pcm8k.length; i++) {
    const curr = pcm8k[i];
    out[i * 2] = (prev + curr) >> 1;
    out[i * 2 + 1] = curr;
    prev = curr;
  }
  return out;
}

/** Polyphase upsample using a small windowed-sinc kernel. Properly anti-aliased — the
 *  cleanest of the three modes. 33-tap kernel with Hann window at fc=Fs/4 is a sweet
 *  spot for 8→16 kHz: tight stopband, modest CPU. */
function upsamplePolyphase8To16(pcm8k: Int16Array): Int16Array {
  const KERNEL = polyphaseKernel();
  const HALF = (KERNEL.length - 1) >> 1; // 16 — equal taps each side of centre
  const out = new Int16Array(pcm8k.length * 2);
  // For each output sample at twice the rate, pick odd/even kernel phase.
  for (let n = 0; n < out.length; n++) {
    const phase = n & 1; // 0 = aligned with input sample, 1 = midpoint
    const centreIn = n >> 1;
    let acc = 0;
    if (phase === 0) {
      acc = pcm8k[centreIn] ?? 0;
    } else {
      // Convolve with the kernel's odd-indexed taps (the "between-sample" phase).
      for (let k = -HALF; k <= HALF; k++) {
        const inIdx = centreIn + k;
        const sample = inIdx >= 0 && inIdx < pcm8k.length ? pcm8k[inIdx] : 0;
        acc += sample * KERNEL[k + HALF];
      }
    }
    out[n] = clamp16(acc);
  }
  return out;
}

let cachedKernel: Float32Array | null = null;
function polyphaseKernel(): Float32Array {
  if (cachedKernel) return cachedKernel;
  const N = 33;
  const HALF = (N - 1) >> 1;
  const fc = 0.25; // normalised cutoff (Nyquist of the 8 kHz input, in 16 kHz units)
  const k = new Float32Array(N);
  let norm = 0;
  for (let i = 0; i < N; i++) {
    const x = i - HALF;
    let h: number;
    if (x === 0) {
      h = 2 * fc;
    } else {
      h = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    }
    // Hann window
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    k[i] = h * w;
    norm += k[i];
  }
  // Normalise so DC gain = 1 across the midpoint phase only (the even phase already
  // passes input samples through unchanged).
  for (let i = 0; i < N; i++) k[i] /= norm;
  cachedKernel = k;
  return cachedKernel;
}

/** Runs a recorded mic clip through the configured pipeline and returns the processed
 *  Int16 PCM at 16 kHz, ready to play through Web Audio or push onto a channel. */
export async function processClip(input: Int16Array, cfg: AudioLabConfig): Promise<Int16Array> {
  // --- Stage 1: pre-IMBE conditioning ---
  const conditioned = input.slice();
  if (cfg.preImbe.hpfEnabled) {
    applyBiquadInPlace(conditioned, Biquad.highpass(cfg.preImbe.hpfHz, 0.707, FS));
  }
  if (cfg.preImbe.lpfEnabled) {
    applyBiquadInPlace(conditioned, Biquad.lowpass(cfg.preImbe.lpfHz, 0.707, FS));
  }
  if (cfg.preImbe.agcEnabled) {
    applyClipAgc(conditioned, cfg.preImbe.agcTargetRms, cfg.preImbe.agcMaxGain);
  }

  // --- Stage 2: vocoder ---
  let postVocoder: Int16Array;
  if (cfg.vocoder.bypass) {
    postVocoder = conditioned;
  } else {
    if (!imbeReady()) {
      const ok = await initImbe();
      if (!ok) {
        throw new Error("IMBE vocoder unavailable — WASM failed to load");
      }
    }
    const pcm8k = downsample16To8(conditioned);
    const decoded8k = new Int16Array(pcm8k.length);
    let outOff = 0;
    for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
      const cw = imbeEncode(pcm8k.subarray(off, off + 160));
      if (!cw) continue;
      const dec = imbeDecode(cw);
      if (!dec) continue;
      decoded8k.set(dec, outOff);
      outOff += 160;
    }
    const decoded = decoded8k.subarray(0, outOff);
    postVocoder =
      cfg.postDecode.upsampleMode === "linear"
        ? upsampleLinear8To16(decoded)
        : cfg.postDecode.upsampleMode === "polyphase"
          ? upsamplePolyphase8To16(decoded)
          : upsampleDup8To16(decoded);
  }

  // --- Stage 3: post-decode shaping ---
  const shaped = postVocoder.slice();
  if (cfg.postDecode.hpfEnabled) {
    applyBiquadInPlace(shaped, Biquad.highpass(cfg.postDecode.hpfHz, 0.707, FS));
  }
  if (cfg.postDecode.lpfEnabled) {
    applyBiquadInPlace(shaped, Biquad.lowpass(cfg.postDecode.lpfHz, 0.707, FS));
  }
  if (cfg.postDecode.highShelfEnabled) {
    applyBiquadInPlace(
      shaped,
      Biquad.highshelf(cfg.postDecode.highShelfHz, cfg.postDecode.highShelfDb, FS),
    );
  }
  return shaped;
}

/** Runs a recorded clip through the EXACT production audio path — the real
 *  ImbeTxConditioner (adaptive AGC / gate / soft-limit), real IMBE encode/decode, and
 *  the live sample-duplicate upsample with no post-decode shaping. Use this for an
 *  honest A/B against any custom AudioLabConfig the user is trying. */
export async function processClipProduction(input: Int16Array): Promise<Int16Array> {
  if (!imbeReady()) {
    const ok = await initImbe();
    if (!ok) {
      throw new Error("IMBE vocoder unavailable — WASM failed to load");
    }
  }
  // Stage 1: production TX conditioner, frame-by-frame so the adaptive state evolves
  // the same way as a live keyup.
  const conditioned = input.slice();
  const cond = new ImbeTxConditioner();
  for (let off = 0; off < conditioned.length; off += PRODUCTION_FRAME_16K) {
    const end = Math.min(off + PRODUCTION_FRAME_16K, conditioned.length);
    cond.process(conditioned.subarray(off, end));
  }

  // Stage 2: 16 → 8 kHz, IMBE encode + decode.
  const pcm8k = downsample16To8(conditioned);
  const decoded8k = new Int16Array(pcm8k.length);
  let outOff = 0;
  for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
    const cw = imbeEncode(pcm8k.subarray(off, off + 160));
    if (!cw) continue;
    const dec = imbeDecode(cw);
    if (!dec) continue;
    decoded8k.set(dec, outOff);
    outOff += 160;
  }
  const decoded = decoded8k.subarray(0, outOff);

  // Stage 3: production RX — sample-duplicate upsample, no shaping, no EQ.
  return upsampleDup8To16(decoded);
}

/** Default preset — reproduces production behaviour today (IMBE round-trip,
 *  sample-duplicate upsample, no post-decode shaping). Starting point for A/B-ing tweaks. */
export const DEFAULT_PRESET: AudioLabConfig = {
  preImbe: {
    hpfEnabled: true,
    hpfHz: 180,
    lpfEnabled: true,
    lpfHz: 3400,
    agcEnabled: true,
    agcTargetRms: 6000,
    agcMaxGain: 6,
  },
  vocoder: {
    bypass: false,
  },
  postDecode: {
    upsampleMode: "duplicate",
    hpfEnabled: false,
    hpfHz: 250,
    lpfEnabled: false,
    lpfHz: 3300,
    highShelfEnabled: false,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

/** "Phase 2-ish" preset — linear (or polyphase) upsample + sharp telephony band-limit +
 *  small top-end softening. Closer to AMBE+2's character than bare IMBE. */
export const PHASE2_PRESET: AudioLabConfig = {
  preImbe: {
    hpfEnabled: true,
    hpfHz: 300,
    lpfEnabled: true,
    lpfHz: 3400,
    agcEnabled: true,
    agcTargetRms: 6000,
    agcMaxGain: 6,
  },
  vocoder: {
    bypass: false,
  },
  postDecode: {
    upsampleMode: "polyphase",
    hpfEnabled: true,
    hpfHz: 300,
    lpfEnabled: true,
    lpfHz: 3300,
    highShelfEnabled: true,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

/** Bypass preset — skip the vocoder entirely. Useful as a "clean reference" against
 *  which to compare any IMBE-flavoured preset. */
export const BYPASS_PRESET: AudioLabConfig = {
  preImbe: {
    hpfEnabled: true,
    hpfHz: 180,
    lpfEnabled: false,
    lpfHz: 3400,
    agcEnabled: true,
    agcTargetRms: 6000,
    agcMaxGain: 6,
  },
  vocoder: {
    bypass: true,
  },
  postDecode: {
    upsampleMode: "linear",
    hpfEnabled: false,
    hpfHz: 250,
    lpfEnabled: false,
    lpfHz: 3300,
    highShelfEnabled: false,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

export const BUILTIN_PRESETS: Record<string, AudioLabConfig> = {
  "Default IMBE": DEFAULT_PRESET,
  "Phase 2 voice": PHASE2_PRESET,
  Bypass: BYPASS_PRESET,
};
