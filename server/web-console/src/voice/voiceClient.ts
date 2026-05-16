// Browser voice client for one channel: joins the relay WebSocket, plays inbound
// PCM, and (when permitted) captures the microphone and transmits.

import { getToken, type Permission } from "../api";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "./imbeVocoder";

export type VoiceState = "idle" | "connecting" | "listening" | "transmitting" | "error" | "closed";

export interface VoiceCallbacks {
  onState: (state: VoiceState, detail?: string) => void;
  onPermission: (permission: Permission) => void;
}

const TARGET_RATE = 16000;
const CAPTURE_WORKLET_URL = "/pcm-capture-worklet.js";
// Two-byte marker prefixing P25 IMBE digital-voice frames the browser cannot decode.
const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;

function voiceSocketUrl(): string {
  const token = getToken() ?? "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/v1/voice/stream?token=${encodeURIComponent(token)}`;
}

const JOIN_ERRORS: Record<string, string> = {
  not_a_member: "You are not assigned to this channel.",
  unknown_channel: "That channel no longer exists.",
  bad_join: "The channel could not be joined.",
  channel_lookup_failed: "The server could not verify channel access.",
};

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

  private playCtx: AudioContext | null = null;
  private playGain: GainNode | null = null;
  private playHead = 0;
  private volume = 1;
  private muted = false;

  private micStream: MediaStream | null = null;
  private capCtx: AudioContext | null = null;
  private capSource: MediaStreamAudioSourceNode | null = null;
  private capNode: AudioWorkletNode | null = null;
  private transmitting = false;
  private markerTimer: number | null = null;
  private readonly localTones = new Set<AudioBufferSourceNode>();
  private digitalTx = true;
  private gestureUnbind: (() => void) | null = null;

  constructor(channelName: string, callbacks: VoiceCallbacks) {
    this.channelName = channelName;
    this.callbacks = callbacks;
  }

  get currentPermission(): Permission {
    return this.permission;
  }

  get canTransmit(): boolean {
    return this.permission !== "listen_only";
  }

  /** Chooses P25 IMBE (true) or clear PCM (false) for outgoing audio. */
  setDigitalTx(on: boolean): void {
    this.digitalTx = on;
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

  get isMuted(): boolean {
    return this.muted;
  }

  get currentVolume(): number {
    return this.volume;
  }

  private setState(state: VoiceState, detail?: string): void {
    this.state = state;
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
    // Created inside the triggering click so the browser lets audio play.
    this.playCtx = new AudioContext({ sampleRate: TARGET_RATE });
    this.playGain = this.playCtx.createGain();
    this.playGain.gain.value = this.muted ? 0 : this.volume;
    this.playGain.connect(this.playCtx.destination);
    this.playHead = 0;
    void this.playCtx.resume();
    this.armAudioResume();

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
      ws.send(JSON.stringify({ type: "join", unit_id: "WEB", channel: this.channelName }));
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
    let msg: { type?: string; permission?: Permission; code?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "joined") {
      this.permission = msg.permission ?? "listen_only";
      this.callbacks.onPermission(this.permission);
      this.setState("listening");
    } else if (msg.type === "error") {
      this.setState("error", JOIN_ERRORS[msg.code ?? ""] ?? `Join rejected (${msg.code ?? "unknown"}).`);
      this.close();
    }
  }

  private handleAudio(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 2) {
      return;
    }
    const bytes = new Uint8Array(buffer);
    // P25 IMBE digital-voice frame: 2-byte marker + 11-byte codeword.
    if (bytes.byteLength === 13 && bytes[0] === IMBE_MAGIC_0 && bytes[1] === IMBE_MAGIC_1) {
      const pcm8k = imbeDecode(bytes.subarray(2));
      if (pcm8k) {
        this.schedulePcm(upsample8kTo16k(pcm8k));
      }
      return;
    }
    this.schedulePcm(new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2)));
  }

  /** Queues one PCM-16 chunk for gapless playback on the listen context. */
  private schedulePcm(pcm: Int16Array, track = false): void {
    const ctx = this.playCtx;
    if (!ctx || pcm.length === 0) {
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const frame = ctx.createBuffer(1, pcm.length, TARGET_RATE);
    const out = frame.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = pcm[i] / 0x8000;
    }
    const source = ctx.createBufferSource();
    source.buffer = frame;
    source.connect(this.playGain ?? ctx.destination);

    const now = ctx.currentTime;
    if (this.playHead < now + 0.04) {
      this.playHead = now + 0.08; // jitter cushion when starting or after a gap
    }
    source.start(this.playHead);
    this.playHead += frame.duration;

    if (track) {
      this.localTones.add(source);
      source.onended = () => this.localTones.delete(source);
    }
  }

  /** Plays a locally-generated tone (marker / tone-out) that Stop All Sounds can cut. */
  private playLocalTone(pcm: Int16Array): void {
    this.schedulePcm(pcm, true);
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

    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    if (!this.capCtx) {
      this.capCtx = new AudioContext({ sampleRate: TARGET_RATE });
      await this.capCtx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    }
    if (this.capCtx.state === "suspended") {
      await this.capCtx.resume();
    }

    this.capSource = this.capCtx.createMediaStreamSource(this.micStream);
    this.capNode = new AudioWorkletNode(this.capCtx, "pcm-capture");
    this.capNode.port.onmessage = (event: MessageEvent) => {
      const ws = this.ws;
      if (!this.transmitting || !ws || ws.readyState !== WebSocket.OPEN || !(event.data instanceof ArrayBuffer)) {
        return;
      }
      if (this.digitalTx && imbeReady()) {
        // Encode to P25 IMBE so transmissions carry the digital-voice character.
        for (const frame of encodeImbeFrames(new Int16Array(event.data))) {
          ws.send(frame);
        }
      } else {
        ws.send(event.data);
      }
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
    const beep = markerBeepPcm();
    ws.send(beep.buffer); // keyed onto the channel for every listener
    this.playLocalTone(beep); // and played locally so the dispatcher hears it
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
    this.stopLocalTones();
  }

  /** Tears everything down; the client cannot be reused afterward. */
  close(): void {
    this.setChannelMarker(false);
    this.stopLocalTones();
    this.unbindAudioResume();
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
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
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
