// Browser voice client for one channel: joins the relay WebSocket, plays inbound
// PCM, and (when permitted) captures the microphone and transmits.

import { api, getToken, type Permission } from "../api";
import { ImbeTxConditioner } from "./imbeTxConditioner";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "./imbeVocoder";
import { codec2Decode, codec2Encode, codec2Ready, initCodec2 } from "./codec2Vocoder";
import { OpusWebDecoder } from "./opusDecoder";
import { OpusWebEncoder, opusEncoderAvailable } from "./opusEncoder";
import { PostDecodeProcessor, type PostDecodeConfig } from "./postDecodeChain";
import { loadMarker1033Pcm } from "./marker1033";
import {
  DEFAULT_VOICE_CODEC,
  computeWebEncodeCaps,
  detectFrameCodec,
  isVoiceCodec,
  type VoiceCodec,
} from "./voiceCodecRegistry";

export type VoiceState = "idle" | "connecting" | "listening" | "transmitting" | "error" | "closed";

export interface VoiceCallbacks {
  onState: (state: VoiceState, detail?: string) => void;
  onPermission: (permission: Permission) => void;
  /** Fired when inbound channel audio starts/stops — i.e. another unit is transmitting. */
  onReceiving: (receiving: boolean) => void;
  /** Fired when the relay rejects our transmission because the channel is already held. */
  onBusy: (holderUnit: string | null) => void;
  /** Fired when a dispatcher live-moves this unit to another channel (Live Channel Control). */
  onMove?: (toChannel: string, by: string | null) => void;
  /** Fired when the admin flips the channel's transmit codec, so the UI can
   *  surface "Channel switched to Opus" or similar. The web client itself
   *  only encodes IMBE today, so a switch to Codec2/Opus is purely
   *  informational and the registry's fallback keeps IMBE on TX. */
  onCodecChange?: (codec: VoiceCodec) => void;
}

const TARGET_RATE = 16000;
const CAPTURE_WORKLET_URL = "/pcm-capture-worklet.js";
/** Small FFT window — enough for a smooth RMS level, cheap to read every frame. */
const WAVEFORM_FFT_SIZE = 256;

// --- Jitter buffer + PLC ---------------------------------------------------
// These mirror the Android/iOS InboundJitterBuffer constants so dispatcher
// consoles see the same cutout behaviour as field handsets.
//
// 20 ms frames at the relay's cadence; the cushion gives the playout
// schedule ~80 ms of slack before the playHead falls behind ctx.currentTime
// and PLC fill kicks in.
const FRAME_SAMPLES = 320;
const JITTER_CUSHION_SEC = 0.08;
/** > 300 ms between voice frames marks a new talk-spurt — clear PLC state so
 *  the next talker isn't preceded by a faded copy of the previous one. */
const TALK_SPURT_GAP_SEC = 0.3;
/** Number of PLC frames synthesised before the loop falls to silence.
 *  3 × 20 ms = 60 ms of fade-out, then silence — masks an isolated late
 *  frame without looping a stuck note when the network stalls for seconds. */
const PLC_FADE_FRAMES = 3;
/** Hard cap on how many PLC frames a single underrun can emit, so a multi-
 *  second stall doesn't queue a wall of fade frames into the audio engine. */
const MAX_PLC_FILL_FRAMES = 8;
// Two-byte marker prefixing P25 IMBE digital-voice frames the browser cannot decode.
const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;
/** Recording / AI sideband — relay stores PCM but does not broadcast it (pairs with IMBE on-air). */
const LISTEN_PCM_MAGIC_0 = 0xf6;
const LISTEN_PCM_MAGIC_1 = 0xac;

function wrapListenPcm(pcm: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(2 + pcm.byteLength);
  const view = new Uint8Array(out);
  view[0] = LISTEN_PCM_MAGIC_0;
  view[1] = LISTEN_PCM_MAGIC_1;
  view.set(new Uint8Array(pcm), 2);
  return out;
}

function voiceSocketUrl(): string {
  const token = getToken() ?? "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/v1/voice/stream?token=${encodeURIComponent(token)}`;
}

/** Console client platform — "desktop" inside the Electron shell, otherwise "web". */
function consolePlatform(): string {
  return (window as { safetDesktop?: boolean }).safetDesktop === true ? "desktop" : "web";
}

const JOIN_ERRORS: Record<string, string> = {
  not_a_member: "You are not assigned to this channel.",
  unknown_channel: "That channel no longer exists.",
  bad_join: "The channel could not be joined.",
  channel_lookup_failed: "The server could not verify channel access.",
};

/** No inbound audio for this long means the channel is clear again. */
const RX_GAP_MS = 500;

/** Voice-fallback detector: at least this many raw PCM frames clustered within
 *  CLEAR_RX_BURST_WINDOW_MS is treated as a sustained talk-spurt (not a marker/tone-out). */
const CLEAR_RX_BURST_WINDOW_MS = 200;
const CLEAR_RX_BURST_FRAMES = 4;

const MARKER_INTERVAL_MS = 12000;
const MARKER_BEEP_MS = 200;
const MARKER_BEEP_HZ = 950;

/** Generates the 10-33 channel-marker tone as 16 kHz mono PCM-16. */
function markerBeepPcm(): Int16Array {
  const total = Math.round((TARGET_RATE * MARKER_BEEP_MS) / 1000);
  const fade = Math.round(TARGET_RATE * 0.01);
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    let gain = 0.5;
    if (i < fade) {
      gain *= i / fade;
    } else if (i > total - fade) {
      gain *= (total - i) / fade;
    }
    out[i] = Math.round(Math.sin((2 * Math.PI * MARKER_BEEP_HZ * i) / TARGET_RATE) * gain * 32767);
  }
  return out;
}

export type ToneOutKind = "routine" | "priority" | "status";

interface ToneSegment {
  hz: number; // 0 = silence
  ms: number;
}

/** Renders a tone/silence sequence to 16 kHz mono PCM-16 with click-free edges. */
function synthTone(segments: ToneSegment[]): Int16Array {
  const fade = Math.round(TARGET_RATE * 0.006);
  const total = segments.reduce((sum, s) => sum + Math.round((TARGET_RATE * s.ms) / 1000), 0);
  const out = new Int16Array(total);
  let pos = 0;
  for (const segment of segments) {
    const n = Math.round((TARGET_RATE * segment.ms) / 1000);
    for (let i = 0; i < n; i++) {
      let gain = 0.5;
      if (i < fade) {
        gain *= i / fade;
      } else if (i > n - fade) {
        gain *= (n - i) / fade;
      }
      out[pos + i] =
        segment.hz > 0
          ? Math.round(Math.sin((2 * Math.PI * segment.hz * i) / TARGET_RATE) * gain * 32767)
          : 0;
    }
    pos += n;
  }
  return out;
}

function warbleSegments(loHz: number, hiHz: number, segMs: number, totalMs: number): ToneSegment[] {
  const segments: ToneSegment[] = [];
  let high = true;
  for (let elapsed = 0; elapsed < totalMs; elapsed += segMs) {
    segments.push({ hz: high ? hiHz : loHz, ms: segMs });
    high = !high;
  }
  return segments;
}

/** Police-style dispatch alert tones: steady attention / urgent warble / status query. */
function toneOutPcm(kind: ToneOutKind): Int16Array {
  if (kind === "priority") {
    return synthTone(warbleSegments(720, 1180, 150, 2400));
  }
  if (kind === "status") {
    return synthTone([
      { hz: 1240, ms: 130 },
      { hz: 0, ms: 90 },
      { hz: 1240, ms: 130 },
      { hz: 0, ms: 90 },
      { hz: 1240, ms: 130 },
    ]);
  }
  return synthTone([{ hz: 1000, ms: 1000 }]);
}

/** Doubles 8 kHz PCM up to 16 kHz by sample duplication (IMBE decodes at 8 kHz). */
function upsample8kTo16k(pcm8k: Int16Array): Int16Array {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    out[i * 2] = pcm8k[i];
    out[i * 2 + 1] = pcm8k[i];
  }
  return out;
}

/** Encodes 16 kHz mic PCM to P25 IMBE frames (2-byte marker + 11-byte codeword). */
function encodeImbeFrames(pcm16k: Int16Array): ArrayBuffer[] {
  // 16 kHz -> 8 kHz by averaging sample pairs (the IMBE engine runs at 8 kHz).
  const pcm8k = new Int16Array(pcm16k.length >> 1);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm8k[i] = (pcm16k[2 * i] + pcm16k[2 * i + 1]) >> 1;
  }
  const frames: ArrayBuffer[] = [];
  for (let offset = 0; offset + 160 <= pcm8k.length; offset += 160) {
    const codeword = imbeEncode(pcm8k.subarray(offset, offset + 160));
    if (!codeword) {
      continue;
    }
    const frame = new Uint8Array(13);
    frame[0] = IMBE_MAGIC_0;
    frame[1] = IMBE_MAGIC_1;
    frame.set(codeword, 2);
    frames.push(frame.buffer);
  }
  return frames;
}

export class VoiceChannelClient {
  private readonly channelName: string;
  private readonly callbacks: VoiceCallbacks;

  private ws: WebSocket | null = null;
  private state: VoiceState = "idle";
  private permission: Permission = "listen_only";
  /** Codec the channel asked us to TX with. The web client only encodes
   *  IMBE today, but tracking the value lets the UI surface it and avoids
   *  the "raw PCM" cluster warning when a peer's Codec2/Opus frames
   *  arrive — those frames are now identified by the registry. */
  private currentTxCodec: VoiceCodec = DEFAULT_VOICE_CODEC;

  private playCtx: AudioContext | null = null;
  private playGain: GainNode | null = null;
  private audioOutputId = "";
  private playHead = 0;
  private volume = 1;
  private muted = false;

  /** Last decoded voice frame, kept so PLC can re-emit it with a fade when
   *  the playout queue underruns. Set to null on talk-spurt boundary so a
   *  stale tail can't bleed into the next talker's first frame.
   *  [lastGoodVoicePcm.length] carries the sample count; PLC frames reuse
   *  the same length so a sample-rate mismatch (admin switched upsample
   *  mode mid-stream) doesn't desync the playout. */
  private lastGoodVoicePcm: Int16Array | null = null;
  /** Number of consecutive PLC frames synthesised since the last real
   *  voice frame. Caps at PLC_FADE_FRAMES — after that the chain falls to
   *  silence so a long stall doesn't loop a stuck note. */
  private plcFrameCount: number = 0;
  /** AudioContext time (seconds) of the last real voice frame. Used to
   *  detect talk-spurt boundaries (>300 ms gap = new talker, reset PLC). */
  private lastVoiceAt: number = 0;

  // Analyser taps for waveform visualisation: one on the inbound (RX) chain and
  // one on the mic (TX) chain. Both are read on demand by getLevel().
  private playAnalyser: AnalyserNode | null = null;
  private capAnalyser: AnalyserNode | null = null;
  private readonly levelBytes = new Uint8Array(WAVEFORM_FFT_SIZE);

  private micStream: MediaStream | null = null;
  /** Browser DSP mode (EC/NS/AGC enabled?) the cached micStream was acquired
   *  with. When the agency `bypassMicProcessing` flag changes we have to
   *  release the stream and re-acquire — `applyConstraints` can't toggle
   *  these post-acquisition in all browsers. */
  private micStreamBrowserDsp: boolean | null = null;
  private capCtx: AudioContext | null = null;
  private capSource: MediaStreamAudioSourceNode | null = null;
  private capNode: AudioWorkletNode | null = null;
  private transmitting = false;
  private markerTimer: number | null = null;
  private readonly localTones = new Set<AudioBufferSourceNode>();
  /** Active looping soundboard tone-outs, keyed by tone-out id. */
  private readonly customLoops = new Map<number, number>();
  private digitalTx = true;
  /** Server asked for clear PCM uplink so AI dispatch can transcribe speech. */
  private aiDispatchListenPcm = false;
  /** Server wants clear PCM for the transmission log (all channels). */
  private recordListenPcm = false;
  private readonly txConditioner = new ImbeTxConditioner();
  /** Server-pushed flag: when true, getUserMedia disables EC/NS/AGC and the
   *  TX conditioner runs HPF + LPF only (no expander, no makeup AGC). Matches
   *  the radio-bridge mic chain so handset audio sounds like bridge audio. */
  private bypassMicProcessing = false;
  /** Agency-pushed RX shaping (presence bell, saturation, shelves, upsample
   *  mode). `null` when no shaping is configured — RX falls through to the
   *  legacy sample-duplicate path. The processor holds per-channel filter
   *  state across frames within a talk-spurt and is reset() on each new
   *  inbound talk-spurt boundary so a previous talker's biquad ring can't
   *  bleed into the next talker's first frame. */
  private postDecodeProcessor: PostDecodeProcessor | null = null;
  /** Promise resolved once refreshAudioConfig() has settled (success or fail)
   *  for the most recent connect(). startTransmit awaits this so the very
   *  first PTT after connect uses the right getUserMedia constraints instead
   *  of racing the HTTP response and locking in the wrong cached stream. */
  private audioConfigReady: Promise<void> = Promise.resolve();
  private gestureUnbind: (() => void) | null = null;

  private lastInboundMs = 0;
  private receiving = false;
  private rxWatchdog: number | null = null;
  /** One-shot warning when our own uplink falls back from IMBE to raw PCM. */
  private warnedClearTx = false;
  /** Already warned once that a peer is shipping continuous raw PCM (voice fallback). */
  private warnedClearRx = false;
  /** Codecs we have already warned about being unsupported in this client. */
  private warnedUnsupportedCodecs: Set<VoiceCodec> = new Set();

  /** Lazy Opus decoder (WebCodecs AudioDecoder). Constructed on the first
   *  inbound Opus frame so a browser that never receives Opus never spends
   *  the AudioDecoder configuration cost. Closed on disconnect to release
   *  the WebCodecs context. */
  private opusDecoder: OpusWebDecoder | null = null;

  /** Lazy Opus encoder (WebCodecs AudioEncoder). Constructed on the first
   *  outbound Opus frame so a console that always TXes on IMBE never pays
   *  the AudioEncoder configuration cost. The output callback writes
   *  directly to the WebSocket — feed-and-forget on the TX path. */
  private opusEncoder: OpusWebEncoder | null = null;
  /** Timestamps of recent raw PCM frames received — used to distinguish a sustained
   *  voice talk-spurt (many frames in quick succession) from a one-shot marker tone or
   *  tone-out (a single big PCM message). Only the warn-burst window of samples is kept. */
  private clearRxFrameTimes: number[] = [];

  private warnUnsupportedCodecOnce(codec: VoiceCodec): void {
    if (this.warnedUnsupportedCodecs.has(codec)) return;
    this.warnedUnsupportedCodecs.add(codec);
    console.warn(
      `[voice] received ${codec} frame on "${this.channelName}" — web client cannot decode this codec yet. ` +
        `Audio from this channel will be silent until the ${codec} decoder ships.`,
    );
  }

  /** Lazily constructs the Opus decoder on the first inbound Opus frame.
   *  WebCodecs construction is cheap on supported browsers and a no-op
   *  fallback (isReady=false) on unsupported ones, so the cost is paid
   *  once per channel session that actually receives Opus. */
  private ensureOpusDecoder(): OpusWebDecoder | null {
    if (this.opusDecoder) return this.opusDecoder;
    const dec = new OpusWebDecoder((pcm) => this.schedulePcm(pcm));
    if (!dec.isReady()) {
      // Construction failed (no WebCodecs / no Opus support). Cache the
      // failed decoder anyway so we don't reconstruct on every frame.
      this.opusDecoder = dec;
      return null;
    }
    this.opusDecoder = dec;
    return dec;
  }

  /** Lazily constructs the Opus encoder on the first outbound Opus frame.
   *  Encoded chunks ship straight to the WebSocket from the output
   *  callback — voiceClient hands the PCM in, the wire send happens
   *  inside the callback. Returns null if the browser can't encode Opus
   *  (caller falls back to IMBE). */
  private ensureOpusEncoder(): OpusWebEncoder | null {
    if (this.opusEncoder) return this.opusEncoder;
    const enc = new OpusWebEncoder((framed) => {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(framed);
      }
    });
    if (!enc.isReady()) {
      this.opusEncoder = enc;
      return null;
    }
    this.opusEncoder = enc;
    return enc;
  }

  constructor(channelName: string, callbacks: VoiceCallbacks) {
    this.channelName = channelName;
    this.callbacks = callbacks;
  }

  /** Codec the channel is currently asking us to transmit with. Updated by
   *  the joined reply and by codec_change pushes. The web client only
   *  encodes IMBE today regardless of this value — exposed for UI display
   *  and for future TX-side codec selection. */
  get transmitCodec(): VoiceCodec {
    return this.currentTxCodec;
  }

  get currentPermission(): Permission {
    return this.permission;
  }

  get canTransmit(): boolean {
    return this.permission !== "listen_only";
  }

  /** True while another unit's audio is arriving — the channel is occupied. */
  get channelBusy(): boolean {
    return Date.now() - this.lastInboundMs < RX_GAP_MS;
  }

  /** Chooses P25 IMBE (true) or clear PCM (false) for outgoing audio. */
  setDigitalTx(on: boolean): void {
    this.digitalTx = on;
  }

  /** Also uplink clear PCM for AI dispatch (sideband; on-air may stay IMBE). */
  setAiDispatchListenPcm(on: boolean): void {
    this.aiDispatchListenPcm = on;
  }

  /** Also uplink clear PCM for transmission log / Whisper (sideband; on-air may stay IMBE). */
  setRecordListenPcm(on: boolean): void {
    this.recordListenPcm = on;
  }

  private listenPcmSidebandRequired(): boolean {
    return this.aiDispatchListenPcm || this.recordListenPcm;
  }

  /** Pulls the agency-wide audio config so getUserMedia and the TX conditioner
   *  honor the admin's "bypass mic processing" choice on the next key-up.
   *  Failures are logged at warn so a transient 5xx during deploy is visible
   *  in console; the cached flag is left intact. */
  private async refreshAudioConfig(): Promise<void> {
    try {
      const res = await api.getAudioConfigSummary();
      this.bypassMicProcessing = Boolean(res.config?.bypassMicProcessing ?? false);
      // Build a fresh processor if the agency pushed post-decode shaping.
      // The server already strips the field to `null` when shaping would be
      // a no-op (see `derivePostDecodeBlock`), so any non-null value here
      // is worth running through the chain. Construction is cheap (just
      // computes biquad coefficients once); the per-frame `process()` is
      // the hot path.
      const pd = (res.config?.postDecode ?? null) as PostDecodeConfig | null;
      this.postDecodeProcessor = pd ? new PostDecodeProcessor(pd) : null;
    } catch (err) {
      console.warn(
        `[voice] failed to refresh audio config — keeping cached values ` +
          `(bypassMicProcessing=${this.bypassMicProcessing}, ` +
          `postDecode=${this.postDecodeProcessor ? "active" : "off"}):`,
        err,
      );
    }
  }

  /** Sets channel listen volume (0–1). Takes effect immediately and on next connect. */
  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1);
    if (this.playGain && !this.muted) {
      this.playGain.gain.value = this.volume;
    }
  }

  /** Mutes/unmutes channel listen audio without losing the volume setting. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.playGain) {
      this.playGain.gain.value = muted ? 0 : this.volume;
    }
  }

  /** Route this channel's listen audio to a specific output device (headset, speakers, etc.). */
  setAudioOutputId(deviceId: string): void {
    this.audioOutputId = deviceId;
    void this.applyAudioOutputId();
  }

  private async applyAudioOutputId(): Promise<void> {
    const ctx = this.playCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) {
      return;
    }
    try {
      await ctx.setSinkId(this.audioOutputId);
    } catch {
      /* device unavailable or policy blocked */
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get currentVolume(): number {
    return this.volume;
  }

  /**
   * Current audio amplitude (0–1 RMS) for waveform visualisation — the mic level
   * while transmitting, otherwise the inbound channel level. Returns 0 when there
   * is no active analyser (idle / disconnected).
   */
  getLevel(): number {
    const analyser = this.transmitting ? this.capAnalyser : this.playAnalyser;
    if (!analyser) {
      return 0;
    }
    analyser.getByteTimeDomainData(this.levelBytes);
    let sum = 0;
    for (let i = 0; i < this.levelBytes.length; i++) {
      const v = (this.levelBytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.levelBytes.length);
  }

  private setState(state: VoiceState, detail?: string): void {
    this.state = state;
    // Belt-and-braces: any transition back to "listening" guarantees no in-flight TX state
    // is left behind. A navigation race or a server-side close that arrives between a TX
    // start and stop could otherwise leave `this.transmitting === true`, which would make
    // the next startTransmit() silently early-return and look like a dead PTT button.
    if (state === "listening" || state === "closed" || state === "error") {
      this.transmitting = false;
    }
    this.callbacks.onState(state, detail);
  }

  /**
   * When the console auto-connects to the remembered channel before the user
   * has interacted with the page, the browser's autoplay policy leaves the
   * AudioContext suspended. Resume it (and the capture context) on the first
   * user gesture so audio is not silent until a manual navigation.
   */
  private armAudioResume(): void {
    if (!this.playCtx || this.playCtx.state === "running") {
      return;
    }
    const resume = () => {
      void this.playCtx?.resume();
      void this.capCtx?.resume();
      this.unbindAudioResume();
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    window.addEventListener("touchstart", resume);
    this.gestureUnbind = () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      window.removeEventListener("touchstart", resume);
    };
  }

  private unbindAudioResume(): void {
    this.gestureUnbind?.();
    this.gestureUnbind = null;
  }

  /** Opens the relay socket and starts listening. Call from a user gesture. */
  connect(): void {
    this.setState("connecting");
    void initImbe(); // load the IMBE vocoder in the background for digital RX
    void initCodec2(); // libcodec2 WASM — ~270 KB, lazy single-shot load
    // Reset client-side audio policy to defaults at the start of every
    // connect so a stale value from a previous session can't leak into the
    // first PTT before refreshAudioConfig settles.
    this.bypassMicProcessing = false;
    // Pull the agency-wide mic-processing flag and store the in-flight promise
    // so startTransmit can await it. Re-fires on every reconnect so admin
    // changes are picked up without a page reload.
    this.audioConfigReady = this.refreshAudioConfig();
    // Created inside the triggering click so the browser lets audio play.
    this.playCtx = new AudioContext({ sampleRate: TARGET_RATE });
    this.playGain = this.playCtx.createGain();
    this.playGain.gain.value = this.muted ? 0 : this.volume;
    this.playGain.connect(this.playCtx.destination);
    void this.applyAudioOutputId();
    // Analyser tap for the RX waveform. Fed by the inbound sources (see schedulePcm)
    // rather than the gain node, so the waveform reflects incoming speech even when
    // the channel is muted or turned down.
    this.playAnalyser = this.playCtx.createAnalyser();
    this.playAnalyser.fftSize = WAVEFORM_FFT_SIZE;
    this.playHead = 0;
    void this.playCtx.resume();
    this.armAudioResume();

    this.lastInboundMs = 0;
    this.receiving = false;
    if (this.rxWatchdog === null) {
      this.rxWatchdog = window.setInterval(() => {
        if (this.receiving && Date.now() - this.lastInboundMs > RX_GAP_MS) {
          this.receiving = false;
          this.callbacks.onReceiving(false);
        }
      }, 200);
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(voiceSocketUrl());
    } catch {
      this.setState("error", "Could not open the voice connection.");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "join",
          unit_id: "WEB",
          channel: this.channelName,
          client: consolePlatform(),
          // Caps are computed at every join so a browser that gained
          // WebCodecs support since the last connection picks it up.
          caps: computeWebEncodeCaps(opusEncoderAvailable()),
        }),
      );
      void loadMarker1033Pcm().catch(() => undefined);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleControl(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleAudio(event.data);
      }
    };
    ws.onerror = () => {
      if (this.state !== "closed" && this.state !== "error") {
        this.setState("error", "Voice connection error.");
      }
    };
    ws.onclose = () => {
      if (this.state !== "closed" && this.state !== "error") {
        this.setState("closed", "Voice connection closed.");
      }
    };
  }

  private handleControl(text: string): void {
    let msg: {
      type?: string;
      permission?: Permission;
      code?: string;
      unit_id?: string;
      channel?: string;
      by?: string;
      ai_dispatch_listen_pcm?: boolean;
      record_listen_pcm?: boolean;
      enabled?: boolean;
      codec?: string;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "joined") {
      this.permission = msg.permission ?? "listen_only";
      this.callbacks.onPermission(this.permission);
      if (msg.record_listen_pcm === true) {
        this.setRecordListenPcm(true);
      }
      if (msg.ai_dispatch_listen_pcm === true) {
        this.setAiDispatchListenPcm(true);
      }
      if (isVoiceCodec(msg.codec)) {
        this.currentTxCodec = msg.codec;
      } else {
        this.currentTxCodec = DEFAULT_VOICE_CODEC;
      }
      this.setState("listening");
    } else if (msg.type === "codec_change") {
      // Admin flipped this channel's codec while we were connected. The
      // web client only encodes IMBE today, so the registry's fallback
      // keeps us transmitting on IMBE regardless; this just lets the UI
      // surface the change and stops us logging "raw PCM" warnings when a
      // peer's Codec2/Opus frames arrive on the new codec.
      if (isVoiceCodec(msg.codec)) {
        this.currentTxCodec = msg.codec;
        this.callbacks.onCodecChange?.(msg.codec);
      }
    } else if (msg.type === "ai_dispatch_pcm") {
      this.setAiDispatchListenPcm(msg.enabled === true);
    } else if (msg.type === "busy") {
      // The relay rejected our audio — another unit holds the channel.
      if (this.transmitting) {
        this.stopTransmit();
      }
      this.callbacks.onBusy(msg.unit_id ?? null);
    } else if (msg.type === "move" && typeof msg.channel === "string") {
      // A dispatcher live-moved this unit (Live Channel Control). The client
      // re-joins the new channel; the relay does not migrate the socket itself.
      this.callbacks.onMove?.(msg.channel, msg.by ?? null);
    } else if (msg.type === "error") {
      this.setState("error", JOIN_ERRORS[msg.code ?? ""] ?? `Join rejected (${msg.code ?? "unknown"}).`);
      this.close();
    }
  }

  /** Marks that channel audio is arriving from another unit. */
  private markInbound(): void {
    this.lastInboundMs = Date.now();
    if (!this.receiving) {
      this.receiving = true;
      // Reset the post-decode chain at every talk-spurt boundary so a prior
      // talker's biquad state (especially shelves and the presence bell)
      // can't ring into the first few ms of the new talker's audio.
      this.postDecodeProcessor?.reset();
      this.callbacks.onReceiving(true);
    }
  }

  private handleAudio(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 2) {
      return;
    }
    this.markInbound();
    const bytes = new Uint8Array(buffer);

    // Codec dispatch: detect by leading magic bytes so a channel can mix
    // codecs mid-session without any client-side signaling.
    const codec = detectFrameCodec(bytes);
    if (codec === "imbe") {
      const pcm8k = imbeDecode(bytes.subarray(2));
      if (pcm8k) {
        // When the agency pushed post-decode shaping (presence / saturation
        // / shelves / polyphase24 upsample) every IMBE frame runs through
        // the chain at the configured output rate. Otherwise fall back to
        // the legacy 8 → 16 kHz sample-duplicate path so the no-shaping
        // case stays as cheap as it was before this PR.
        if (this.postDecodeProcessor) {
          const shaped = this.postDecodeProcessor.process(pcm8k);
          this.schedulePcm(shaped, { sampleRate: this.postDecodeProcessor.rate() });
        } else {
          this.schedulePcm(upsample8kTo16k(pcm8k));
        }
      }
      return;
    }
    if (codec === "opus") {
      // WebCodecs decode is async; the decoder's output callback feeds
      // schedulePcm directly. If the browser lacks WebCodecs Opus support,
      // OpusWebDecoder reports isReady=false and we fall through to the
      // one-shot "unsupported codec" warning.
      const dec = this.ensureOpusDecoder();
      if (dec && dec.isReady()) {
        dec.decodeFrame(bytes.subarray(2));
      } else {
        this.warnUnsupportedCodecOnce(codec);
      }
      return;
    }
    if (codec === "codec2_3200") {
      if (!codec2Ready()) {
        // The WASM module is loaded lazily on `joined`; if a Codec2 frame
        // arrives before init resolves, kick off the load and drop this
        // one. Following frames at the channel's 20 ms cadence catch up
        // once the module is in memory.
        void initCodec2();
        this.warnUnsupportedCodecOnce(codec);
        return;
      }
      const pcm8k = codec2Decode(bytes.subarray(2));
      if (pcm8k) {
        // Same 8 → 16 kHz path IMBE uses: through the agency post-decode
        // chain when configured, otherwise the legacy duplicate upsample.
        if (this.postDecodeProcessor) {
          const shaped = this.postDecodeProcessor.process(pcm8k);
          this.schedulePcm(shaped, { sampleRate: this.postDecodeProcessor.rate() });
        } else {
          this.schedulePcm(upsample8kTo16k(pcm8k));
        }
      }
      return;
    }
    // A sustained burst of raw PCM (multiple frames within ~200 ms) means a peer's IMBE
    // encoder did not engage and they are talking in clear PCM. Filter out one-shots —
    // 10-33 marker tones and tone-outs are also broadcast as raw PCM but arrive as a
    // single message — so we only warn after several frames cluster together.
    if (!this.warnedClearRx) {
      const now = Date.now();
      const times = this.clearRxFrameTimes;
      times.push(now);
      while (times.length > 0 && now - times[0] > CLEAR_RX_BURST_WINDOW_MS) {
        times.shift();
      }
      if (times.length >= CLEAR_RX_BURST_FRAMES) {
        this.warnedClearRx = true;
        this.clearRxFrameTimes = [];
        console.warn(
          `[voice] receiving raw PCM on "${this.channelName}" — peer's IMBE encoder is not active (handset native vocoder missing or web WASM failed to load on the sender).`,
        );
      }
    }
    this.schedulePcm(new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2)));
  }

  /** Queues one PCM-16 chunk for gapless playback on the listen context. */
  private schedulePcm(
    pcm: Int16Array,
    opts: { sampleRate?: number; track?: boolean } = {},
  ): void {
    const ctx = this.playCtx;
    if (!ctx || pcm.length === 0) {
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const sampleRate = opts.sampleRate ?? TARGET_RATE;
    const now = ctx.currentTime;

    // Voice frames go through the jitter buffer + PLC path; local tones
    // (10-33 markers, tone-outs, soundboard cues — track=true) bypass it
    // because they're one-shot and shouldn't be faded or filled.
    if (!opts.track) {
      // Talk-spurt boundary: > 300 ms of silence between voice frames means
      // a new talker. Drop the stale tail so the next talker doesn't get a
      // faded-out copy of the previous one in their opening moment.
      if (
        this.lastVoiceAt > 0 &&
        now - this.lastVoiceAt > TALK_SPURT_GAP_SEC
      ) {
        this.lastGoodVoicePcm = null;
        this.plcFrameCount = 0;
      }

      // Underrun fill: if the playout queue has drained (playHead is behind
      // the audio context's current time), synthesise PLC frames to bridge
      // the gap before scheduling the new frame. Capped so a multi-second
      // stall produces ~80 ms of fade + silence, not minutes of stale audio.
      if (this.playHead > 0 && this.playHead < now) {
        const gapSec = now + JITTER_CUSHION_SEC - this.playHead;
        const frameSec = FRAME_SAMPLES / sampleRate;
        const gapFrames = Math.min(
          MAX_PLC_FILL_FRAMES,
          Math.max(0, Math.ceil(gapSec / frameSec)),
        );
        for (let i = 0; i < gapFrames; i++) {
          this.scheduleRawPcm(this.synthesizePlcFrame(sampleRate), sampleRate, false);
        }
      }
      this.lastVoiceAt = now;
    }

    this.scheduleRawPcm(pcm, sampleRate, opts.track ?? false);

    if (!opts.track) {
      // Cache the just-played frame for future PLC. Copy out so a caller
      // that reuses the buffer (e.g. WebCodecs may recycle) can't mutate
      // our cached frame from under us.
      this.lastGoodVoicePcm = new Int16Array(pcm);
      this.plcFrameCount = 0;
    }
  }

  /** Schedule one PCM buffer at the running playHead. Splits out of
   *  schedulePcm so the PLC fill loop above can re-enter without recursing
   *  the talk-spurt / underrun bookkeeping. */
  private scheduleRawPcm(pcm: Int16Array, sampleRate: number, track: boolean): void {
    const ctx = this.playCtx;
    if (!ctx || pcm.length === 0) {
      return;
    }
    // AudioBuffer carries its own sampleRate independent of the AudioContext;
    // the browser handles any resample to the context rate transparently. So
    // a 24 kHz buffer scheduled into a 16 kHz context plays correctly — just
    // slightly more expensive than rate-matched playback. The voice-client
    // AudioContext stays at TARGET_RATE so legacy tone-out / marker buffers
    // keep playing rate-matched.
    const frame = ctx.createBuffer(1, pcm.length, sampleRate);
    const out = frame.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = pcm[i] / 0x8000;
    }
    const source = ctx.createBufferSource();
    source.buffer = frame;
    source.connect(this.playGain ?? ctx.destination);
    // Pre-gain tap so the RX waveform shows inbound audio regardless of volume/mute.
    if (this.playAnalyser) {
      source.connect(this.playAnalyser);
    }

    const now = ctx.currentTime;
    if (this.playHead < now + 0.04) {
      this.playHead = now + JITTER_CUSHION_SEC; // initial / post-gap cushion
    }
    source.start(this.playHead);
    this.playHead += frame.duration;

    if (track) {
      this.localTones.add(source);
      source.onended = () => this.localTones.delete(source);
    }
  }

  /** Build a PLC concealment frame from the last good voice PCM. Linear
   *  fade-out across [PLC_FADE_FRAMES] iterations, then silence. A short
   *  fade masks an isolated late frame; the silence floor prevents a
   *  multi-second stall from looping the same syllable. */
  private synthesizePlcFrame(sampleRate: number): Int16Array {
    const samples = Math.max(1, Math.round(FRAME_SAMPLES * (sampleRate / TARGET_RATE)));
    const last = this.lastGoodVoicePcm;
    if (!last) {
      this.plcFrameCount++;
      return new Int16Array(samples); // silence
    }
    if (this.plcFrameCount >= PLC_FADE_FRAMES) {
      this.plcFrameCount++;
      return new Int16Array(last.length); // silence at last frame's size
    }
    const gain = 1 - (this.plcFrameCount + 1) / (PLC_FADE_FRAMES + 1);
    this.plcFrameCount++;
    const out = new Int16Array(last.length);
    for (let i = 0; i < last.length; i++) {
      out[i] = (last[i] * gain) | 0;
    }
    return out;
  }

  /** Plays a locally-generated tone (marker / tone-out) that Stop All Sounds can cut. */
  private playLocalTone(pcm: Int16Array): void {
    this.schedulePcm(pcm, { track: true });
  }

  /** Begins microphone capture and transmission. Throws on permission/mic failure. */
  async startTransmit(): Promise<void> {
    if (this.transmitting) {
      return;
    }
    if (!this.canTransmit) {
      throw new Error("listen_only");
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not_connected");
    }
    // Strict half-duplex — refuse to key up while another unit holds the channel.
    if (this.channelBusy) {
      throw new Error("channel_busy");
    }

    // Wait for the in-flight audio-config fetch so getUserMedia gets the right
    // constraints on the very first PTT. Cap at 1.5s so a slow/failed server
    // doesn't deadlock the operator — the cached value (default false) will
    // be used on timeout, which is the same behaviour the field had before
    // this change.
    await Promise.race([
      this.audioConfigReady,
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);

    // When the admin pushed "bypass mic processing", match the bridge:
    // browser DSP off, raw PCM into our chain. Otherwise keep the legacy
    // VoIP-tuned defaults (EC/NS/AGC on) for noisy environments.
    const browserDsp = !this.bypassMicProcessing;
    // If the cached stream was acquired with the wrong DSP mode (admin
    // toggled the agency flag mid-session), release and re-acquire —
    // `applyConstraints` can't toggle echoCancellation/noiseSuppression
    // post-acquisition in Safari and some Chromium builds.
    if (this.micStream && this.micStreamBrowserDsp !== browserDsp) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
      this.micStreamBrowserDsp = null;
    }
    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: browserDsp,
          noiseSuppression: browserDsp,
          autoGainControl: browserDsp,
        },
      });
      this.micStreamBrowserDsp = browserDsp;
    }
    if (!this.capCtx) {
      this.capCtx = new AudioContext({ sampleRate: TARGET_RATE });
      await this.capCtx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    }
    if (this.capCtx.state === "suspended") {
      await this.capCtx.resume();
    }

    this.txConditioner.reset();
    this.capSource = this.capCtx.createMediaStreamSource(this.micStream);
    // Parallel analyser tap for the TX waveform (the worklet path is untouched).
    this.capAnalyser = this.capCtx.createAnalyser();
    this.capAnalyser.fftSize = WAVEFORM_FFT_SIZE;
    this.capSource.connect(this.capAnalyser);
    this.capNode = new AudioWorkletNode(this.capCtx, "pcm-capture");
    this.capNode.port.onmessage = (event: MessageEvent) => {
      const ws = this.ws;
      if (!this.transmitting || !ws || ws.readyState !== WebSocket.OPEN || !(event.data instanceof ArrayBuffer)) {
        return;
      }
      const pcmBuf = event.data;
      if (this.digitalTx) {
        // Mic conditioning runs codec-agnostic (matches IMBE/Opus on iOS/Android).
        const pcm = new Int16Array(pcmBuf);
        this.txConditioner.process(pcm, this.bypassMicProcessing);

        // Sideband for recorder / AI dispatch — always ships regardless of
        // codec so a vocoded talk-spurt is still transcribable.
        if (this.listenPcmSidebandRequired()) {
          ws.send(wrapListenPcm(pcmBuf));
        }

        // Codec dispatch on TX. In order: Opus (if WebCodecs available),
        // Codec2 (if WASM loaded), IMBE (the legacy default). Anything
        // that fails to encode falls through to clear PCM at the bottom.
        if (this.currentTxCodec === "opus") {
          const enc = this.ensureOpusEncoder();
          if (enc && enc.isReady()) {
            // Encoded chunks ship from the OpusWebEncoder output callback,
            // wired in ensureOpusEncoder to call ws.send directly.
            enc.encodeFrame(pcm);
            return;
          }
          // Opus asked for but unavailable — fall through to IMBE.
        }
        if (this.currentTxCodec === "codec2_3200") {
          if (codec2Ready()) {
            // libcodec2 mode 3200: 16 kHz → 8 kHz, 160 samples → 8-byte
            // codeword. Wire frame = 2-byte magic + 8-byte codeword = 10 bytes.
            const pcm8k = new Int16Array(pcm.length >> 1);
            for (let i = 0; i < pcm8k.length; i++) {
              pcm8k[i] = (pcm[2 * i] + pcm[2 * i + 1]) >> 1;
            }
            for (let off = 0; off + 160 <= pcm8k.length; off += 160) {
              const codeword = codec2Encode(pcm8k.subarray(off, off + 160));
              if (!codeword) continue;
              const frame = new Uint8Array(2 + codeword.length);
              frame[0] = 0xc2;
              frame[1] = 0x01;
              frame.set(codeword, 2);
              ws.send(frame.buffer);
            }
            return;
          }
          // Codec2 asked for but WASM not yet loaded — kick off the load
          // for next time and fall through to IMBE for this frame.
          void initCodec2();
        }
        if (imbeReady()) {
          for (const frame of encodeImbeFrames(pcm)) {
            ws.send(frame);
          }
          return;
        }
      }
      if (!this.warnedClearTx) {
        this.warnedClearTx = true;
        const reason = !this.digitalTx ? "HQ/analog mode selected" : "no vocoder encoder ready";
        console.warn(
          `[voice] transmitting raw PCM on "${this.channelName}" (${reason}) — peers will hear clear audio, not vocoded.`,
        );
      }
      ws.send(pcmBuf);
    };
    this.capSource.connect(this.capNode);
    // A silent sink keeps the worklet pulled without echoing the mic locally.
    const sink = this.capCtx.createGain();
    sink.gain.value = 0;
    this.capNode.connect(sink);
    sink.connect(this.capCtx.destination);

    this.transmitting = true;
    this.setState("transmitting");
  }

  stopTransmit(): void {
    if (!this.transmitting) {
      return;
    }
    this.transmitting = false;
    if (this.capNode) {
      this.capNode.port.onmessage = null;
      this.capNode.disconnect();
      this.capNode = null;
    }
    if (this.capSource) {
      this.capSource.disconnect();
      this.capSource = null;
    }
    // capSource.disconnect() already detached the analyser; just drop the ref.
    this.capAnalyser = null;
    // Drain any in-flight frames inside the Opus encoder so the tail of
    // this talk-spurt actually makes it on the air rather than being
    // stranded inside the WebCodecs pipeline. Best-effort; the flush is
    // async, the WebSocket may close before it completes.
    if (this.opusEncoder) {
      this.opusEncoder.flush();
    }
    if (this.state !== "closed" && this.state !== "error") {
      this.setState("listening");
    }
  }

  get markerActive(): boolean {
    return this.markerTimer !== null;
  }

  /** Toggles the 10-33 channel marker — a short tone keyed onto the channel every 12s. */
  setChannelMarker(active: boolean): void {
    if (active) {
      if (this.markerTimer !== null) {
        return;
      }
      this.sendMarkerBeep();
      this.markerTimer = window.setInterval(() => this.sendMarkerBeep(), MARKER_INTERVAL_MS);
    } else if (this.markerTimer !== null) {
      window.clearInterval(this.markerTimer);
      this.markerTimer = null;
    }
  }

  private sendMarkerBeep(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const sendPcm = (pcm: Int16Array): void => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Tell the relay this PCM is a 10-33 marker, not keyed voice (no /v1/air talker).
      ws.send(JSON.stringify({ type: "marker_tone" }));
      ws.send(pcm.buffer);
      this.playLocalTone(pcm);
    };
    void loadMarker1033Pcm().then(sendPcm).catch(() => sendPcm(markerBeepPcm()));
  }

  /** Keys a police-style alert tone onto the channel and plays it locally. */
  sendToneOut(kind: ToneOutKind): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const tone = toneOutPcm(kind);
    ws.send(tone.buffer);
    this.playLocalTone(tone);
  }

  /**
   * Fires a custom soundboard tone-out — keys the supplied PCM onto the channel
   * and plays it locally. In loop mode it re-keys the clip until stopped.
   */
  playCustomTone(id: number, pcm: Int16Array, loop: boolean): void {
    this.stopCustomTone(id);
    const fire = (): void => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(pcm.buffer);
      this.playLocalTone(pcm);
    };
    fire();
    if (loop) {
      const durationMs = Math.max(250, Math.round((pcm.length / TARGET_RATE) * 1000));
      this.customLoops.set(id, window.setInterval(fire, durationMs));
    }
  }

  /** Stops a looping tone-out (a one-shot tone-out simply plays out on its own). */
  stopCustomTone(id: number): void {
    const handle = this.customLoops.get(id);
    if (handle !== undefined) {
      window.clearInterval(handle);
      this.customLoops.delete(id);
    }
  }

  private stopCustomLoops(): void {
    for (const handle of this.customLoops.values()) {
      window.clearInterval(handle);
    }
    this.customLoops.clear();
  }

  private stopLocalTones(): void {
    for (const source of this.localTones) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already finished */
      }
    }
    this.localTones.clear();
  }

  /** Stop All Sounds — silences the channel marker and any tone-out / page tones locally. */
  stopAllTones(): void {
    this.setChannelMarker(false);
    this.stopCustomLoops();
    this.stopLocalTones();
  }

  /** Tears everything down; the client cannot be reused afterward. */
  close(): void {
    this.setChannelMarker(false);
    this.stopCustomLoops();
    this.stopLocalTones();
    this.unbindAudioResume();
    if (this.rxWatchdog !== null) {
      window.clearInterval(this.rxWatchdog);
      this.rxWatchdog = null;
    }
    this.receiving = false;
    this.transmitting = false;
    if (this.capNode) {
      this.capNode.port.onmessage = null;
      this.capNode.disconnect();
      this.capNode = null;
    }
    if (this.capSource) {
      this.capSource.disconnect();
      this.capSource = null;
    }
    this.capAnalyser = null;
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
      this.micStreamBrowserDsp = null;
    }
    if (this.capCtx) {
      void this.capCtx.close();
      this.capCtx = null;
    }
    if (this.playCtx) {
      void this.playCtx.close();
      this.playCtx = null;
    }
    this.playGain = null;
    this.playAnalyser = null;
    if (this.opusDecoder) {
      this.opusDecoder.close();
      this.opusDecoder = null;
    }
    if (this.opusEncoder) {
      this.opusEncoder.close();
      this.opusEncoder = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    if (this.state !== "error") {
      this.setState("closed");
    }
  }
}
