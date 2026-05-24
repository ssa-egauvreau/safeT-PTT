import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError, type UserChannel } from "../../api";
import { imbeDecode, imbeEncode, imbeReady, initImbe } from "../../voice/imbeVocoder";
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET,
  processClip,
  processClipProduction,
  type AudioLabConfig,
  type UpsampleMode,
} from "./audioLab/pipeline";
import { LAB_SAMPLE_RATE, MAX_CLIP_SECONDS, startLabRecorder, type LabRecorder } from "./audioLab/recorder";
import { deleteUserPreset, listPresets, saveUserPreset, type PresetRecord } from "./audioLab/presets";
import { pushClipToChannel } from "./audioLab/channelPush";

type LabState = "idle" | "recording" | "processing" | "playing" | "pushing";

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
  /** Time to IMBE-encode one 20 ms frame (ms). */
  encodeMs: number;
  /** Time to IMBE-decode one frame (ms). */
  decodeMs: number;
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

async function measureCodecRoundtrip(): Promise<{ encodeMs: number; decodeMs: number }> {
  if (!imbeReady()) {
    const ok = await initImbe();
    if (!ok) throw new Error("IMBE WASM is not loaded");
  }
  // 160-sample 8 kHz sine — exercise the codec on a realistic signal, not silence.
  const probe = new Int16Array(160);
  for (let i = 0; i < 160; i++) {
    probe[i] = Math.round(Math.sin((2 * Math.PI * 500 * i) / 8000) * 8000);
  }
  let encodeTotal = 0;
  let decodeTotal = 0;
  const ITER = 50;
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const cw = imbeEncode(probe);
    const t1 = performance.now();
    if (!cw) continue;
    imbeDecode(cw);
    const t2 = performance.now();
    encodeTotal += t1 - t0;
    decodeTotal += t2 - t1;
  }
  return { encodeMs: encodeTotal / ITER, decodeMs: decodeTotal / ITER };
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
  const [state, setState] = useState<LabState>("idle");
  const [recording, setRecording] = useState<LabRecorder | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedClip, setRecordedClip] = useState<Int16Array | null>(null);
  const [processedClip, setProcessedClip] = useState<Int16Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Channel push state.
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [pushChannel, setPushChannel] = useState("");
  const [confirmingPush, setConfirmingPush] = useState(false);

  // Latency measurement state.
  const [latency, setLatency] = useState<LatencyMeasurement | null>(null);
  const [measuringLatency, setMeasuringLatency] = useState(false);

  const playCtxRef = useRef<AudioContext | null>(null);
  const playSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const recordTimerRef = useRef<number | null>(null);

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

  // Detect when the live config drifts from the named preset.
  const isDirty = useMemo(() => {
    const preset = presets.find((p) => p.name === activePresetName);
    return preset ? !configsEqual(preset.config, config) : true;
  }, [config, activePresetName, presets]);

  // Stop any in-flight playback when the user leaves the panel.
  useEffect(() => {
    return () => {
      try {
        playSourceRef.current?.stop();
      } catch {
        /* already stopped */
      }
      void playCtxRef.current?.close().catch(() => undefined);
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
      }
      recording?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        onAutoStop: () => {
          // Auto-stop fired from inside the recorder when the cap is hit.
          handleStopRecord();
        },
      });
      setRecording(rec);
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

  function handleStopRecord(): void {
    const rec = recording;
    if (!rec) {
      setState("idle");
      return;
    }
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const pcm = rec.stop();
    setRecording(null);
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
      processed = await processClip(recordedClip, config);
    } catch (err) {
      setError_(describeError(err));
      setState("idle");
      return;
    }
    setProcessedClip(processed);
    await playPcm(processed);
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
      processed = await processClipProduction(recordedClip);
    } catch (err) {
      setError_(describeError(err));
      setState("idle");
      return;
    }
    // Don't overwrite `processedClip` — that one is what the Channel Push uses, and
    // it should reflect the user's custom settings, not the production reference.
    await playPcm(processed);
  }

  async function handlePlayOriginal(): Promise<void> {
    if (!recordedClip || recordedClip.length === 0) {
      setError_("Record a clip first.");
      return;
    }
    setError_(null);
    setInfo_(null);
    await playPcm(recordedClip);
  }

  async function playPcm(pcm: Int16Array): Promise<void> {
    // Tear down any previous playback.
    try {
      playSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: LAB_SAMPLE_RATE });
    }
    const ctx = playCtxRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const buffer = ctx.createBuffer(1, pcm.length, LAB_SAMPLE_RATE);
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

  async function handleMeasureLatency(): Promise<void> {
    setError_(null);
    setInfo_(null);
    setMeasuringLatency(true);
    try {
      const [rttMs, codec] = await Promise.all([measureNetworkRtt(), measureCodecRoundtrip()]);
      setLatency({ rttMs, encodeMs: codec.encodeMs, decodeMs: codec.decodeMs, takenAt: Date.now() });
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

  const busy = state === "recording" || state === "processing" || state === "playing" || state === "pushing";

  return (
    <div className="audio-lab">
      <header>
        <h2>Audio Lab</h2>
        <p className="muted">
          Record a short clip, run it through a configurable IMBE pipeline, and play it back to hear the
          effect of each setting. Optionally push the processed clip onto a real channel to hear it
          over the air. Nothing here changes the production audio path until you wire a preset in.
        </p>
      </header>

      {error && <div className="audio-lab-banner error">{error}</div>}
      {info && !error && <div className="audio-lab-banner info">{info}</div>}

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
            title="Run the recorded clip through the exact production audio path (live ImbeTxConditioner + IMBE round-trip + sample-duplicate upsample, no post-decode shaping)."
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
        <button className="btn sm" onClick={() => setConfig(cloneConfig(BUILTIN_PRESETS[activePresetName] ?? DEFAULT_PRESET))} disabled={!isDirty}>
          Reset to preset
        </button>
      </section>

      <section className="audio-lab-pipeline">
        <fieldset>
          <legend>Pre-IMBE conditioning</legend>
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
          <legend>Vocoder</legend>
          <Toggle
            label="Bypass IMBE (clean PCM only)"
            value={config.vocoder.bypass}
            onChange={(v) => setConfig({ ...config, vocoder: { bypass: v } })}
          />
          <div className="muted small">When bypass is OFF, the clip round-trips through the IMBE vocoder (encode → decode) the same way a real on-air talk-spurt does.</div>
        </fieldset>

        <fieldset disabled={config.vocoder.bypass}>
          <legend>Post-decode shaping</legend>
          <label>
            <span>Upsample 8 → 16 kHz</span>
            <select
              value={config.postDecode.upsampleMode}
              onChange={(e) => updatePost("upsampleMode", e.target.value as UpsampleMode)}
            >
              <option value="duplicate">Duplicate (current default)</option>
              <option value="linear">Linear interpolation</option>
              <option value="polyphase">Polyphase (windowed-sinc)</option>
            </select>
          </label>
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
            label="High-shelf EQ"
            value={config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfEnabled", v)}
          />
          <RangeRow
            label="Shelf cutoff"
            unit="Hz"
            min={1500}
            max={3500}
            step={100}
            value={config.postDecode.highShelfHz}
            disabled={!config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfHz", v)}
          />
          <RangeRow
            label="Shelf gain"
            unit="dB"
            min={-6}
            max={4}
            step={0.5}
            value={config.postDecode.highShelfDb}
            disabled={!config.postDecode.highShelfEnabled}
            onChange={(v) => updatePost("highShelfDb", v)}
          />
        </fieldset>
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
        <LatencyBreakdown latency={latency} />
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
          <code>LAB</code>.
        </p>
        <div className="audio-lab-push-row">
          <label>
            <span>Channel</span>
            <select value={pushChannel} onChange={(e) => setPushChannel(e.target.value)}>
              {channels.length === 0 && <option value="">(no talk-capable channels)</option>}
              {channels.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
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

function LatencyBreakdown({ latency }: { latency: LatencyMeasurement | null }) {
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
        Click <b>Measure now</b> to ping the server and time the IMBE codec on this device.
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
    { label: "IMBE encode (measured)", value: `${latency.encodeMs.toFixed(2)} ms` },
    { label: "Network round-trip (measured)", value: `${latency.rttMs.toFixed(1)} ms` },
    { label: "Relay forward", value: `~${FIXED.relayForwardMs} ms` },
    { label: "IMBE decode (measured)", value: `${latency.decodeMs.toFixed(2)} ms` },
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
