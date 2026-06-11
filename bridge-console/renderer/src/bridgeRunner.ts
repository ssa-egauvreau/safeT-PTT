// Bridge runner for the safeT Bridge desktop box.
//
// Streams a chosen line-in / audio-input device onto a radio channel as a
// VOX-gated bridge and, for bidirectional bridges, decodes the channel back out
// to a chosen output device. Built for unattended operation: it owns an
// infinite reconnect loop with exponential backoff, so a server redeploy or
// network blip is recovered automatically without reloading the app or any
// human action. The microphone and audio graph are acquired once and kept alive
// across socket reconnects — only the WebSocket is rebuilt — so a reconnect is
// silent and never re-prompts for the device.
//
// The DSP (capture worklet, IMBE decode + AGC, VOX gate) is the same code the
// web console ships, so audio behaviour is identical.

import { ambeDecode, initAmbe } from "./ambeVocoder";
import { imbeDecode, initImbe } from "./imbeVocoder";
import { wsOrigin } from "./api";
import { fmtDur } from "./format";

export type BridgeRunState =
  | "idle"
  | "connecting"
  | "running"
  | "reconnecting"
  | "error"
  | "stopped";

/** One timestamped line in a bridge's activity/diagnostics log. */
export interface BridgeLogEvent {
  atMs: number;
  kind: "info" | "good" | "warn" | "bad";
  text: string;
}

/** One direction's audio-burst telemetry (a burst = one keyed/received stretch). */
export interface BridgeBurstStats {
  /** Completed bursts since the bridge was started. */
  count: number;
  /** Wall-clock ms when the last (or current) burst began; 0 = never. */
  lastAtMs: number;
  /** Duration of the last completed burst. */
  lastDurationMs: number;
  /** Bytes carried by the last completed burst (RX only; 0 for TX). */
  lastBytes: number;
  /** True while a burst is in progress right now. */
  active: boolean;
}

export interface BridgeDisconnect {
  atMs: number;
  reason: string;
  /** Best-effort cause: was this box offline, or did the server stop answering? */
  diagnosis: string;
}

/** Connection + audio telemetry for one bridge run (reset on each start()). */
export interface BridgeRunStats {
  /** Wall-clock ms when start() was called; 0 = never started. */
  startedAtMs: number;
  /** Wall-clock ms when the current relay connection was joined; 0 while down. */
  connectedSinceMs: number;
  /** Total ms on the channel across past connections (excludes the current one). */
  totalConnectedMs: number;
  /** Connection drops since start (does not count the operator stopping it). */
  disconnects: number;
  lastDisconnect: BridgeDisconnect | null;
  /** Line-in audio keyed onto the channel (VOX bursts). */
  tx: BridgeBurstStats;
  /** Channel audio played back out (bidirectional bridges only). */
  rx: BridgeBurstStats;
}

function emptyStats(): BridgeRunStats {
  return {
    startedAtMs: 0,
    connectedSinceMs: 0,
    totalConnectedMs: 0,
    disconnects: 0,
    lastDisconnect: null,
    tx: { count: 0, lastAtMs: 0, lastDurationMs: 0, lastBytes: 0, active: false },
    rx: { count: 0, lastAtMs: 0, lastDurationMs: 0, lastBytes: 0, active: false },
  };
}

export interface BridgeRunnerCallbacks {
  onState: (state: BridgeRunState, detail?: string) => void;
  /** VOX gate opened/closed — true while line-in audio is being keyed on-channel. */
  onKeyed: (keyed: boolean) => void;
  /** Inbound channel audio present — only meaningful for a bidirectional bridge. */
  onReceiving: (receiving: boolean) => void;
  /** Smoothed input level (0–1) of the captured device — drives the meter. */
  onLevel?: (level: number) => void;
  /** Fired when the relay rejects with an auth-style code so the app can re-login. */
  onAuthError?: () => void;
  /** A new activity/diagnostics log line (also buffered — see getLog()). */
  onLog?: (event: BridgeLogEvent) => void;
}

export interface BridgeRunnerConfig {
  serverUrl: string;
  bridgeId: number;
  bidirectional: boolean;
  /** Live token provider — read fresh on every (re)connect so a refreshed
   *  token is picked up automatically after the app re-authenticates. */
  getToken: () => string;
  /** VOX trigger level, 0–1 (normalized RMS, measured post-gain). */
  voxThreshold: number;
  /** Keep keying this long after audio drops, so speech tails are not clipped. */
  voxHangMs: number;
  /** Linear input gain applied before VOX + send (1 = unity). */
  gain: number;
  inputDeviceId: string;
  /** Output device for bidirectional playback; null/"" uses the system default. */
  outputDeviceId: string | null;
}

const TARGET_RATE = 16000;
const RX_GAP_MS = 500;
const IMBE_MAGIC_0 = 0xf5;
const IMBE_MAGIC_1 = 0xab;

/** Reconnect backoff bounds + jitter. Infinite retries; capped delay. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20000;
/** How often the watchdog verifies the socket is actually alive. */
const WATCHDOG_MS = 5000;
/** Activity log ring-buffer size — enough history without growing forever. */
const LOG_LIMIT = 75;

/** Resolves the capture worklet URL against the loaded document (works under file://). */
function captureWorkletUrl(): string {
  return new URL("pcm-capture-worklet.js", document.baseURI).href;
}

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
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  return Math.sqrt(sum / pcm.length) / 32768;
}

/** Auth-style relay codes that should trigger a re-login (vs. plain retry). */
function isAuthRelayCode(code: string | undefined): boolean {
  return code === "unauthorized" || code === "forbidden" || code === "session_superseded";
}

interface SinkAudioContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

export class BridgeRunnerClient {
  private readonly config: BridgeRunnerConfig;
  private callbacks: BridgeRunnerCallbacks;

  private ws: WebSocket | null = null;
  private state: BridgeRunState = "idle";
  private stateDetail = "";

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

  /** Operator intent: stay connected until stop() is called. */
  private wantRunning = false;
  private reconnectTimer: number | null = null;
  private connWatchdog: number | null = null;
  private attempts = 0;
  /** True once the socket has reached "running" at least once this session. */
  private everConnected = false;

  private stats: BridgeRunStats = emptyStats();
  private logBuffer: BridgeLogEvent[] = [];
  private txStartMs = 0;
  private rxStartMs = 0;
  private rxBurstBytes = 0;

  // The OS knowing the network is down/up is the cheapest, most reliable
  // diagnostic we have: log it, and reconnect immediately on restore instead of
  // waiting out the backoff timer.
  private readonly handleOffline = (): void => {
    if (!this.wantRunning) return;
    this.addLog("warn", "This computer went offline — internet connection lost.");
  };
  private readonly handleOnline = (): void => {
    if (!this.wantRunning) return;
    this.addLog("info", "Internet connection restored — reconnecting now.");
    this.attempts = 0;
    this.clearReconnectTimer();
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      this.connect();
    }
  };

  constructor(config: BridgeRunnerConfig, callbacks: BridgeRunnerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  get currentState(): BridgeRunState {
    return this.state;
  }

  get currentDetail(): string {
    return this.stateDetail;
  }

  /**
   * Points the runner's events at a new set of callbacks. Used when the card UI
   * is rebuilt (e.g. "Reset audio settings") while the bridge keeps running, so
   * lamps/meter/log don't keep writing into orphaned DOM.
   */
  rebindCallbacks(callbacks: BridgeRunnerCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Snapshot of connection + audio telemetry for this run. */
  getStats(): BridgeRunStats {
    return {
      ...this.stats,
      lastDisconnect: this.stats.lastDisconnect ? { ...this.stats.lastDisconnect } : null,
      tx: { ...this.stats.tx },
      rx: { ...this.stats.rx },
    };
  }

  /** The buffered activity log, oldest first (capped at LOG_LIMIT entries). */
  getLog(): BridgeLogEvent[] {
    return this.logBuffer.slice();
  }

  private addLog(kind: BridgeLogEvent["kind"], text: string): void {
    const event: BridgeLogEvent = { atMs: Date.now(), kind, text };
    this.logBuffer.push(event);
    if (this.logBuffer.length > LOG_LIMIT) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_LIMIT);
    }
    this.callbacks.onLog?.(event);
  }

  /** Hot-update gain/VOX without tearing the bridge down. */
  updateAudioParams(params: { gain?: number; voxThreshold?: number; voxHangMs?: number }): void {
    if (typeof params.gain === "number") this.config.gain = params.gain;
    if (typeof params.voxThreshold === "number") this.config.voxThreshold = params.voxThreshold;
    if (typeof params.voxHangMs === "number") this.config.voxHangMs = params.voxHangMs;
  }

  private setState(state: BridgeRunState, detail?: string): void {
    this.state = state;
    this.stateDetail = detail ?? "";
    this.callbacks.onState(state, detail);
  }

  /** Acquires the device + audio graph once, then starts the reconnect loop. */
  async start(): Promise<void> {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.attempts = 0;
    this.everConnected = false;
    this.stats = emptyStats();
    this.stats.startedAtMs = Date.now();
    this.logBuffer = [];
    this.addLog("info", "Bridge started.");
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    this.setState("connecting", "Starting…");
    // The P25 vocoder is only needed to decode inbound channel audio, so load it
    // lazily and only for bidirectional bridges (best-effort).
    if (this.config.bidirectional) {
      void initImbe();
      void initAmbe(); // AMBE+2 (P25 Phase 2) — shares the dvmvocoder WASM with IMBE
    }

    // Local audio init is a non-transient fault (no device, worklet failure):
    // surface it as a terminal "error" instead of looping reconnects forever.
    try {
      await this.startCapture();
      if (this.config.bidirectional) {
        await this.startPlayback();
      }
    } catch {
      this.addLog("bad", "Could not start audio capture/playback — check the input/output device.");
      this.setState("error", "Could not start audio capture/playback. Check the device.");
      this.teardownAudio();
      this.wantRunning = false;
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
      return;
    }

    this.startWatchdog();
    this.connect();
  }

  /** Opens (or reopens) the relay socket. Safe to call repeatedly. */
  private connect(): void {
    if (!this.wantRunning) return;
    this.clearReconnectTimer();
    if (this.ws) {
      // An existing socket is already connecting/open — don't stack a second.
      if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
        return;
      }
      this.teardownSocket();
    }

    // Reaching here with the connected clock still running means the link died
    // without an onclose (half-open socket found by the watchdog) — account it.
    if (this.stats.connectedSinceMs > 0) {
      this.registerDisconnect("connection check found the link dead");
    }

    this.setState(this.everConnected ? "reconnecting" : "connecting", this.connectDetail());

    const token = this.config.getToken();
    const url =
      `${wsOrigin(this.config.serverUrl)}/v1/voice/stream` +
      `?token=${encodeURIComponent(token)}&runBridge=${this.config.bridgeId}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect("Could not open the voice socket");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      // The relay forces the channel from the bridge row; we only declare client type.
      try {
        ws.send(JSON.stringify({ type: "join", client: "bridge" }));
      } catch {
        /* will surface via onclose */
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleControl(event.data);
      } else if (event.data instanceof ArrayBuffer && this.config.bidirectional) {
        this.handleAudio(event.data);
      }
    };
    ws.onerror = () => {
      // Browser WebSocket can't expose the handshake status, so a 401 (expired
      // token) looks the same as the server being down: both just retry. The
      // app's auth watchdog refreshes the token in parallel and calls
      // notifyTokenRefreshed() to kick an immediate reconnect with it.
      if (this.ws === ws) this.scheduleReconnect("Voice connection error");
    };
    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect("Voice connection lost");
    };
  }

  private handleControl(text: string): void {
    let msg: { type?: string; code?: string };
    try {
      msg = JSON.parse(text) as { type?: string; code?: string };
    } catch {
      return;
    }
    if (msg.type === "joined") {
      const now = Date.now();
      const wasReconnect = this.everConnected;
      const attemptsTaken = this.attempts;
      this.everConnected = true;
      this.attempts = 0;
      this.keyed = false;
      this.receiving = false;
      if (this.stats.connectedSinceMs === 0) {
        this.stats.connectedSinceMs = now;
        if (wasReconnect) {
          const downFor = this.stats.lastDisconnect ? now - this.stats.lastDisconnect.atMs : 0;
          const tries = `${attemptsTaken} attempt${attemptsTaken === 1 ? "" : "s"}`;
          this.addLog(
            "good",
            downFor > 0
              ? `Reconnected — back on the channel after ${fmtDur(downFor)} down (${tries}).`
              : `Reconnected — back on the channel (${tries}).`,
          );
        } else {
          this.addLog("good", "Connected — on the channel.");
        }
      }
      this.setState("running", "On the channel.");
    } else if (msg.type === "error") {
      // A relay rejection is treated as retryable (a redeploy can briefly reject
      // a join). Auth-style codes additionally ask the app to re-login.
      if (isAuthRelayCode(msg.code)) {
        this.addLog("warn", `Relay rejected the connection (${msg.code ?? "unknown"}) — refreshing sign-in.`);
        this.callbacks.onAuthError?.();
      } else {
        this.addLog("warn", `Relay rejected the connection (${msg.code ?? "unknown"}).`);
      }
      this.scheduleReconnect(`Relay rejected: ${msg.code ?? "unknown"}`);
    }
    // "busy" is expected when a yielding bridge is pre-empted — ignore.
  }

  private connectDetail(): string {
    if (!this.everConnected) return "Connecting…";
    return this.attempts > 0 ? `Reconnecting… (attempt ${this.attempts})` : "Reconnecting…";
  }

  /** Folds the ending connection stretch into the stats and logs a diagnosis. */
  private registerDisconnect(reason: string): void {
    const now = Date.now();
    this.endTxBurst(now);
    this.endRxBurst(now);
    this.stats.totalConnectedMs += now - this.stats.connectedSinceMs;
    this.stats.connectedSinceMs = 0;
    this.stats.disconnects += 1;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const diagnosis = offline
      ? "this computer's internet connection appears to be down"
      : "internet looks OK; the safeT server is not responding (it may be restarting or redeploying)";
    this.stats.lastDisconnect = { atMs: now, reason, diagnosis };
    this.addLog("bad", `Connection lost (${reason}) — ${diagnosis}.`);
  }

  /** Drops the current socket and arms a backoff timer to reconnect. */
  private scheduleReconnect(reason: string): void {
    this.teardownSocket();
    const wasConnected = this.stats.connectedSinceMs > 0;
    if (wasConnected) {
      this.registerDisconnect(reason);
    }
    this.keyed = false;
    this.callbacks.onKeyed(false);
    this.receiving = false;
    this.callbacks.onReceiving(false);
    if (!this.wantRunning) {
      return;
    }
    if (this.reconnectTimer !== null) {
      return; // a reconnect is already pending
    }
    this.attempts += 1;
    // Log the first failure of a retry streak (further attempts only update the
    // status line, so an outage doesn't flood the log).
    if (!wasConnected && this.attempts === 1) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      this.addLog(
        "warn",
        `Could not connect (${reason})${offline ? " — this computer appears to be offline" : ""}; retrying until it succeeds.`,
      );
    }
    const capped = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS);
    const jittered = Math.round(capped * (0.8 + Math.random() * 0.4));
    this.setState("reconnecting", `${reason} — retrying in ${Math.round(jittered / 1000)}s…`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jittered);
  }

  /** Called by the app after a successful re-login: reconnect now with the fresh token. */
  notifyTokenRefreshed(): void {
    if (!this.wantRunning) return;
    this.attempts = 0;
    this.clearReconnectTimer();
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      this.addLog("info", "Sign-in refreshed — reconnecting with the new session.");
      this.connect();
    }
  }

  private endTxBurst(endMs: number): void {
    if (!this.stats.tx.active) return;
    this.stats.tx.active = false;
    this.stats.tx.lastDurationMs = Math.max(endMs - this.txStartMs, 0);
    this.stats.tx.count += 1;
  }

  private endRxBurst(endMs: number): void {
    if (!this.stats.rx.active) return;
    this.stats.rx.active = false;
    this.stats.rx.lastDurationMs = Math.max(endMs - this.rxStartMs, 0);
    this.stats.rx.lastBytes = this.rxBurstBytes;
    this.stats.rx.count += 1;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Periodic liveness check — catches a half-open socket the events missed. */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.connWatchdog = window.setInterval(() => {
      if (!this.wantRunning) return;
      if (this.reconnectTimer !== null) return;
      const open = this.ws && this.ws.readyState === WebSocket.OPEN;
      const connecting = this.ws && this.ws.readyState === WebSocket.CONNECTING;
      if (!open && !connecting) {
        this.connect();
      }
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.connWatchdog !== null) {
      window.clearInterval(this.connWatchdog);
      this.connWatchdog = null;
    }
  }

  private async startCapture(): Promise<void> {
    // A line feed wants the raw signal — no mic processing.
    this.inputStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.config.inputDeviceId
          ? { exact: this.config.inputDeviceId }
          : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.capCtx = new AudioContext({ sampleRate: TARGET_RATE });
    if (this.capCtx.state === "suspended") {
      await this.capCtx.resume().catch(() => undefined);
    }
    await this.capCtx.audioWorklet.addModule(captureWorkletUrl());
    this.capSource = this.capCtx.createMediaStreamSource(this.inputStream);
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
    let pcm = new Int16Array(buffer);
    // Apply input gain before metering/VOX so the operator can bring a weak
    // line-in up into the VOX range with the gain slider.
    const gain = this.config.gain;
    if (gain !== 1) {
      const gained = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        let s = pcm[i] * gain;
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        gained[i] = s;
      }
      pcm = gained;
    }

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
      if (open) {
        this.txStartMs = now;
        this.stats.tx.active = true;
        this.stats.tx.lastAtMs = now;
      } else {
        this.endTxBurst(now);
      }
      this.callbacks.onKeyed(open);
    }
    const ws = this.ws;
    if (open && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(pcm.buffer);
      } catch {
        /* socket dropped — onclose handles teardown */
      }
    }
  }

  private async startPlayback(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: TARGET_RATE }) as SinkAudioContext;
    const out = this.config.outputDeviceId;
    if (out && out !== "default" && typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId(out);
      } catch {
        /* unsupported or denied — fall back to the system default output */
      }
    }
    this.playCtx = ctx;
    this.playHead = 0;
    this.rxWatchdog = window.setInterval(() => {
      if (this.receiving && Date.now() - this.lastInboundMs > RX_GAP_MS) {
        this.receiving = false;
        this.endRxBurst(this.lastInboundMs);
        this.callbacks.onReceiving(false);
      }
    }, 200);
  }

  private handleAudio(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 2) return;
    const now = Date.now();
    this.lastInboundMs = now;
    if (!this.receiving) {
      this.receiving = true;
      this.rxStartMs = now;
      this.rxBurstBytes = 0;
      this.stats.rx.active = true;
      this.stats.rx.lastAtMs = now;
      this.callbacks.onReceiving(true);
    }
    this.rxBurstBytes += buffer.byteLength;
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 13 && bytes[0] === IMBE_MAGIC_0 && bytes[1] === IMBE_MAGIC_1) {
      const pcm8k = imbeDecode(bytes.subarray(2));
      if (pcm8k) {
        this.schedulePcm(upsample8kTo16k(pcm8k));
      }
      return;
    }
    // AMBE+2 2450 (P25 Phase 2): 2-byte magic + 9-byte codeword. Decoded the
    // same way as IMBE so a bridge on an AMBE channel plays voice, not the
    // static that falling through to the raw-PCM branch would produce.
    if (bytes.byteLength === 11 && bytes[0] === 0xa2 && bytes[1] === 0x45) {
      const pcm8k = ambeDecode(bytes.subarray(2));
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
    if (!ctx || pcm.length === 0) return;
    if (ctx.state === "suspended") void ctx.resume();
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

  private teardownSocket(): void {
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
  }

  private teardownAudio(): void {
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
  }

  /** Tears everything down; the runner cannot be reused afterward. */
  stop(): void {
    const wasRunning = this.wantRunning;
    this.wantRunning = false;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    this.clearReconnectTimer();
    this.stopWatchdog();
    this.teardownSocket();
    this.teardownAudio();
    // Close the books: finish any open bursts and fold the current connected
    // stretch into the total — an operator stop is not a "drop".
    const now = Date.now();
    this.endTxBurst(now);
    this.endRxBurst(now);
    if (this.stats.connectedSinceMs > 0) {
      this.stats.totalConnectedMs += now - this.stats.connectedSinceMs;
      this.stats.connectedSinceMs = 0;
    }
    this.keyed = false;
    this.receiving = false;
    this.meterLevel = 0;
    this.callbacks.onLevel?.(0);
    if (wasRunning) {
      this.addLog("info", "Bridge stopped.");
    }
    if (this.state !== "error") {
      this.setState("stopped", "Stopped.");
    }
  }
}
