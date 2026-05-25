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

export type UpsampleMode = "duplicate" | "linear" | "polyphase" | "polyphase24";

/** Sample rate of `processClip`'s output PCM under each upsample mode. The
 *  three 8 → 16 kHz modes return 16 kHz; "polyphase24" returns 16 kHz too,
 *  and the lab's playback path runs `upsamplePlayback16To24` as a final step
 *  so channel-push (which still wants 16 kHz for the 8 kHz IMBE wire) keeps
 *  working unchanged. */
export function outputSampleRate(mode: UpsampleMode): 16_000 | 24_000 {
  return mode === "polyphase24" ? 24_000 : 16_000;
}

export interface AudioLabConfig {
  preImbe: {
    windGateEnabled: boolean;
    /** Wind-band / voice-band RMS ratio (dB) above which the wind ducker engages.
     *  Higher = only the most lopsidedly wind-dominant frames trigger it. */
    windGateThresholdDb: number;
    /** How far to attenuate the wind band when the gate triggers (dB, negative). */
    windGateAttenuationDb: number;
    windHpfEnabled: boolean;
    windHpfHz: number;
    /** Filter order — 2, 4, or 6 (12 / 24 / 36 dB per octave). */
    windHpfOrder: 2 | 4 | 6;
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
    lowShelfEnabled: boolean;
    lowShelfHz: number;
    lowShelfDb: number;
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

  /** RBJ low-shelf. Positive gainDb lifts the bass below fc, negative cuts.
   *  Use a positive lift around 200 Hz to mimic the chest-thump bass that a real
   *  P25 mobile speaker amp adds on the RX side. */
  static lowshelf(fc: number, gainDb: number, fs: number): Biquad {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const beta = Math.sqrt(A);
    const a0 = A + 1 + (A - 1) * cw + beta * sw;
    return new Biquad(
      (A * (A + 1 - (A - 1) * cw + beta * sw)) / a0,
      (2 * A * (A - 1 - (A + 1) * cw)) / a0,
      (A * (A + 1 - (A - 1) * cw - beta * sw)) / a0,
      (-2 * (A - 1 + (A + 1) * cw)) / a0,
      (A + 1 + (A - 1) * cw - beta * sw) / a0,
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

/** Pole-pair Q values for cascaded-biquad Butterworth high-pass.
 *  Each row is a cascade of identical-cutoff biquads with these per-section Qs;
 *  the product gives a maximally-flat passband at the target order. */
const BUTTERWORTH_HPF_QS: Record<2 | 4 | 6, readonly number[]> = {
  2: [0.7071067811865475],
  4: [0.5411961001461969, 1.3065629648763766],
  6: [0.5176380902050415, 0.7071067811865475, 1.9318516525781364],
};

/** Cascaded high-pass — gives 12 / 24 / 36 dB-per-octave Butterworth roll-off
 *  for order 2 / 4 / 6. Used for wind reduction: a 4th-order HPF at 200 Hz kills
 *  rumble dead while leaving male voice fundamentals intact. */
function applyCascadedHpf(pcm: Int16Array, fc: number, order: 2 | 4 | 6, fs: number): void {
  for (const q of BUTTERWORTH_HPF_QS[order]) {
    applyBiquadInPlace(pcm, Biquad.highpass(fc, q, fs));
  }
}

/** Adaptive wind-band ducker. Splits the signal into a wind band (≤150 Hz) and a
 *  complementary voice band, then monitors their RMS ratio frame-by-frame. When
 *  the wind band dominates by more than `thresholdDb`, the wind band is attenuated
 *  by `attenuationDb` and summed back with the voice band. Smoothed gain transitions
 *  (5 ms attack / 50 ms release) keep voice intelligible — quiet passages don't get
 *  pumped, and the gate releases fast enough that talker breaths come through. */
function applyWindGate(
  pcm: Int16Array,
  thresholdDb: number,
  attenuationDb: number,
  fs: number,
): void {
  if (pcm.length === 0) return;
  const SPLIT_HZ = 150;
  const FRAME = 320; // 20 ms @ 16 kHz
  // Attack / release as one-pole smoothing coefficients on the per-frame target gain.
  // alpha = 1 - exp(-frameDur / tau)
  const FRAME_DUR_S = FRAME / fs;
  const attackAlpha = 1 - Math.exp(-FRAME_DUR_S / 0.005);
  const releaseAlpha = 1 - Math.exp(-FRAME_DUR_S / 0.05);
  const attenLinear = Math.pow(10, attenuationDb / 20);

  // Wind-band extractor: 2nd-order LPF @ 150 Hz. The complementary voice band is
  // just (input - lowOut), which preserves overall phase well enough for re-summing.
  const lp = Biquad.lowpass(SPLIT_HZ, 0.707, fs);

  let smoothedGain = 1;
  let frameLowSumSq = 0;
  let frameHighSumSq = 0;
  const lowBand = new Float32Array(FRAME);
  const highBand = new Float32Array(FRAME);

  for (let off = 0; off < pcm.length; off += FRAME) {
    const end = Math.min(off + FRAME, pcm.length);
    const len = end - off;
    frameLowSumSq = 0;
    frameHighSumSq = 0;
    for (let i = 0; i < len; i++) {
      const x = pcm[off + i];
      const lo = lp.process(x);
      const hi = x - lo;
      lowBand[i] = lo;
      highBand[i] = hi;
      frameLowSumSq += lo * lo;
      frameHighSumSq += hi * hi;
    }
    // Target gain based on this frame's band ratio. Add a small noise floor to
    // both bands so pure silence doesn't pick a random direction.
    const FLOOR = 16; // ≈ -66 dBFS, well below mic self-noise
    const lowRms = Math.sqrt(frameLowSumSq / len) + FLOOR;
    const highRms = Math.sqrt(frameHighSumSq / len) + FLOOR;
    const ratioDb = 20 * Math.log10(lowRms / highRms);
    const targetGain = ratioDb > thresholdDb ? attenLinear : 1;
    // One-pole smoothing: attack (gain dropping) is faster than release.
    const alpha = targetGain < smoothedGain ? attackAlpha : releaseAlpha;
    smoothedGain += alpha * (targetGain - smoothedGain);
    for (let i = 0; i < len; i++) {
      pcm[off + i] = clamp16(highBand[i] + lowBand[i] * smoothedGain);
    }
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

/** Playback-only 16 → 24 kHz polyphase upsample. 2:3 resample: for every two
 *  input samples we emit three output samples at phases 0/3, 1/3 (2/3 input
 *  position), and 2/3 (4/3 input position). The 8 kHz IMBE source is already
 *  band-limited well below the 12 kHz Nyquist of the 24 kHz output, so this
 *  stage doesn't need its own anti-alias filter — a windowed-sinc fractional
 *  interpolator is sufficient. Output buffer length is ceil(input * 3 / 2).
 *
 *  Used by the Audio Lab only — channel push and live voice keep the existing
 *  16 kHz path because the IMBE wire is fixed at 8 kHz regardless. */
export function upsamplePlayback16To24(pcm16k: Int16Array): Int16Array {
  const KERNEL = polyphase24Kernel();
  const HALF = (KERNEL[0].length - 1) >> 1;
  const outLen = Math.ceil((pcm16k.length * 3) / 2);
  const out = new Int16Array(outLen);
  for (let n = 0; n < outLen; n++) {
    // Output sample n sits at input position n * 2 / 3.
    const srcPos = (n * 2) / 3;
    const centreIn = Math.floor(srcPos);
    // Phase 0 → on-grid input; phases 1, 2 → fractional offsets 2/3 and 4/3.
    const phase = n % 3;
    if (phase === 0) {
      out[n] = pcm16k[centreIn] ?? 0;
      continue;
    }
    const taps = KERNEL[phase];
    let acc = 0;
    for (let k = -HALF; k <= HALF; k++) {
      const inIdx = centreIn + k;
      const sample = inIdx >= 0 && inIdx < pcm16k.length ? pcm16k[inIdx] : 0;
      acc += sample * taps[k + HALF];
    }
    out[n] = clamp16(acc);
  }
  return out;
}

let cached24Kernel: [Float32Array, Float32Array, Float32Array] | null = null;
function polyphase24Kernel(): [Float32Array, Float32Array, Float32Array] {
  if (cached24Kernel) return cached24Kernel;
  // 17-tap windowed-sinc per phase. Phase 0 is the identity (input sample passes
  // through), phases 1 and 2 sample the sinc at fractional offsets 2/3 and 4/3.
  // Cutoff is the 24 kHz output's effective Nyquist (8 kHz from the IMBE source
  // is the only spectrum that matters; nothing above it to alias).
  const N = 17;
  const HALF = (N - 1) >> 1;
  const fc = 0.5; // half-band cutoff at the 16 kHz input rate
  const phases: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(N), // phase 0 — unused but present so indices line up
    new Float32Array(N),
    new Float32Array(N),
  ];
  for (let phase = 1; phase < 3; phase++) {
    const offset = phase * (2 / 3); // 2/3 or 4/3
    let norm = 0;
    for (let i = 0; i < N; i++) {
      const x = i - HALF - offset;
      let h: number;
      if (Math.abs(x) < 1e-9) {
        h = 2 * fc;
      } else {
        h = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      }
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))); // Hann
      phases[phase][i] = h * w;
      norm += phases[phase][i];
    }
    for (let i = 0; i < N; i++) phases[phase][i] /= norm;
  }
  cached24Kernel = phases;
  return cached24Kernel;
}

/** Runs a recorded mic clip through the configured pipeline and returns the processed
 *  Int16 PCM at 16 kHz, ready to play through Web Audio or push onto a channel.
 *  (The "polyphase24" upsample mode also returns 16 kHz here — the lab's playback
 *  path runs `upsamplePlayback16To24` as a final step on its way to the DAC.) */
export async function processClip(input: Int16Array, cfg: AudioLabConfig): Promise<Int16Array> {
  // --- Stage 1: pre-IMBE conditioning ---
  const conditioned = input.slice();
  // Wind reduction runs first so the rest of the chain (HPF, LPF, AGC) sees a
  // signal with rumble / gust energy already suppressed. Gate before HPF: the
  // gate preserves low-band voice when voice is dominant, the HPF kills whatever
  // bass survives unconditionally.
  if (cfg.preImbe.windGateEnabled) {
    applyWindGate(
      conditioned,
      cfg.preImbe.windGateThresholdDb,
      cfg.preImbe.windGateAttenuationDb,
      FS,
    );
  }
  if (cfg.preImbe.windHpfEnabled) {
    applyCascadedHpf(conditioned, cfg.preImbe.windHpfHz, cfg.preImbe.windHpfOrder, FS);
  }
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
    // "polyphase24" uses the same 8→16 polyphase here; the 16→24 step happens at
    // playback time in the AudioLabPanel so channel-push stays at the 16 kHz
    // rate the rest of the system expects.
    postVocoder =
      cfg.postDecode.upsampleMode === "linear"
        ? upsampleLinear8To16(decoded)
        : cfg.postDecode.upsampleMode === "polyphase" ||
            cfg.postDecode.upsampleMode === "polyphase24"
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
  if (cfg.postDecode.lowShelfEnabled) {
    applyBiquadInPlace(
      shaped,
      Biquad.lowshelf(cfg.postDecode.lowShelfHz, cfg.postDecode.lowShelfDb, FS),
    );
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
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
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
    lowShelfEnabled: false,
    lowShelfHz: 200,
    lowShelfDb: 0,
    highShelfEnabled: false,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

/** "Phase 2-ish" preset — linear (or polyphase) upsample + sharp telephony band-limit +
 *  small top-end softening. Closer to AMBE+2's character than bare IMBE. */
export const PHASE2_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
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
    lowShelfEnabled: false,
    lowShelfHz: 200,
    lowShelfDb: 0,
    highShelfEnabled: true,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

/** Bypass preset — skip the vocoder entirely. Useful as a "clean reference" against
 *  which to compare any IMBE-flavoured preset. */
export const BYPASS_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
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
    lowShelfEnabled: false,
    lowShelfHz: 200,
    lowShelfDb: 0,
    highShelfEnabled: false,
    highShelfHz: 2500,
    highShelfDb: -2.5,
  },
};

/** "Deep P25 mobile" — emulates the chest-thump sound of a real P25 mobile radio
 *  speaker amp. Polyphase upsample kills the duplicate-mode static, no post-decode
 *  HPF lets bass through, and a +6 dB low-shelf around 200 Hz fakes the bass that
 *  a physical 4-inch dash speaker would push. A gentle high-shelf cut takes the
 *  remaining edginess off the vocoder. */
export const DEEP_MOBILE_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
    hpfEnabled: true,
    hpfHz: 120,
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
    hpfEnabled: false,
    hpfHz: 250,
    lpfEnabled: true,
    lpfHz: 3300,
    lowShelfEnabled: true,
    lowShelfHz: 200,
    lowShelfDb: 6,
    highShelfEnabled: true,
    highShelfHz: 2800,
    highShelfDb: -2,
  },
};

/** "Crisp dispatcher" — brighter, articulate sound for console-side listening.
 *  Polyphase upsample + a modest low-shelf lift for body + a small high-shelf
 *  boost to bring out consonants without re-introducing IMBE's harsh fizz. */
export const CRISP_DISPATCHER_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
    hpfEnabled: true,
    hpfHz: 180,
    lpfEnabled: true,
    lpfHz: 3500,
    agcEnabled: true,
    agcTargetRms: 6500,
    agcMaxGain: 6,
  },
  vocoder: {
    bypass: false,
  },
  postDecode: {
    upsampleMode: "polyphase",
    hpfEnabled: true,
    hpfHz: 150,
    lpfEnabled: false,
    lpfHz: 3300,
    lowShelfEnabled: true,
    lowShelfHz: 250,
    lowShelfDb: 3,
    highShelfEnabled: true,
    highShelfHz: 2500,
    highShelfDb: 2,
  },
};

/** "Warm portable" — soft, broadcast-y tone reminiscent of a quality handheld
 *  with the volume knob turned up. Polyphase + slight bass bump + audible
 *  high-shelf cut to roll off vocoder grit. */
export const WARM_PORTABLE_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: false,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: false,
    windHpfHz: 200,
    windHpfOrder: 4,
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
    upsampleMode: "polyphase",
    hpfEnabled: false,
    hpfHz: 250,
    lpfEnabled: true,
    lpfHz: 3200,
    lowShelfEnabled: true,
    lowShelfHz: 220,
    lowShelfDb: 4,
    highShelfEnabled: true,
    highShelfHz: 2400,
    highShelfDb: -4,
  },
};

/** "Windy mobile" — Deep-P25-mobile tone (polyphase upsample + low-shelf bass)
 *  paired with both wind defenses on: a 4th-order HPF at 200 Hz to nuke the
 *  steady-state rumble, plus the adaptive wind-band gate to catch the gusts a
 *  static HPF can't. Use this for officers in vehicles with the window down, or
 *  anyone on a portable in an exposed outdoor scene. */
export const WINDY_MOBILE_PRESET: AudioLabConfig = {
  preImbe: {
    windGateEnabled: true,
    windGateThresholdDb: 6,
    windGateAttenuationDb: -18,
    windHpfEnabled: true,
    windHpfHz: 200,
    windHpfOrder: 4,
    hpfEnabled: false,
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
    upsampleMode: "polyphase",
    hpfEnabled: false,
    hpfHz: 250,
    lpfEnabled: true,
    lpfHz: 3300,
    // Lower the low-shelf cutoff a bit — the 200 Hz wind HPF has already removed
    // most of what a shelf at 200 Hz would have touched, so push the bass boost
    // up into the 220-250 Hz range where it'll actually be audible.
    lowShelfEnabled: true,
    lowShelfHz: 240,
    lowShelfDb: 6,
    highShelfEnabled: true,
    highShelfHz: 2800,
    highShelfDb: -2,
  },
};

export const BUILTIN_PRESETS: Record<string, AudioLabConfig> = {
  "Default IMBE": DEFAULT_PRESET,
  "Phase 2 voice": PHASE2_PRESET,
  Bypass: BYPASS_PRESET,
  "Deep P25 mobile": DEEP_MOBILE_PRESET,
  "Crisp dispatcher": CRISP_DISPATCHER_PRESET,
  "Warm portable": WARM_PORTABLE_PRESET,
  "Windy mobile": WINDY_MOBILE_PRESET,
};
