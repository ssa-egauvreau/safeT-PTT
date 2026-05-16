// Browser voice client for one channel: joins the relay WebSocket, plays inbound
// PCM, and (when permitted) captures the microphone and transmits.

import { getToken, type Permission } from "../api";

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

export class VoiceChannelClient {
  private readonly channelName: string;
  private readonly callbacks: VoiceCallbacks;

  private ws: WebSocket | null = null;
  private state: VoiceState = "idle";
  private permission: Permission = "listen_only";

  private playCtx: AudioContext | null = null;
  private playHead = 0;

  private micStream: MediaStream | null = null;
  private capCtx: AudioContext | null = null;
  private capSource: MediaStreamAudioSourceNode | null = null;
  private capNode: AudioWorkletNode | null = null;
  private transmitting = false;

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

  private setState(state: VoiceState, detail?: string): void {
    this.state = state;
    this.callbacks.onState(state, detail);
  }

  /** Opens the relay socket and starts listening. Call from a user gesture. */
  connect(): void {
    this.setState("connecting");
    // Created inside the triggering click so the browser lets audio play.
    this.playCtx = new AudioContext({ sampleRate: TARGET_RATE });
    this.playHead = 0;
    void this.playCtx.resume();

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
    const ctx = this.playCtx;
    if (!ctx || buffer.byteLength < 2) {
      return;
    }
    const bytes = new Uint8Array(buffer);
    // Digital-voice (IMBE) frames cannot be decoded here — skip rather than play noise.
    if (bytes.byteLength === 13 && bytes[0] === IMBE_MAGIC_0 && bytes[1] === IMBE_MAGIC_1) {
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const pcm = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
    const frame = ctx.createBuffer(1, pcm.length, TARGET_RATE);
    const out = frame.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = pcm[i] / 0x8000;
    }
    const source = ctx.createBufferSource();
    source.buffer = frame;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.playHead < now + 0.04) {
      this.playHead = now + 0.08; // jitter cushion when starting or after a gap
    }
    source.start(this.playHead);
    this.playHead += frame.duration;
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
      if (this.transmitting && ws && ws.readyState === WebSocket.OPEN && event.data instanceof ArrayBuffer) {
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

  /** Tears everything down; the client cannot be reused afterward. */
  close(): void {
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
