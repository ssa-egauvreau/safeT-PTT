import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  describeError,
  VOICE_CODEC_LABEL,
  VOICE_CODECS,
  coerceVoiceCodecClient,
  voiceCodecLabel,
  type AudioLabPresetSummary,
  type UserChannel,
  type VoiceCodec,
} from "../../api";
import { codec2Decode, codec2Encode, codec2Ready, initCodec2 } from "../../voice/codec2Vocoder";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "../../voice/imbeVocoder";
import { ambeDecode, ambeEncode, ambeReady, initAmbe } from "../../voice/ambeVocoder";
import { opusDecode, opusEncode, opusReady, initOpus } from "../../voice/opusWasmCodec";
import {
  DEFAULT_PRESET,
  outputSampleRate,
  processClip,
  processClipProduction,
  upsamplePlayback16To24,
  type AudioLabConfig,
  type UpsampleMode,
} from "./audioLab/pipeline";
import { LAB_SAMPLE_RATE, MAX_CLIP_SECONDS, startLabRecorder, type LabRecorder } from "./audioLab/recorder";
import { deleteUserPreset, listPresets, saveUserPreset, type PresetRecord } from "./audioLab/presets";
import { pushClipToChannel } from "./audioLab/channelPush";
import { SimpleControls } from "./audioLab/SimpleControls";

type LabState = "idle" | "recording" | "processing" | "playing" | "pushing";
type ViewMode = "simple" | "advanced";

/** What the live production audio path is doing today. Pulled from the same constants
 *  the relay / voice client use so this stays a single source of truth — bump the values
 *  here whenever you change the production setup. */
const PRODUCTION_AUDIO_CONFIG = {
  codec: "dvmvocoder (P25 Phase 1 compatible)",
  voiceBitrateBps: 4400,
  imbeFrameMs: 20,
  pcmSidebandFrameMs: 40,
  txPreEmphasis: "180 Hz HPF + 3400 Hz LPF + adaptive AGC + noise gate",
  rxPostDecode: "AGC only (no filters / EQ / shelving)",
  rxUpsample: "Sample duplication (8 → 16 kHz)",
  listenerJitterCushionMs: 80,
  airSlotTtlMs: 2000,
  peerBufferLimitKB: 64,
  recordingSideband: "Always on (clear PCM, for Whisper transcription)",
};

interface LatencyMeasurement {
  /** Network RTT to /health endpoint (ms). */
  rttMs: number;
  /** Time to encode one 20 ms frame (ms). */
  encodeMs: number;
  /** Time to decode one frame (ms). */
  decodeMs: number;
  codec: VoiceCodec;
  /** When the measurement was taken — used to invalidate stale numbers. */
  takenAt: number;
}

async function pingOnce(): Promise<number> {
  const start = performance.now();
  // Cache-bust so the browser does an actual round-trip every time.
  await fetch(`/health?lab=${start}`, { cache: "no-store" });
  return performance.now() - start;
}

async function measureNetworkRtt(samples = 6): Promise<number> {
  // Drop the first sample (DNS / TCP handshake warmup) and average the rest.
  const results: number[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      results.push(await pingOnce());
    } catch {
      /* ignore one-off failures */
    }
  }
  if (results.length < 2) {
    throw new Error("Could not measure network RTT — server unreachable");
  }
  const sorted = [...results].slice(1).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;
}

async function measureCodecRoundtrip(
  codec: VoiceCodec,
): Promise<{ encodeMs: number; decodeMs: number }> {
  const ITER = 50;
  let encodeTotal = 0;
  let decodeTotal = 0;
  let samples = 0;

  if (codec === "opus") {
    if (!opusReady()) {
      const ok = await initOpus();
      if (!ok) throw new Error("Opus WASM is not loaded");
    }
    const probe = new Int16Array(320);
    for (let i = 0; i < 320; i++) {
      probe[i] = Math.round(Math.sin((2 * Math.PI * 500 * i) / 16000) * 8000);
    }
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const packet = opusEncode(probe);
      const t1 = performance.now();
      if (!packet) continue;
      opusDecode(packet);
      const t2 = performance.now();
      encodeTotal += t1 - t0;
      decodeTotal += t2 - t1;
      samples += 1;
    }
  } else if (codec === "codec2_3200") {
    if (!codec2Ready()) {
      const ok = await initCodec2();
      if (!ok) throw new Error("Codec2 WASM is not loaded");
    }
    const probe = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      probe[i] = Math.round(Math.sin((2 * Math.PI * 500 * i) / 8000) * 8000);
    }
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const cw = codec2Encode(probe);
      const t1 = performance.now();
      if (!cw) continue;
      codec2Decode(cw);
      const t2 = performance.now();
      encodeTotal += t1 - t0;
      decodeTotal += t2 - t1;
      samples += 1;
    }
  } else if (codec === "ambe_2450") {
    if (!ambeReady()) {
      const ok = await initAmbe();
      if (!ok) throw new Error("AMBE WASM is not loaded");
    }
    const probe = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      probe[i] = Math.round(Math.sin((2 * Math.PI * 500 * i) / 8000) * 8000);
    }
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const cw = ambeEncode(probe);
      const t1 = performance.now();
      if (!cw) continue;
      ambeDecode(cw);
      const t2 = performance.now();
      encodeTotal += t1 - t0;
      decodeTotal += t2 - t1;
      samples += 1;
    }
  } else {
    if (!imbeReady()) {
      const ok = await initImbe();
      if (!ok) throw new Error("IMBE WASM is not loaded");
    }
    const probe = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      probe[i] = Math.round(Math.sin((2 * Math.PI * 500 * i) / 8000) * 8000);
    }
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const cw = imbeEncode(probe);
      const t1 = performance.now();
      if (!cw) continue;
      imbeDecode(cw);
      const t2 = performance.now();
      encodeTotal += t1 - t0;
      decodeTotal += t2 - t1;
      samples += 1;
    }
  }

  if (samples === 0) {
    throw new Error(`${VOICE_CODEC_LABEL[codec]} round-trip failed — WASM encode returned nothing`);
  }
  return { encodeMs: encodeTotal / samples, decodeMs: decodeTotal / samples };
}

function cloneConfig(c: AudioLabConfig): AudioLabConfig {
  return {
    preImbe: { ...c.preImbe },
    vocoder: { ...c.vocoder },
    postDecode: { ...c.postDecode },
  };
}

function configsEqual(a: AudioLabConfig, b: AudioLabConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AudioLabPanel() {
  const [config, setConfig] = useState<AudioLabConfig>(() => cloneConfig(DEFAULT_PRESET));
  const [presets, setPresets] = useState<PresetRecord[]>(() => listPresets());
  const [activePresetName, setActivePresetName] = useState<string>("Default IMBE");
  // Server-side, agency-wide presets (loaded lazily from
  // /v1/admin/audio-lab-presets). `selectedServerPreset` is the dropdown's
  // current selection — separate from the local activePresetName so picking a
  // server preset doesn't desync the local-preset display.
  const [serverPresets, setServerPresets] = useState<AudioLabPresetSummary[]>([]);
  const [selectedServerPreset, setSelectedServerPreset] = useState<string>("");
  const [serverPresetsLoaded, setServerPresetsLoaded] = useState(false);
  const [serverPresetBusy, setServerPresetBusy] = useState(false);
  const [state, setState] = useState<LabState>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedClip, setRecordedClip] = useState<Int16Array | null>(null);
  const [processedClip, setProcessedClip] = useState<Int16Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Simple / advanced view toggle — persisted to localStorage.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem("audiolab-view-mode") as ViewMode | null) ?? "simple";
    } catch {
      return "simple";
    }
  });

  const [labCodec, setLabCodec] = useState<VoiceCodec>(() => {
    try {
      const saved = localStorage.getItem("audiolab-codec");
      if (saved && (VOICE_CODECS as readonly string[]).includes(saved)) {
        return saved as VoiceCodec;
      }
    } catch {
      /* ignore */
    }
    return "imbe";
  });

  // Global apply state. `liveBypassMicProcessing` mirrors the bypass flag of
  // the currently-deployed agency config so "Play with live server settings"
  // honors it — without that, an admin who pushed Bridge-style minimal sees
  // the production-path A/B run the full expander/AGC chain, which doesn't
  // match what handsets are actually doing.
  const [globalConfig, setGlobalConfig] = useState<{
    updatedAt: string | null;
    updatedBy: string | null;
    liveBypassMicProcessing: boolean;
  }>({
    updatedAt: null,
    updatedBy: null,
    liveBypassMicProcessing: false,
  });
  const [applyingGlobal, setApplyingGlobal] = useState(false);
  const [confirmingGlobal, setConfirmingGlobal] = useState(false);
  const [resettingBaseline, setResettingBaseline] = useState(false);
  const [confirmingBaseline, setConfirmingBaseline] = useState(false);

  // Channel push state.
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [pushChannel, setPushChannel] = useState("");
  const [confirmingPush, setConfirmingPush] = useState(false);

  // Latency measurement state.
  const [latency, setLatency] = useState<LatencyMeasurement | null>(null);
  const [measuringLatency, setMeasuringLatency] = useState(false);

  const playCtxRef = useRef<AudioContext | null>(null);
  // Track the rate we *asked* the context to run at, not the one it actually
  // ended up at — Safari (and some Chromium builds) ignore the constructor's
  // sampleRate option and stick to the device default (44.1/48 kHz). Comparing
  // the *requested* rate keeps "did the caller change modes?" honest; comparing
  // ctx.sampleRate would say "yes" on every click in those browsers and burn
  // through the per-tab AudioContext budget.
  const playCtxRequestedRateRef = useRef<number | null>(null);
  const playSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  // Mirror of `recording` state so stable callbacks (onAutoStop, unmount cleanup) can
  // reach the live recorder without going through a stale closure on the React state.
  const recordingRef = useRef<LabRecorder | null>(null);

  useEffect(() => {
    void initImbe();
    void initCodec2();
    void initOpus();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("audiolab-codec", labCodec);
    } catch {
      /* ignore */
    }
  }, [labCodec]);

  // Load channels for the push dropdown (talk-capable only).
  useEffect(() => {
    let cancelled = false;
    void api
      .myChannels()
      .then((res) => {
        if (cancelled) return;
        const talk = res.channels.filter((c) => c.permission !== "listen_only");
        setChannels(talk);
        if (talk.length > 0 && !pushChannel) {
          setPushChannel(talk[0]!.name);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the current global audio config metadata (who last applied, when).
  useEffect(() => {
    void api
      .getGlobalAudioConfig()
      .then((res) => {
        const cfg = res.config as { preImbe?: { bypassMicProcessing?: boolean } } | null;
        setGlobalConfig({
          updatedAt: res.updatedAt,
          updatedBy: res.updatedBy,
          liveBypassMicProcessing: Boolean(cfg?.preImbe?.bypassMicProcessing ?? false),
        });
      })
      .catch(() => undefined);
  }, []);

  function handleViewModeChange(mode: ViewMode): void {
    setViewMode(mode);
    setConfirmingGlobal(false);
    try {
      localStorage.setItem("audiolab-view-mode", mode);
    } catch {
      /* storage unavailable */
    }
  }

  // Detect when the live config drifts from the named preset.
  const isDirty = useMemo(() => {
    const preset = presets.find((p) => p.name === activePresetName);
    return preset ? !configsEqual(preset.config, config) : true;
  }, [config, activePresetName, presets]);

  // Stop any in-flight playback and release the mic when the user leaves the panel.
  // Reads the live recorder through `recordingRef` so this works even if the user
  // navigates away mid-recording (the React state captured at mount would be null).
  useEffect(() => {
    return () => {
      try {
        playSourceRef.current?.stop();
      } catch {
        /* already stopped */
      }
      void playCtxRef.current?.close().catch(() => undefined);
      playCtxRequestedRateRef.current = null;
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      const rec = recordingRef.current;
      if (rec) {
        try {
          rec.stop();
        } catch {
          /* already torn down */
        }
        recordingRef.current = null;
      }
    };
  }, []);

  function setError_(msg: string | null): void {
    setError(msg);
    if (msg) setInfo(null);
  }
  function setInfo_(msg: string | null): void {
    setInfo(msg);
    if (msg) setError(null);
  }

  async function handleStartRecord(): Promise<void> {
    setError_(null);
    setInfo_(null);
    setRecordedClip(null);
    setProcessedClip(null);
    try {
      const rec = await startLabRecorder({
        // Reads the recorder via ref so auto-stop works even though this callback
        // was created on a render where `recording` was still null.
        onAutoStop: () => finishRecording(),
      });
      recordingRef.current = rec;
      setRecordingSeconds(0);
      setState("recording");
      const started = Date.now();
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.min(MAX_CLIP_SECONDS, (Date.now() - started) / 1000));
      }, 100);
    } catch (err) {
      setError_(describeError(err));
      setState("idle");
    }
  }

  /** Idempotent — invoked both by the UI Stop button and the recorder's onAutoStop. */
  function finishRecording(): void {
    const rec = recordingRef.current;
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (!rec) {
      setState("idle");
      return;
    }
    const pcm = rec.stop();
    recordingRef.current = null;
    setRecordedClip(pcm);
    setState("idle");
    if (pcm.length === 0) {
      setError_("No audio captured — check mic permission and try again.");
    } else {
      setInfo_(
        `Recorded ${(pcm.length / LAB_SAMPLE_RATE).toFixed(1)}s of audio.${
          rec.hitMaxLength ? " (max length reached)" : ""
        }`,
      );
    }
  }

  function handleStopRecord(): void {
    finishRecording();
  }

  async function handleProcessAndPlay(): Promise<void> {
    if (!recordedClip || recordedClip.length === 0) {
      setError_("Record a clip first.");
      return;
    }
    setError_(null);
    setInfo_(null);
    setState("processing");
    let processed: Int16Array;
    try {
      processed = await processClip(recordedClip, config, labCodec);
    } catch (err) {
      setError_(describeError(err));
      setState("idle");
      return;
    }
    setProcessedClip(processed);
    // `processed` is always 16 kHz (channel push depends on that). When the
    // user picked the "polyphase24" upsample mode, render the extra 16 → 24
    // step here so playback hits the DAC at 24 kHz, reducing the browser's
    // own resample distance to its native 48 kHz output from 3× to 2×.
    const playbackRate = outputSampleRate(config.postDecode.upsampleMode);
    const playbackPcm =
      playbackRate === 24_000 ? upsamplePlayback16To24(processed) : processed;
    await playPcm(playbackPcm, playbackRate);
  }

  async function handlePlayProduction(): Promise<void> {
    if (!recordedClip || recordedClip.length === 0) {
      setError_("Record a clip first.");
      return;
    }
    setError_(null);
    setInfo_(null);
    setState("processing");
    let processed: Int16Array;
    try {
      processed = await processClipProduction(
        recordedClip,
        globalConfig.liveBypassMicProcessing,
        labCodec,
      );
    } catch (err) {
      setError_(describeError(err));
      setState("idle");
      return;
    }
    // Don't overwrite `processedClip` — that one is what the Channel Push uses, and
    // it should reflect the user's custom settings, not the production reference.
    // Production path is always 16 kHz — it's the live reference, not a quality test.
    await playPcm(processed, LAB_SAMPLE_RATE);
  }

  async function handlePlayOriginal(): Promise<void> {
    if (!recordedClip || recordedClip.length === 0) {
      setError_("Record a clip first.");
      return;
    }
    setError_(null);
    setInfo_(null);
    await playPcm(recordedClip, LAB_SAMPLE_RATE);
  }

  async function playPcm(pcm: Int16Array, sampleRate: number): Promise<void> {
    // Tear down any previous playback.
    try {
      playSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    // The cached AudioContext is locked to whatever sampleRate it was created
    // at — recreate it if the caller now wants a different rate (e.g. switching
    // between the 16 kHz production preset and the polyphase24 listening mode).
    // Compare the *requested* rate, not ctx.sampleRate: Safari and some
    // Chromium builds ignore the constructor option and run at the device
    // default, which would make this branch fire on every click and exhaust
    // the per-tab AudioContext budget on rapid A/B-ing.
    if (playCtxRef.current && playCtxRequestedRateRef.current !== sampleRate) {
      void playCtxRef.current.close();
      playCtxRef.current = null;
      playCtxRequestedRateRef.current = null;
    }
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate });
      playCtxRequestedRateRef.current = sampleRate;
    }
    const ctx = playCtxRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      ch[i] = pcm[i] / 0x8000;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (playSourceRef.current === source) {
        playSourceRef.current = null;
        setState("idle");
      }
    };
    playSourceRef.current = source;
    setState("playing");
    source.start();
  }

  function handleSelectPreset(name: string): void {
    const preset = presets.find((p) => p.name === name);
    if (!preset) return;
    setActivePresetName(name);
    setConfig(cloneConfig(preset.config));
  }

  function handleSaveAs(): void {
    const name = window.prompt("Save preset as:", isDirty ? `${activePresetName} (custom)` : activePresetName);
    if (!name) return;
    const ok = saveUserPreset(name, config);
    if (!ok) {
      setError_(`Cannot save: "${name.trim()}" is a built-in preset name.`);
      return;
    }
    setPresets(listPresets());
    setActivePresetName(name.trim());
    setInfo_(`Saved preset "${name.trim()}".`);
  }

  function handleDeletePreset(): void {
    const preset = presets.find((p) => p.name === activePresetName);
    if (!preset || preset.builtin) {
      setError_("Cannot delete a built-in preset.");
      return;
    }
    if (!window.confirm(`Delete preset "${preset.name}"?`)) return;
    deleteUserPreset(preset.name);
    setPresets(listPresets());
    setActivePresetName("Default IMBE");
    setConfig(cloneConfig(DEFAULT_PRESET));
    setInfo_(`Deleted preset "${preset.name}".`);
  }

  // ---------- Server-side, agency-wide presets ------------------------------

  /** Refreshes the server preset dropdown. Tolerates a backend that doesn't
   *  yet have the presets table (404 / 500) — the panel still works for
   *  local presets and the existing apply-globally button. */
  const reloadServerPresets = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listAudioLabPresets();
      setServerPresets(res.presets);
      setServerPresetsLoaded(true);
    } catch {
      // Older agency / API surface — quietly hide the sub-panel by leaving
      // `serverPresetsLoaded` false. No error toast: the local presets row
      // and the existing apply path are unaffected.
      setServerPresetsLoaded(false);
    }
  }, []);

  useEffect(() => {
    void reloadServerPresets();
  }, [reloadServerPresets]);

  async function handleSaveServerPreset(): Promise<void> {
    const raw = window.prompt(
      "Save current settings as a shared preset (name):",
      isDirty ? `${activePresetName} (custom)` : activePresetName,
    );
    if (raw === null) return;
    const name = raw.trim();
    if (!name) {
      setError_("Preset name cannot be empty.");
      return;
    }
    setError_(null);
    setInfo_(null);
    setServerPresetBusy(true);
    try {
      await api.saveAudioLabPreset(name, config);
      await reloadServerPresets();
      setSelectedServerPreset(name);
      setInfo_(`Saved shared preset "${name}".`);
    } catch (err) {
      // The server enforces a 1–64 char alphanumeric+space+dash+underscore
      // rule and rejects the reserved "default" name. Surface the server's
      // error code in plain English so the operator knows how to fix it.
      const msg = describeError(err);
      if (msg === "invalid_name") {
        setError_(
          'Invalid preset name. Use 1–64 letters, digits, spaces, "-", or "_" and avoid the reserved name "default".',
        );
      } else {
        setError_(`Could not save preset: ${msg}`);
      }
    } finally {
      setServerPresetBusy(false);
    }
  }

  async function handleLoadServerPreset(): Promise<void> {
    if (!selectedServerPreset) {
      setError_("Pick a saved preset to load.");
      return;
    }
    setError_(null);
    setInfo_(null);
    setServerPresetBusy(true);
    try {
      const res = await api.getAudioLabPreset(selectedServerPreset);
      // Reuse the existing live-apply path so listeners pick up the change
      // through the same /v1/admin/audio-config push they already observe —
      // no parallel state machine.
      const cfg = res.config as AudioLabConfig;
      await api.setGlobalAudioConfig(cfg);
      setConfig(cloneConfig(cfg));
      setGlobalConfig({
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        liveBypassMicProcessing: Boolean(cfg.preImbe?.bypassMicProcessing ?? false),
      });
      setInfo_(`Loaded shared preset "${selectedServerPreset}" and applied live.`);
    } catch (err) {
      setError_(`Could not load preset: ${describeError(err)}`);
    } finally {
      setServerPresetBusy(false);
    }
  }

  async function handleRenameServerPreset(): Promise<void> {
    if (!selectedServerPreset) {
      setError_("Pick a saved preset to rename.");
      return;
    }
    const raw = window.prompt(`Rename "${selectedServerPreset}" to:`, selectedServerPreset);
    if (raw === null) return;
    const newName = raw.trim();
    if (!newName || newName === selectedServerPreset) {
      return;
    }
    // Guard against a typo silently overwriting a different existing preset.
    // The server's upsert is case-insensitive on name (matching the unique
    // index), so we mirror that check here. The case-only rename "Patrol" →
    // "patrol" is still allowed and folds into a single row.
    const collides = serverPresets.some(
      (p) =>
        p.name.toLowerCase() === newName.toLowerCase() &&
        p.name.toLowerCase() !== selectedServerPreset.toLowerCase(),
    );
    if (collides) {
      setError_(`A preset named "${newName}" already exists.`);
      return;
    }
    setError_(null);
    setInfo_(null);
    setServerPresetBusy(true);
    try {
      const res = await api.getAudioLabPreset(selectedServerPreset);
      // Save under the new name first so a transient failure can't leave the
      // agency with no preset at all (delete-then-save would).
      await api.saveAudioLabPreset(newName, res.config);
      // Skip the delete when the rename is just a case change — the server's
      // case-insensitive upsert already updated the existing row's display
      // name, and the delete would remove what we just saved.
      if (newName.toLowerCase() !== selectedServerPreset.toLowerCase()) {
        await api.deleteAudioLabPreset(selectedServerPreset);
      }
      await reloadServerPresets();
      setSelectedServerPreset(newName);
      setInfo_(`Renamed shared preset to "${newName}".`);
    } catch (err) {
      const msg = describeError(err);
      if (msg === "invalid_name") {
        setError_(
          'Invalid preset name. Use 1–64 letters, digits, spaces, "-", or "_" and avoid the reserved name "default".',
        );
      } else {
        setError_(`Could not rename preset: ${msg}`);
      }
    } finally {
      setServerPresetBusy(false);
    }
  }

  async function handleDeleteServerPreset(): Promise<void> {
    if (!selectedServerPreset) {
      setError_("Pick a saved preset to delete.");
      return;
    }
    if (!window.confirm(`Delete shared preset "${selectedServerPreset}"?`)) {
      return;
    }
    setError_(null);
    setInfo_(null);
    setServerPresetBusy(true);
    try {
      await api.deleteAudioLabPreset(selectedServerPreset);
      const deleted = selectedServerPreset;
      setSelectedServerPreset("");
      await reloadServerPresets();
      setInfo_(`Deleted shared preset "${deleted}".`);
    } catch (err) {
      setError_(`Could not delete preset: ${describeError(err)}`);
    } finally {
      setServerPresetBusy(false);
    }
  }

  async function handleMeasureLatency(): Promise<void> {
    setError_(null);
    setInfo_(null);
    setMeasuringLatency(true);
    try {
      const [rttMs, codecTiming] = await Promise.all([
        measureNetworkRtt(),
        measureCodecRoundtrip(labCodec),
      ]);
      setLatency({
        rttMs,
        encodeMs: codecTiming.encodeMs,
        decodeMs: codecTiming.decodeMs,
        codec: labCodec,
        takenAt: Date.now(),
      });
    } catch (err) {
      setError_(describeError(err));
    } finally {
      setMeasuringLatency(false);
    }
  }

  async function handlePushToChannel(): Promise<void> {
    if (!processedClip || processedClip.length === 0) {
      setError_("Process a clip first (press 'Process & Play').");
      return;
    }
    if (!pushChannel) {
      setError_("Pick a channel to push to.");
      return;
    }
    const channelRow = channels.find((c) => c.name === pushChannel);
    const channelCodec = channelRow ? coerceVoiceCodecClient(channelRow.codec) : null;
    if (channelRow && channelCodec !== labCodec && !confirmingPush) {
      setError_(
        `Channel "${pushChannel}" uses ${voiceCodecLabel(channelCodec)}, but you are testing ${voiceCodecLabel(labCodec)}. ` +
          "Change the Test codec dropdown to match, or pick a different channel. Click Push again to force anyway.",
      );
      setConfirmingPush(true);
      return;
    }
    if (!confirmingPush) {
      setConfirmingPush(true);
      return;
    }
    setConfirmingPush(false);
    setError_(null);
    setInfo_(`Pushing ${(processedClip.length / LAB_SAMPLE_RATE).toFixed(1)}s to "${pushChannel}"…`);
    setState("pushing");
    try {
      const handle = pushClipToChannel({
        channelName: pushChannel,
        pcm: processedClip,
        codec: labCodec,
      });
      await handle.finished;
      setInfo_(`Pushed to "${pushChannel}".`);
    } catch (err) {
      setError_(describeError(err));
    } finally {
      setState("idle");
    }
  }

  function updatePre<K extends keyof AudioLabConfig["preImbe"]>(
    key: K,
    value: AudioLabConfig["preImbe"][K],
  ): void {
    setConfig({ ...config, preImbe: { ...config.preImbe, [key]: value } });
  }
  function updatePost<K extends keyof AudioLabConfig["postDecode"]>(
    key: K,
    value: AudioLabConfig["postDecode"][K],
  ): void {
    setConfig({ ...config, postDecode: { ...config.postDecode, [key]: value } });
  }

  async function handleApplyGlobally(): Promise<void> {
    if (!confirmingGlobal) {
      setConfirmingGlobal(true);
      return;
    }
    setConfirmingGlobal(false);
    setApplyingGlobal(true);
    setError_(null);
    setInfo_(null);
    try {
      const res = await api.setGlobalAudioConfig(config);
      setGlobalConfig({
        updatedAt: res.updatedAt,
        updatedBy: res.updatedBy,
        liveBypassMicProcessing: Boolean(config.preImbe.bypassMicProcessing ?? false),
      });
      setInfo_(
        "Settings applied globally. Web users pick up the full pipeline; Android handsets " +
          "apply the boost (AGC + gain) and wind/noise toggles only — EQ, post-decode filters, " +
          "and upsample mode are listen-only on the web console.",
      );
    } catch (err) {
      setError_(`Could not apply globally: ${describeError(err)}`);
    } finally {
      setApplyingGlobal(false);
    }
  }

  // One-click revert to the no-DSP baseline: push DEFAULT_PRESET (duplicate
  // upsample, every post-decode shaping toggle off) to all users + handsets.
  // The server's deriver collapses that to a null post-decode block, so
  // clients drop back to the plain decode → duplicate-upsample fast path on
  // their next reconnect — i.e. the original "sounded great on IMBE" voice
  // before any Audio Lab tuning. Two-click confirm, same as Apply live.
  async function handleResetToBaseline(): Promise<void> {
    if (!confirmingBaseline) {
      setConfirmingGlobal(false);
      setConfirmingBaseline(true);
      return;
    }
    setConfirmingBaseline(false);
    setResettingBaseline(true);
    setError_(null);
    setInfo_(null);
    try {
      const baseline = cloneConfig(DEFAULT_PRESET);
      const res = await api.setGlobalAudioConfig(baseline);
      setConfig(baseline);
      setActivePresetName("Default IMBE");
      setGlobalConfig({
        updatedAt: res.updatedAt,
        updatedBy: res.updatedBy,
        liveBypassMicProcessing: Boolean(baseline.preImbe.bypassMicProcessing ?? false),
      });
      setInfo_(
        "Reset to baseline — the post-decode DSP chain is now OFF for everyone. " +
          "Handsets and web clients fall back to the plain decode → duplicate-upsample path " +
          "on their next reconnect, so voice returns to the original IMBE baseline. " +
          "Save it as a preset if you want a one-click anchor for future A/B tuning.",
      );
    } catch (err) {
      setError_(`Could not reset to baseline: ${describeError(err)}`);
    } finally {
      setResettingBaseline(false);
    }
  }

  const busy = state === "recording" || state === "processing" || state === "playing" || state === "pushing";

  return (
    <div className="audio-lab">
      <header>
        <h2>Audio Lab</h2>
        <p className="muted">
          Record a short clip, round-trip it through a voice codec (IMBE, Codec2, or Opus), and tune the
          mic and playback chain. Optionally push onto a real channel. Nothing here changes production
          audio until you apply settings live or save a shared preset.
        </p>
      </header>

      {error && <div className="audio-lab-banner error">{error}</div>}
      {info && !error && <div className="audio-lab-banner info">{info}</div>}

      <section className="audio-lab-presets" aria-label="Test codec">
        <label>
          <span>Test codec</span>
          <select
            value={labCodec}
            onChange={(e) => setLabCodec(e.target.value as VoiceCodec)}
            disabled={busy}
            title="Which voice codec to use for preview, production A/B, and channel push."
          >
            {VOICE_CODECS.map((c) => (
              <option key={c} value={c}>
                {VOICE_CODEC_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {pushChannel && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => {
              const ch = channels.find((c) => c.name === pushChannel);
              if (ch) {
                const next = coerceVoiceCodecClient(ch.codec);
                setLabCodec(next);
                setInfo_(`Test codec set to ${voiceCodecLabel(next)} (matches ${pushChannel}).`);
              }
            }}
            title="Set the test codec to match the selected push channel."
          >
            Match channel codec
          </button>
        )}
        <span className="muted small">
          Presets below tune mic and playback processing; they do not change the codec. For over-the-air
          push, the test codec should match the channel (Channels tab).
        </span>
      </section>

      <section className="audio-lab-record">
        <div className="audio-lab-buttons">
          {state === "recording" ? (
            <button className="btn danger" onClick={handleStopRecord}>
              Stop ({recordingSeconds.toFixed(1)}s)
            </button>
          ) : (
            <button className="btn" onClick={handleStartRecord} disabled={busy}>
              Record (up to {MAX_CLIP_SECONDS}s)
            </button>
          )}
          <button
            className="btn"
            onClick={handlePlayOriginal}
            disabled={busy || !recordedClip || recordedClip.length === 0}
          >
            Play original
          </button>
          <button
            className="btn"
            onClick={handlePlayProduction}
            disabled={busy || !recordedClip || recordedClip.length === 0}
            title="Run the clip through the live TX conditioner and the selected codec (production-style decode, no custom post-EQ)."
          >
            ▶ Play with live server settings
          </button>
          <button
            className="btn primary"
            onClick={handleProcessAndPlay}
            disabled={busy || !recordedClip || recordedClip.length === 0}
            title="Run the recorded clip through the pipeline configured below."
          >
            ▶ Play with my settings
          </button>
        </div>
        <div className="muted small">
          {recordedClip
            ? `Clip: ${(recordedClip.length / LAB_SAMPLE_RATE).toFixed(1)}s recorded. Use the two ▶ buttons to A/B the production path against your custom settings on the same clip.`
            : "No clip recorded yet."}
        </div>
      </section>

      <section className="audio-lab-presets">
        <label>
          <span>Preset</span>
          <select value={activePresetName} onChange={(e) => handleSelectPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.builtin ? " (built-in)" : ""}
              </option>
            ))}
          </select>
        </label>
        {isDirty && <span className="audio-lab-dirty">(unsaved changes)</span>}
        <button className="btn sm" onClick={handleSaveAs}>
          Save as…
        </button>
        <button
          className="btn sm"
          onClick={handleDeletePreset}
          disabled={presets.find((p) => p.name === activePresetName)?.builtin ?? true}
        >
          Delete
        </button>
        <button
          className="btn sm"
          onClick={() => {
            // Look up the selected preset across both built-ins and the user-saved list
            // so resetting a custom preset goes back to its own baseline, not Default IMBE.
            const preset = presets.find((p) => p.name === activePresetName);
            setConfig(cloneConfig(preset?.config ?? DEFAULT_PRESET));
          }}
          disabled={!isDirty}
        >
          Reset to preset
        </button>
      </section>

      {/* Server-side, agency-wide preset catalog. Renders only if the server
          exposes the /v1/admin/audio-lab-presets routes — older deployments
          quietly skip this row. The local-presets section above keeps working
          either way. */}
      {serverPresetsLoaded && (
        <section className="audio-lab-presets" aria-label="Shared audio presets">
          <label>
            <span>Shared preset</span>
            <select
              value={selectedServerPreset}
              onChange={(e) => setSelectedServerPreset(e.target.value)}
              disabled={serverPresetBusy}
            >
              <option value="">
                {serverPresets.length === 0
                  ? "(no saved presets)"
                  : "— Pick a saved preset —"}
              </option>
              {serverPresets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.summary ? ` · ${p.summary}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn sm"
            onClick={() => void handleSaveServerPreset()}
            disabled={serverPresetBusy}
            title="Save the current Audio Lab settings as a shared preset all agency admins can load."
          >
            Save as preset…
          </button>
          <button
            className="btn sm"
            onClick={() => void handleLoadServerPreset()}
            disabled={serverPresetBusy || !selectedServerPreset}
            title="Apply this saved preset live (pushes through the same path as 'Apply live')."
          >
            Load
          </button>
          <button
            className="btn sm"
            onClick={() => void handleRenameServerPreset()}
            disabled={serverPresetBusy || !selectedServerPreset}
          >
            Rename
          </button>
          <button
            className="btn sm"
            onClick={() => void handleDeleteServerPreset()}
            disabled={serverPresetBusy || !selectedServerPreset}
          >
            Delete
          </button>
        </section>
      )}

      {/* View mode toggle */}
      <div className="audio-lab-view-toggle">
        <button
          className={"btn sm" + (viewMode === "simple" ? " primary" : "")}
          onClick={() => handleViewModeChange("simple")}
        >
          Simple
        </button>
        <button
          className={"btn sm" + (viewMode === "advanced" ? " primary" : "")}
          onClick={() => handleViewModeChange("advanced")}
        >
          Advanced tuning
        </button>
      </div>

      {/* Simple controls */}
      {viewMode === "simple" && (
        <SimpleControls config={config} setConfig={setConfig} labCodec={labCodec} />
      )}

      {/* Apply globally button — visible in both views */}
      <div className="audio-lab-global-apply">
        <button
          className={"btn" + (confirmingGlobal ? " danger" : " primary")}
          onClick={() => void handleApplyGlobally()}
          disabled={applyingGlobal}
        >
          {applyingGlobal
            ? "Applying…"
            : confirmingGlobal
              ? "Are you sure? This affects everyone — click again to confirm"
              : "Apply live — push to all users & handsets"}
        </button>
        {confirmingGlobal && (
          <button className="btn sm" onClick={() => setConfirmingGlobal(false)}>
            Cancel
          </button>
        )}
        <button
          className={"btn sm" + (confirmingBaseline ? " danger" : "")}
          onClick={() => void handleResetToBaseline()}
          disabled={resettingBaseline || applyingGlobal}
          title="Turn off the entire post-decode DSP chain for everyone and return to the plain IMBE baseline (duplicate upsample, no EQ/presence/saturation)."
        >
          {resettingBaseline
            ? "Resetting…"
            : confirmingBaseline
              ? "Reset everyone to the no-DSP baseline? Click again to confirm"
              : "Reset to baseline (no DSP)"}
        </button>
        {confirmingBaseline && (
          <button className="btn sm" onClick={() => setConfirmingBaseline(false)}>
            Cancel
          </button>
        )}
        {globalConfig.updatedAt && (
          <span className="muted small audio-lab-global-stamp">
            Last applied {new Date(globalConfig.updatedAt).toLocaleString()}
            {globalConfig.updatedBy ? ` by ${globalConfig.updatedBy}` : ""}
          </span>
        )}
      </div>

      <section className="audio-lab-pipeline">
        {viewMode === "advanced" && (<>
        <fieldset>
          <legend>Before encoding — clean up the mic signal</legend>
          <Toggle
            label="Bridge-style minimal mic (browser DSP off, no expander/AGC)"
            value={config.preImbe.bypassMicProcessing ?? false}
            onChange={(v) => updatePre("bypassMicProcessing", v)}
          />
          <div className="muted small">
            When on: handsets and web clients disable browser-side echo/noise/AGC
            and the TX conditioner runs HPF + LPF only. Matches the radio-bridge
            mic chain — use if hand-held audio sounds "processed" vs the bridge
            feed on the same channel.
          </div>
          <Toggle
            label="Wind gate (adaptive)"
            value={config.preImbe.windGateEnabled}
            onChange={(v) => updatePre("windGateEnabled", v)}
          />
          <RangeRow
            label="Wind gate threshold"
            unit="dB"
            min={0}
            max={18}
            step={1}
            value={config.preImbe.windGateThresholdDb}
            disabled={!config.preImbe.windGateEnabled}
            onChange={(v) => updatePre("windGateThresholdDb", v)}
          />
          <RangeRow
            label="Wind gate attenuation"
            unit="dB"
            min={-30}
            max={-6}
            step={1}
            value={config.preImbe.windGateAttenuationDb}
            disabled={!config.preImbe.windGateEnabled}
            onChange={(v) => updatePre("windGateAttenuationDb", v)}
          />
          <Toggle
            label="Wind HPF (steep)"
            value={config.preImbe.windHpfEnabled}
            onChange={(v) => updatePre("windHpfEnabled", v)}
          />
          <RangeRow
            label="Wind HPF cutoff"
            unit="Hz"
            min={120}
            max={300}
            step={10}
            value={config.preImbe.windHpfHz}
            disabled={!config.preImbe.windHpfEnabled}
            onChange={(v) => updatePre("windHpfHz", v)}
          />
          <label className={"audio-lab-range" + (!config.preImbe.windHpfEnabled ? " disabled" : "")}>
            <span className="audio-lab-range-label">Wind HPF slope</span>
            <select
              value={config.preImbe.windHpfOrder}
              disabled={!config.preImbe.windHpfEnabled}
              onChange={(e) => updatePre("windHpfOrder", Number(e.target.value) as 2 | 4 | 6)}
            >
              <option value={2}>12 dB/oct</option>
              <option value={4}>24 dB/oct</option>
              <option value={6}>36 dB/oct</option>
            </select>
          </label>
          <Toggle
            label="High-pass filter"
            value={config.preImbe.hpfEnabled}
            onChange={(v) => updatePre("hpfEnabled", v)}
          />
          <RangeRow
            label="HPF cutoff"
            unit="Hz"
            min={60}
            max={400}
            step={10}
            value={config.preImbe.hpfHz}
            disabled={!config.preImbe.hpfEnabled}
            onChange={(v) => updatePre("hpfHz", v)}
          />
          <Toggle
            label="Low-pass filter"
            value={config.preImbe.lpfEnabled}
            onChange={(v) => updatePre("lpfEnabled", v)}
          />
          <RangeRow
            label="LPF cutoff"
            unit="Hz"
            min={2800}
            max={3800}
            step={50}
            value={config.preImbe.lpfHz}
            disabled={!config.preImbe.lpfEnabled}
            onChange={(v) => updatePre("lpfHz", v)}
          />
          <Toggle
            label="Makeup AGC"
            value={config.preImbe.agcEnabled}
            onChange={(v) => updatePre("agcEnabled", v)}
          />
          <RangeRow
            label="AGC target RMS"
            unit=""
            min={2000}
            max={12000}
            step={500}
            value={config.preImbe.agcTargetRms}
            disabled={!config.preImbe.agcEnabled}
            onChange={(v) => updatePre("agcTargetRms", v)}
          />
          <RangeRow
            label="AGC max gain"
            unit="×"
            min={1}
            max={12}
            step={1}
            value={config.preImbe.agcMaxGain}
            disabled={!config.preImbe.agcEnabled}
            onChange={(v) => updatePre("agcMaxGain", v)}
          />
        </fieldset>

        <fieldset>
          <legend>Vocoder ({VOICE_CODEC_LABEL[labCodec]})</legend>
          <Toggle
            label="Bypass vocoder (clean PCM only)"
            value={config.vocoder.bypass}
            onChange={(v) => setConfig({ ...config, vocoder: { bypass: v } })}
          />
          <div className="muted small">
            When bypass is OFF, the clip round-trips through <b>{VOICE_CODEC_LABEL[labCodec]}</b> (encode →
            decode), the same way a real on-air talk-spurt does. Change the <b>Test codec</b> dropdown above
            to compare IMBE, Codec2, and Opus.
          </div>
        </fieldset>

        <fieldset disabled={config.vocoder.bypass}>
          <legend>After decoding — shape the sound for playback</legend>
          <RangeRow
            label="Radio character"
            unit={
              (config.postDecode.dmrCharacter ?? 0) === 0
                ? "off"
                : `/ 100`
            }
            min={0}
            max={100}
            step={1}
            value={config.postDecode.dmrCharacter ?? 0}
            onChange={(v) => updatePost("dmrCharacter", v)}
          />
          {(config.postDecode.dmrCharacter ?? 0) > 0 && (
            <div className="muted small">
              One-knob preset for the &ldquo;trunked digital radio&rdquo; sound.
              Higher values narrow the audio band (HPF / LPF), add a presence
              bell at 2.2 kHz, and increase soft saturation — mimicking what
              AMBE+2 / DMR hardware does internally. Overrides the HPF, LPF,
              presence, and saturation fields below; leave at 0 to dial those
              manually.
            </div>
          )}
          <label>
            <span>Upsample mode</span>
            <select
              value={config.postDecode.upsampleMode}
              onChange={(e) => updatePost("upsampleMode", e.target.value as UpsampleMode)}
            >
              <option value="duplicate">8 → 16 kHz · Duplicate (current default)</option>
              <option value="linear">8 → 16 kHz · Linear interpolation</option>
              <option value="polyphase">8 → 16 kHz · Polyphase (windowed-sinc)</option>
              <option value="polyphase24">8 → 24 kHz · Polyphase + playback resample (listen-only)</option>
            </select>
          </label>
          {config.postDecode.upsampleMode === "polyphase24" && (
            <div className="muted small">
              24 kHz output is rendered into the lab&apos;s playback buffer only.
              Channel push stays at 16 kHz on the wire. IMBE and Codec2 are band-limited to ~4 kHz;
              Opus is wideband at 16 kHz. Worth A/B-ing against
              the standard polyphase mode — the audible delta is usually subtle.
            </div>
          )}
          <Toggle
            label="Post-decode HPF"
            value={config.postDecode.hpfEnabled}
            onChange={(v) => updatePost("hpfEnabled", v)}
          />
          <RangeRow
            label="HPF cutoff"
            unit="Hz"
            min={150}
            max={400}
            step={10}
            value={config.postDecode.hpfHz}
            disabled={!config.postDecode.hpfEnabled}
            onChange={(v) => updatePost("hpfHz", v)}
          />
          <Toggle
            label="Post-decode LPF"
            value={config.postDecode.lpfEnabled}
            onChange={(v) => updatePost("lpfEnabled", v)}
          />
          <RangeRow
            label="LPF cutoff"
            unit="Hz"
            min={2800}
            max={3800}
            step={50}
            value={config.postDecode.lpfHz}
            disabled={!config.postDecode.lpfEnabled}
            onChange={(v) => updatePost("lpfHz", v)}
          />
          <Toggle
            label="Low-shelf EQ"
            value={config.postDecode.lowShelfEnabled}
            onChange={(v) => updatePost("lowShelfEnabled", v)}
          />
          <RangeRow
            label="Low-shelf cutoff"
            unit="Hz"
            min={80}
            max={400}
            step={10}
            value={config.postDecode.lowShelfHz}
            disabled={!config.postDecode.lowShelfEnabled}
            onChange={(v) => updatePost("lowShelfHz", v)}
          />
          <RangeRow
            label="Low-shelf gain"
            unit="dB"
            min={-6}
            max={9}
            step={0.5}
            value={config.postDecode.lowShelfDb}
            disabled={!config.postDecode.lowShelfEnabled}
            onChange={(v) => updatePost("lowShelfDb", v)}
          />
          <Toggle
            label="High-shelf EQ"
            value={config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfEnabled", v)}
          />
          <RangeRow
            label="High-shelf cutoff"
            unit="Hz"
            min={1500}
            max={3500}
            step={100}
            value={config.postDecode.highShelfHz}
            disabled={!config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfHz", v)}
          />
          <RangeRow
            label="High-shelf gain"
            unit="dB"
            min={-6}
            max={4}
            step={0.5}
            value={config.postDecode.highShelfDb}
            disabled={!config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfDb", v)}
          />
          {/* Presence bell — narrow boost/cut to mimic the consonant-band
              emphasis AMBE+2 applies internally. Used by the AMBE+2
              character preset; can be tweaked freely here. */}
          <Toggle
            label="Presence bell (peaking EQ)"
            value={config.postDecode.presenceEnabled ?? false}
            onChange={(v) => updatePost("presenceEnabled", v)}
          />
          <RangeRow
            label="Presence cutoff"
            unit="Hz"
            min={1200}
            max={3000}
            step={50}
            value={config.postDecode.presenceHz ?? 2200}
            disabled={!config.postDecode.presenceEnabled}
            onChange={(v) => updatePost("presenceHz", v)}
          />
          <RangeRow
            label="Presence gain"
            unit="dB"
            min={-6}
            max={6}
            step={0.5}
            value={config.postDecode.presenceDb ?? 0}
            disabled={!config.postDecode.presenceEnabled}
            onChange={(v) => updatePost("presenceDb", v)}
          />
          <RangeRow
            label="Presence Q"
            unit=""
            min={0.4}
            max={2.0}
            step={0.1}
            value={config.postDecode.presenceQ ?? 1.0}
            disabled={!config.postDecode.presenceEnabled}
            onChange={(v) => updatePost("presenceQ", v)}
          />
          {/* Soft-saturation waveshaper. Adds the "compressed warmth" of a
              hardware vocoder; 0 disables it entirely. */}
          <RangeRow
            label="Soft saturation"
            unit=""
            min={0}
            max={1}
            step={0.05}
            value={config.postDecode.saturationAmount ?? 0}
            onChange={(v) => updatePost("saturationAmount", v)}
          />
          {/* Compressor / AGC — feed-forward, runs after the biquads and
              before saturation. Pinned defaults: threshold -24 dB, ratio 3,
              attack 5 ms, release 80 ms, makeup 0 dB. */}
          <Toggle
            label="Compressor / AGC"
            value={config.postDecode.compressorEnabled ?? false}
            onChange={(v) => updatePost("compressorEnabled", v)}
          />
          <RangeRow
            label="Threshold"
            unit="dB"
            min={-60}
            max={0}
            step={1}
            value={config.postDecode.compressorThresholdDb ?? -24}
            disabled={!config.postDecode.compressorEnabled}
            onChange={(v) => updatePost("compressorThresholdDb", v)}
          />
          <RangeRow
            label="Ratio"
            unit=": 1"
            min={1}
            max={20}
            step={0.5}
            value={config.postDecode.compressorRatio ?? 3}
            disabled={!config.postDecode.compressorEnabled}
            onChange={(v) => updatePost("compressorRatio", v)}
          />
          <RangeRow
            label="Attack"
            unit="ms"
            min={1}
            max={200}
            step={1}
            value={config.postDecode.compressorAttackMs ?? 5}
            disabled={!config.postDecode.compressorEnabled}
            onChange={(v) => updatePost("compressorAttackMs", v)}
          />
          <RangeRow
            label="Release"
            unit="ms"
            min={5}
            max={2000}
            step={5}
            value={config.postDecode.compressorReleaseMs ?? 80}
            disabled={!config.postDecode.compressorEnabled}
            onChange={(v) => updatePost("compressorReleaseMs", v)}
          />
          <RangeRow
            label="Make-up gain"
            unit="dB"
            min={-12}
            max={24}
            step={0.5}
            value={config.postDecode.compressorMakeupDb ?? 0}
            disabled={!config.postDecode.compressorEnabled}
            onChange={(v) => updatePost("compressorMakeupDb", v)}
          />
          {/* Wideband: also run this whole chain on Opus (16 kHz) channels.
              Has no effect on the clip preview above (an 8 kHz IMBE round-
              trip), but is what live Opus listeners get. Shapes nothing on
              its own — only unlocks the Opus post-decode path. */}
          <Toggle
            label="Apply chain to Opus (wideband) channels"
            value={config.postDecode.wideband ?? false}
            onChange={(v) => updatePost("wideband", v)}
          />
          <div className="muted small">
            Off by default. When on, the filters / compressor / saturation
            above also shape Opus (16 kHz) channels, not just the 8 kHz
            vocoders. The clip preview is an 8 kHz round-trip, so this toggle
            doesn&apos;t change the A/B — it only affects live Opus listeners.
          </div>
        </fieldset>

        <fieldset>
          <legend>End-of-transmission cue (listeners hear it)</legend>
          <div className="muted small">
            When another unit unkeys, each listener on the channel synthesizes
            this cue locally and plays it into their own audio — precise timing,
            clean PCM, and the talker is correctly excluded. Both segments are
            off by default.
          </div>
          {/* Roger beep — single sine, 6 ms cosine fades. Pinned defaults
              1200 Hz / 120 ms. */}
          <Toggle
            label="Roger beep"
            value={config.postDecode.rogerBeepEnabled ?? false}
            onChange={(v) => updatePost("rogerBeepEnabled", v)}
          />
          <RangeRow
            label="Beep frequency"
            unit="Hz"
            min={300}
            max={4000}
            step={50}
            value={config.postDecode.rogerBeepHz ?? 1200}
            disabled={!config.postDecode.rogerBeepEnabled}
            onChange={(v) => updatePost("rogerBeepHz", v)}
          />
          <RangeRow
            label="Beep length"
            unit="ms"
            min={20}
            max={500}
            step={10}
            value={config.postDecode.rogerBeepMs ?? 120}
            disabled={!config.postDecode.rogerBeepEnabled}
            onChange={(v) => updatePost("rogerBeepMs", v)}
          />
          {/* Comfort-noise squelch tail — deterministic LCG noise, same
              cosine fades. Pinned defaults 90 ms / level 0.05. */}
          <Toggle
            label="Comfort-noise squelch tail"
            value={config.postDecode.squelchTailEnabled ?? false}
            onChange={(v) => updatePost("squelchTailEnabled", v)}
          />
          <RangeRow
            label="Tail length"
            unit="ms"
            min={20}
            max={500}
            step={10}
            value={config.postDecode.squelchTailMs ?? 90}
            disabled={!config.postDecode.squelchTailEnabled}
            onChange={(v) => updatePost("squelchTailMs", v)}
          />
          <RangeRow
            label="Tail level"
            unit=""
            min={0}
            max={0.5}
            step={0.01}
            value={config.postDecode.squelchTailLevel ?? 0.05}
            disabled={!config.postDecode.squelchTailEnabled}
            onChange={(v) => updatePost("squelchTailLevel", v)}
          />
        </fieldset>
        </>)}
      </section>

      <section className="audio-lab-latency">
        <h3>Mouth-to-ear latency</h3>
        <p className="muted small">
          Estimated time from when you key up and speak to when another device starts
          hearing you. The network and codec rows are measured live; the rest are the
          known frame/buffer sizes in the production code path.
        </p>
        <button className="btn sm" onClick={handleMeasureLatency} disabled={measuringLatency || busy}>
          {measuringLatency ? "Measuring…" : latency ? "Re-measure" : "Measure now"}
        </button>
        <LatencyBreakdown latency={latency} labCodec={labCodec} />
      </section>

      <section className="audio-lab-server-config">
        <h3>Live server audio config</h3>
        <p className="muted small">
          What the production audio path is doing right now. These are the values baked
          into the running build — the Audio Lab settings above don't affect them.
        </p>
        <table className="audio-lab-config-table">
          <tbody>
            <tr>
              <td>Vocoder</td>
              <td>{PRODUCTION_AUDIO_CONFIG.codec}</td>
            </tr>
            <tr>
              <td>Voice bitrate</td>
              <td>{PRODUCTION_AUDIO_CONFIG.voiceBitrateBps} bps</td>
            </tr>
            <tr>
              <td>IMBE frame cadence</td>
              <td>{PRODUCTION_AUDIO_CONFIG.imbeFrameMs} ms on-air</td>
            </tr>
            <tr>
              <td>PCM sideband cadence</td>
              <td>{PRODUCTION_AUDIO_CONFIG.pcmSidebandFrameMs} ms (recorder + AI)</td>
            </tr>
            <tr>
              <td>TX pre-conditioner</td>
              <td>{PRODUCTION_AUDIO_CONFIG.txPreEmphasis}</td>
            </tr>
            <tr>
              <td>RX post-decode shaping</td>
              <td>{PRODUCTION_AUDIO_CONFIG.rxPostDecode}</td>
            </tr>
            <tr>
              <td>RX upsample</td>
              <td>{PRODUCTION_AUDIO_CONFIG.rxUpsample}</td>
            </tr>
            <tr>
              <td>Listener jitter cushion</td>
              <td>{PRODUCTION_AUDIO_CONFIG.listenerJitterCushionMs} ms</td>
            </tr>
            <tr>
              <td>Air-slot TTL</td>
              <td>{PRODUCTION_AUDIO_CONFIG.airSlotTtlMs} ms</td>
            </tr>
            <tr>
              <td>Per-peer buffer limit</td>
              <td>{PRODUCTION_AUDIO_CONFIG.peerBufferLimitKB} KB (then frame drop)</td>
            </tr>
            <tr>
              <td>Sideband recording</td>
              <td>{PRODUCTION_AUDIO_CONFIG.recordingSideband}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="audio-lab-push">
        <h3>Push to channel (over-the-air test)</h3>
        <p className="muted small">
          Press <b>Process & play</b> first, then key the same processed clip onto a real channel
          to hear how it sounds on a handset. The push appears as a transmission from unit{" "}
          <code>LAB</code>. If the <b>Test codec</b> does not match the channel&apos;s codec (set under
          Admin → Channels), the app will warn you before pushing — wrong codec means handsets may not
          play it.
        </p>
        <div className="audio-lab-push-row">
          <label>
            <span>Channel</span>
            <select value={pushChannel} onChange={(e) => setPushChannel(e.target.value)}>
              {channels.length === 0 && <option value="">(no talk-capable channels)</option>}
              {channels.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({voiceCodecLabel(coerceVoiceCodecClient(c.codec))})
                </option>
              ))}
            </select>
          </label>
          <button
            className={"btn" + (confirmingPush ? " danger" : "")}
            onClick={handlePushToChannel}
            disabled={busy || !processedClip || !pushChannel}
          >
            {state === "pushing"
              ? "Pushing…"
              : confirmingPush
                ? `Click again — really key "${pushChannel}"`
                : "Push to channel"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="audio-lab-toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function LatencyBreakdown({
  latency,
  labCodec,
}: {
  latency: LatencyMeasurement | null;
  labCodec: VoiceCodec;
}) {
  const codecLabel = VOICE_CODEC_LABEL[labCodec];
  // Fixed components of the production path (in milliseconds). Half the worklet frame
  // is the average wait between PTT start and the first 40 ms chunk being emitted; the
  // listener cushion is `playHead` in voiceClient.ts; the output buffer is a typical
  // Web Audio latency on desktop browsers.
  const FIXED = {
    micWaitMs: 20, // half of the 40 ms worklet frame, on average
    preConditionMs: 1, // pre-IMBE biquads + AGC per frame
    relayForwardMs: 1, // claimAir + broadcastExcept loop
    listenerCushionMs: PRODUCTION_AUDIO_CONFIG.listenerJitterCushionMs,
    outputBufferMs: 20,
  };

  if (!latency) {
    return (
      <div className="muted small">
        Click <b>Measure now</b> to ping the server and time {codecLabel} encode/decode on this device.
      </div>
    );
  }

  const total =
    FIXED.micWaitMs +
    FIXED.preConditionMs +
    latency.encodeMs +
    latency.rttMs +
    FIXED.relayForwardMs +
    latency.decodeMs +
    FIXED.listenerCushionMs +
    FIXED.outputBufferMs;

  const rows: { label: string; value: string; note?: string }[] = [
    { label: "Mic capture wait (½ worklet frame)", value: `${FIXED.micWaitMs} ms` },
    { label: "TX conditioning", value: `~${FIXED.preConditionMs} ms` },
    {
      label: `${VOICE_CODEC_LABEL[latency.codec]} encode (measured)`,
      value: `${latency.encodeMs.toFixed(2)} ms`,
    },
    { label: "Network round-trip (measured)", value: `${latency.rttMs.toFixed(1)} ms` },
    { label: "Relay forward", value: `~${FIXED.relayForwardMs} ms` },
    {
      label: `${VOICE_CODEC_LABEL[latency.codec]} decode (measured)`,
      value: `${latency.decodeMs.toFixed(2)} ms`,
    },
    { label: "Listener jitter cushion", value: `${FIXED.listenerCushionMs} ms` },
    { label: "Web Audio output buffer", value: `~${FIXED.outputBufferMs} ms` },
  ];

  return (
    <table className="audio-lab-config-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>{r.value}</td>
          </tr>
        ))}
        <tr className="audio-lab-latency-total">
          <td>
            <b>Estimated mouth-to-ear total</b>
          </td>
          <td>
            <b>{total.toFixed(0)} ms</b>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function RangeRow({
  label,
  unit,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={"audio-lab-range" + (disabled ? " disabled" : "")}>
      <span className="audio-lab-range-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="audio-lab-range-value">
        {step < 1 ? value.toFixed(1) : value} {unit}
      </span>
    </label>
  );
}
