// AudioWorklet processor: resamples microphone audio to 16 kHz and emits
// 16-bit signed little-endian PCM frames (20 ms) for the voice relay.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = 16000;
    // `sampleRate` is a global supplied to the worklet (the AudioContext rate).
    this._step = sampleRate / this._targetRate;
    this._readPos = 0;
    this._frameSamples = 320; // 20 ms at 16 kHz — matches relay + Opus/IMBE/Codec2 cadence
    this._frame = new Int16Array(this._frameSamples);
    this._frameLen = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true;
    }
    let pos = this._readPos;
    while (pos < channel.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = channel[i];
      const b = i + 1 < channel.length ? channel[i + 1] : a;
      let sample = a + (b - a) * frac;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      this._frame[this._frameLen++] = sample < 0 ? (sample * 0x8000) | 0 : (sample * 0x7fff) | 0;
      if (this._frameLen === this._frameSamples) {
        const out = new Int16Array(this._frame);
        this.port.postMessage(out.buffer, [out.buffer]);
        this._frameLen = 0;
      }
      pos += this._step;
    }
    this._readPos = pos - channel.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
