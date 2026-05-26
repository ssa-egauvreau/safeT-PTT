// Transmit-side conditioning for the P25 IMBE (vocoder) uplink.
//
// IMBE is an 8 kHz, ~5 kbps speech codec with no comfort-noise model: it spends
// its bit budget encoding whatever the mic picks up, so steady room/handling
// noise rides along with every transmission and quiet talkers stay quiet. This
// stage runs on the 16 kHz mic frames *before* the 8 kHz downsample and:
//   1. high-passes out low-frequency rumble / mains hum / handling thumps,
//   2. band-limits to the speech band (also the anti-alias filter for 8 kHz),
//   3. ducks background between words via an adaptive noise-floor expander,
//   4. lifts the spoken voice toward a consistent level (makeup AGC).
//
// One instance per transmit stream; call reset() at key-up so each talk-spurt
// re-learns its own noise floor and opens from silence.

const FS = 16000;

/** Transposed-direct-form-II biquad; RBJ-cookbook high/low-pass coefficients. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private static make(kind: "hp" | "lp", fc: number, q: number): Biquad {
    const w0 = (2 * Math.PI * fc) / FS;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    let b0: number;
    let b1: number;
    let b2: number;
    if (kind === "hp") {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
    } else {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    const f = new Biquad();
    f.b0 = b0 / a0;
    f.b1 = b1 / a0;
    f.b2 = b2 / a0;
    f.a1 = a1 / a0;
    f.a2 = a2 / a0;
    return f;
  }

  static highpass(fc: number, q: number): Biquad {
    return Biquad.make("hp", fc, q);
  }

  static lowpass(fc: number, q: number): Biquad {
    return Biquad.make("lp", fc, q);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

// Speech-band shaping. 180 Hz high-pass kills HVAC/engine rumble and handling
// thumps; 3.4 kHz low-pass is both the telephone-band edge and the anti-alias
// filter for the downstream 8 kHz IMBE rate.
const HPF_HZ = 180;
const LPF_HZ = 3400;
const FILTER_Q = 0.707;

// Envelope follower (instantaneous level), in int16 sample units.
const ENV_ATTACK = 0.03; // ~2 ms — react to onsets fast
const ENV_RELEASE = 0.0008; // ~80 ms — smooth decay so word tails survive

// Adaptive noise-floor tracker: rises slowly toward steady noise, falls quicker
// so it re-locks after a loud passage without chasing speech upward.
const FLOOR_UP = 0.00006;
const FLOOR_DOWN = 0.001;
const FLOOR_MIN = 60;
const FLOOR_MAX = 5000;

// Noise gate / downward expander. Speech is "present" once the envelope sits a
// few dB above the noise floor; below that the signal is squelched toward
// GATE_FLOOR_GAIN (a soft -20 dB, not a hard mute, to avoid pumping).
const GATE_OPEN_RATIO = 3.0;
const GATE_ABS_MIN = 180;
const GATE_FLOOR_GAIN = 0.1;
const GATE_OPEN_COEF = 0.05; // fast open (~1-2 ms)
const GATE_CLOSE_COEF = 0.0015; // slow close (~40 ms)

// Makeup AGC: pull the speech RMS toward a target without exceeding a peak that
// would clip after gain. Adapts gently up, instantly down.
const TARGET_RMS = 6000;
const MAX_GAIN = 6;
const PEAK_CEIL = 30000;
const AGC_RAMP = 0.01; // per-sample glide of applied gain toward target
const AGC_UP_FRACTION = 0.1; // per-frame cap on upward target movement
const MIN_SPEECH_SAMPLES = 32;

const SOFT_KNEE = 27800; // ~0.85 full-scale; soft-limit excess above this

function softLimit(sample: number): number {
  if (sample > SOFT_KNEE) {
    const compressed = SOFT_KNEE + (sample - SOFT_KNEE) * 0.3;
    return compressed > 32760 ? 32760 : compressed;
  }
  if (sample < -SOFT_KNEE) {
    const compressed = -SOFT_KNEE + (sample + SOFT_KNEE) * 0.3;
    return compressed < -32760 ? -32760 : compressed;
  }
  return sample;
}

export class ImbeTxConditioner {
  private readonly hpf = Biquad.highpass(HPF_HZ, FILTER_Q);
  private readonly lpf = Biquad.lowpass(LPF_HZ, FILTER_Q);
  private env = 0;
  private floor = FLOOR_MIN;
  private gateGain = 0; // start closed so pre-speech noise is squelched
  private agcGain = 1;
  private agcTarget = 1;

  /** Clears all adaptive state; call at key-up so each transmission starts fresh. */
  reset(): void {
    this.hpf.reset();
    this.lpf.reset();
    this.env = 0;
    this.floor = FLOOR_MIN;
    this.gateGain = 0;
    this.agcGain = 1;
    this.agcTarget = 1;
  }

  /**
   * Conditions one 16 kHz mono PCM-16 frame in place, ready for IMBE encoding.
   *
   * When `bypassExpanderAgc` is true, only the HPF (rumble cut) and LPF (IMBE
   * anti-alias) run, plus the soft limit. The expander/noise-gate and makeup
   * AGC are skipped — closest match to how a hardware P25 radio's mic chain
   * sounds (and to how our radio-bridge captures audio with browser AGC/NS off).
   */
  process(frame: Int16Array, bypassExpanderAgc = false): void {
    if (bypassExpanderAgc) {
      for (let i = 0; i < frame.length; i++) {
        frame[i] = softLimit(this.lpf.process(this.hpf.process(frame[i])));
      }
      return;
    }

    let speechSq = 0;
    let speechN = 0;
    let peakAbs = 0;

    for (let i = 0; i < frame.length; i++) {
      const filtered = this.lpf.process(this.hpf.process(frame[i]));
      const level = Math.abs(filtered);

      this.env += (level - this.env) * (level > this.env ? ENV_ATTACK : ENV_RELEASE);
      this.floor += (this.env - this.floor) * (this.env < this.floor ? FLOOR_DOWN : FLOOR_UP);
      if (this.floor < FLOOR_MIN) {
        this.floor = FLOOR_MIN;
      } else if (this.floor > FLOOR_MAX) {
        this.floor = FLOOR_MAX;
      }

      const openThresh = Math.max(GATE_ABS_MIN, this.floor * GATE_OPEN_RATIO);
      let gateTarget: number;
      if (this.env >= openThresh) {
        gateTarget = 1;
        speechSq += filtered * filtered;
        speechN++;
      } else {
        const r = this.env / openThresh;
        gateTarget = Math.max(GATE_FLOOR_GAIN, r * r);
      }
      this.gateGain +=
        (gateTarget - this.gateGain) * (gateTarget > this.gateGain ? GATE_OPEN_COEF : GATE_CLOSE_COEF);

      this.agcGain += (this.agcTarget - this.agcGain) * AGC_RAMP;

      if (level > peakAbs) {
        peakAbs = level;
      }
      frame[i] = softLimit(filtered * this.agcGain * this.gateGain);
    }

    this.updateAgcTarget(speechSq, speechN, peakAbs);
  }

  private updateAgcTarget(speechSq: number, speechN: number, peakAbs: number): void {
    if (speechN < MIN_SPEECH_SAMPLES) {
      return; // no speech this frame — hold gain steady
    }
    const rms = Math.sqrt(speechSq / speechN);
    let target = rms > 1 ? TARGET_RMS / rms : MAX_GAIN;
    if (target > MAX_GAIN) {
      target = MAX_GAIN;
    }
    // Never let makeup gain push the loudest sample past the soft-limit knee.
    const peakLimit = peakAbs > 1 ? PEAK_CEIL / peakAbs : MAX_GAIN;
    if (target > peakLimit) {
      target = peakLimit;
    }
    if (target < 1) {
      target = 1;
    }
    if (target < this.agcTarget) {
      this.agcTarget = target; // drop instantly to stay clear of clipping
    } else {
      this.agcTarget += Math.min(target - this.agcTarget, AGC_UP_FRACTION * this.agcTarget);
    }
  }
}
