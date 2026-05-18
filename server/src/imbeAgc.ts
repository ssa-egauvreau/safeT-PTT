// Receive-side automatic gain control for decoded IMBE (P25) audio.
//
// Ported from the dvmvocoder MBEDecoder autoGain path — the same AGC the
// Android native build runs. Decoded IMBE frames otherwise play far quieter
// than uncompressed PCM; this normalises each talk-spurt toward a consistent
// level. One instance per decode stream: it keeps a rolling peak history.

const TARGET_PEAK = 30000;
const MAX_GAIN = 50;
const FRAME = 160;

export class ImbeAgc {
  private readonly peakHistory = new Float32Array(25);
  private historyIdx = 0;
  private gain = 1;

  /** Applies gain in place to one 160-sample (8 kHz) decoded IMBE frame. */
  process(frame: Int16Array): void {
    if (frame.length !== FRAME) {
      return;
    }

    let peak = 0;
    for (let n = 0; n < FRAME; n++) {
      const level = Math.abs(frame[n]);
      if (level > peak) {
        peak = level;
      }
    }

    this.peakHistory[this.historyIdx] = peak;
    this.historyIdx = this.historyIdx >= 24 ? 0 : this.historyIdx + 1;
    for (let i = 0; i < this.peakHistory.length; i++) {
      if (this.peakHistory[i] > peak) {
        peak = this.peakHistory[i];
      }
    }

    let target = peak > 0 ? TARGET_PEAK / peak : MAX_GAIN;
    let step: number;
    if (target < this.gain) {
      // Signal got louder — drop gain immediately to avoid clipping.
      this.gain = target;
      step = 0;
    } else {
      // Signal got quieter — ramp gain up by at most 5% per frame.
      if (target > MAX_GAIN) {
        target = MAX_GAIN;
      }
      step = Math.min(target - this.gain, 0.05 * this.gain);
    }
    step /= FRAME;

    for (let n = 0; n < FRAME; n++) {
      let smp = (this.gain + n * step) * frame[n];
      if (smp > 32760) {
        smp = 32760;
      } else if (smp < -32760) {
        smp = -32760;
      }
      frame[n] = smp;
    }
    this.gain += FRAME * step;
  }
}
