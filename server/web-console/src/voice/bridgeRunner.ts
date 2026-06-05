// Bridge runner: streams a chosen line-in / audio-input device onto a radio
// channel as a VOX-gated radio bridge, and (for bidirectional bridges) plays
// the channel back out to a chosen output device. Runs in the desktop console
// on the machine physically wired to the external radio.

import { getToken } from "../api";
import { imbeDecode, initImbe } from "./imbeVocoder";

export type BridgeRunState = "idle" | "connecting" | "running" | "error" | "closed";

export interface BridgeRunnerCallbacks {
  onState: (state: BridgeRunState, detail?: string) => void;
  /** VOX gate opened/closed — true while line-in audio is being keyed onto the channel. */
  onKeyed: (keyed: boolean) => void;
  /** Inbound channel audio present — only meaningful for a bidirectional bridge. */
  onReceiving: (receiving: boolean) => void;
  /** Smoothed input level (0–1) of the captured device — drives the audio meter. */
  onLevel?: (level: number) => void;
}

export interface BridgeRunnerConfig {
  bridgeId: number;
  bidirectional: boolean;
  /** VOX trigger level, 0–1 (normalized RMS). */
  voxThreshold: number;
  /** Keep keying this long after audio drops, so speech tails are not clipped. */
  voxHangMs: number;
  inputDeviceId: string;
  /** Output device for bidirectional playback; null uses the system default. */
  outputDeviceId: string | null;
}

const TARGET_RATE = 16000;
const CAPTURE_WORKLET_URL = "/pcm-capture-worklet.js";
const RX_GAP_MS = 500;
const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;

/** Doubles 8 kHz PCM up to 16 kHz (IMBE decodes at 8 kHz). */
function upsample8kTo16k(pcm8k: Int16Array): Int16Array {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    out[i * 2] = pcm8k[i];
    out[i * 2 + 1] = pcm8k[i];
  }
  return out;
}

/** Normalized RMS (0–1) of one mono 16-bit PCM frame. */
function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  return Math.sqrt(sum / pcm.length) / 32768;
}

interface SinkAudioContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

export class BridgeRunnerClient {
  private readonly config: BridgeRunnerConfig;
  private readonly callbacks: BridgeRunnerCallbacks;

  private ws: WebSocket | null = null;
  private state: BridgeRunState = "idle";

  private inputStream: MediaStream | null = null;
  private capCtx: AudioContext | null = null;
  private capSource: MediaStreamAudioSourceNode | null = null;
  private capNode: AudioWorkletNode | null = null;

  private playCtx: AudioContext | null = null;
  private playHead = 0;

  private lastVoxMs = 0;
  private meterLevel = 0;
  private keyed = false;
  private lastInboundMs = 0;
  private receiving = false;
  private rxWatchdog: number | null = null;

  constructor(config: BridgeRunnerConfig, callbacks: BridgeRunnerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  get currentState(): BridgeRunState {
    return this.state;
  }

  private setState(state: BridgeRunState, detail?: string): void {
    this.state = state;
    this.callbacks.onState(state, detail);
  }

  /** Opens the input device + relay socket and begins VOX-gated ingestion. */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      return;
    }
    this.setState("connecting");
    void initImbe(); // decoder for digital RX on bidirectional bridges

    try {
      // A line feed wants the raw signal — no mic processing.
      this.inputStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: this.config.inputDeviceId },
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      this.setState("error", "Could not open the selected input device.");
      return;
    }

    // Connecting to the relay is the only retryable startup step: a socket failure already set a
    // "closed" (ws.onerror) and a relay rejection a terminal "error" (handleControl), so just tear
    // down — a server redeploy stays retryable and the runner row reconnects on its own.
    try {
      await this.openSocket();
    } catch {
      this.stop();
      return;
    }

    // Local audio init, by contrast, is a non-transient fault (no input device, worklet/codec
    // failure). Surface it as a terminal "error" so it shows a fixable problem instead of looping
    // reconnect attempts forever as if the server were down.
    try {
      await this.startCapture();
      if (this.config.bidirectional) {
        await this.startPlayback();
      }
    } catch {
      this.setState("error", "Could not start audio capture/playback.");
      this.stop();
      return;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const token = getToken() ?? "";
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url =
        `${proto}//${window.location.host}/v1/voice/stream` +
        `?token=${encodeURIComponent(token)}&runBridge=${this.config.bridgeId}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new Error("socket"));
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        // The relay forces the channel from the bridge row; client is "bridge".
        ws.send(JSON.stringify({ type: "join", client: "bridge" }));
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          this.handleControl(event.data, resolve, reject);
        } else if (event.data instanceof ArrayBuffer && this.config.bidirectional) {
          this.handleAudio(event.data);
        }
      };
      ws.onerror = () => {
        // A socket-level failure (server redeploying, network blip) is transient: surface it as a
        // retryable "closed" so the runner row reconnects on its own instead of giving up. A fatal
        // rejection (bad bridge config / auth) arrives as a relay control "error" message and is
        // handled in handleControl, not here.
        if (this.state !== "closed" && this.state !== "error") {
          this.setState("closed", "Voice connection lost — reconnecting…");
        }
        reject(new Error("socket"));
      };
      ws.onclose = () => {
        if (this.state !== "closed" && this.state !== "error") {
          this.setState("closed", "Voice connection closed.");
        }
      };
    });
  }

  private handleControl(text: string, resolve: () => void, reject: (e: Error) => void): void {
    let msg: { type?: string; code?: string };
    try {
      msg = JSON.parse(text) as { type?: string; code?: string };
    } catch {
      return;
    }
    if (msg.type === "joined") {
      this.setState("running");
      resolve();
    } else if (msg.type === "error") {
      // Relay rejections during server redeploy are often transient. Treat them as connection
      // failures that trigger a retry instead of terminal errors. Terminal errors (auth,
      // permissions) from the relay layer are rare — most issues are temporary (channel not
      // yet synced after redeploy, etc.).
      this.setState("closed", `Relay rejected: ${msg.code ?? "unknown"} — reconnecting…`);
      reject(new Error(msg.code ?? "error"));
    }
    // "busy" is expected when a yielding bridge is pre-empted — frames are
    // simply dropped by the relay, so no action is needed here.
  }

  private async startCapture(): Promise<void> {
    this.capCtx = new AudioContext({ sampleRate: TARGET_RATE });
    // After a page reload the context can come up suspended (autoplay policy); a suspended context
    // never pulls the capture worklet, so resume it so an auto-resumed bridge actually captures.
    if (this.capCtx.state === "suspended") {
      await this.capCtx.resume().catch(() => undefined);
    }
    await this.capCtx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    this.capSource = this.capCtx.createMediaStreamSource(this.inputStream!);
    this.capNode = new AudioWorkletNode(this.capCtx, "pcm-capture");
    this.capNode.port.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.onCaptureFrame(event.data);
      }
    };
    this.capSource.connect(this.capNode);
    // A silent sink keeps the worklet pulled.
    const sink = this.capCtx.createGain();
    sink.gain.value = 0;
    this.capNode.connect(sink);
    sink.connect(this.capCtx.destination);
  }

  /** VOX gate: forward a captured frame onto the channel only when audio is present. */
  private onCaptureFrame(buffer: ArrayBuffer): void {
    const pcm = new Int16Array(buffer);
    const now = Date.now();
    const rms = frameRms(pcm);
    // Fast-attack, slow-decay smoothing keeps the input meter steady to read.
    this.meterLevel = Math.max(rms, this.meterLevel * 0.8);
    this.callbacks.onLevel?.(this.meterLevel);
    if (rms >= this.config.voxThreshold) {
      this.lastVoxMs = now;
    }
    const open = this.lastVoxMs !== 0 && now - this.lastVoxMs < this.config.voxHangMs;
    if (open !== this.keyed) {
      this.keyed = open;
      this.callbacks.onKeyed(open);
    }
    const ws = this.ws;
    if (open && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(buffer);
      } catch {
        /* socket dropped — onclose handles teardown */
      }
    }
  }

  private async startPlayback(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: TARGET_RATE }) as SinkAudioContext;
    if (this.config.outputDeviceId && typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId(this.config.outputDeviceId);
      } catch {
        /* unsupported or denied — fall back to the system default output */
      }
    }
    this.playCtx = ctx;
    this.playHead = 0;
    this.rxWatchdog = window.setInterval(() => {
      if (this.receiving && Date.now() - this.lastInboundMs > RX_GAP_MS) {
        this.receiving = false;
        this.callbacks.onReceiving(false);
      }
    }, 200);
  }

  private handleAudio(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 2) {
      return;
    }
    this.lastInboundMs = Date.now();
    if (!this.receiving) {
      this.receiving = true;
      this.callbacks.onReceiving(true);
    }
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 13 && bytes[0] === IMBE_MAGIC_0 && bytes[1] === IMBE_MAGIC_1) {
      const pcm8k = imbeDecode(bytes.subarray(2));
      if (pcm8k) {
        this.schedulePcm(upsample8kTo16k(pcm8k));
      }
      return;
    }
    this.schedulePcm(new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2)));
  }

  /** Queues one PCM chunk for gapless playback out the bridge's output device. */
  private schedulePcm(pcm: Int16Array): void {
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
    source.connect(ctx.destination);
    const now = ctx.currentTime;
    if (this.playHead < now + 0.04) {
      this.playHead = now + 0.08;
    }
    source.start(this.playHead);
    this.playHead += frame.duration;
  }

  /** Tears everything down; the runner cannot be reused afterward. */
  stop(): void {
    if (this.rxWatchdog !== null) {
      window.clearInterval(this.rxWatchdog);
      this.rxWatchdog = null;
    }
    if (this.capNode) {
      this.capNode.port.onmessage = null;
      this.capNode.disconnect();
      this.capNode = null;
    }
    if (this.capSource) {
      this.capSource.disconnect();
      this.capSource = null;
    }
    if (this.inputStream) {
      this.inputStream.getTracks().forEach((t) => t.stop());
      this.inputStream = null;
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
    this.keyed = false;
    this.receiving = false;
    // Don't re-announce a state we're already in: stop() can be called from inside the onState
    // callback (the runner row releases the dying runner on "closed"), and re-emitting would
    // re-enter that handler and reschedule the reconnect.
    if (this.state !== "error" && this.state !== "closed") {
      this.setState("closed");
    }
  }
}
