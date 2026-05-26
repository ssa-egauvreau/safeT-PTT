// Plain-English, goal-oriented UI for the Audio Lab. Drives the same
// AudioLabConfig the advanced view edits — composite controls just set
// several underlying knobs at once. Power users can flip to "Show advanced
// tuning" in the parent panel to see every individual knob.

import type { AudioLabConfig, UpsampleMode } from "./pipeline";

// ---------- Composite-control level mappings ----------

export type BoostLevel = "off" | "some" | "more" | "most";

const BOOST_PRESETS: Record<Exclude<BoostLevel, "off">, { rms: number; gain: number }> = {
  some: { rms: 4500, gain: 4 },
  more: { rms: 6000, gain: 6 }, // matches DEFAULT_PRESET
  most: { rms: 9000, gain: 10 },
};

export function readBoostLevel(cfg: AudioLabConfig): BoostLevel {
  if (!cfg.preImbe.agcEnabled) return "off";
  const rms = cfg.preImbe.agcTargetRms;
  if (rms <= 5000) return "some";
  if (rms <= 7000) return "more";
  return "most";
}

export function applyBoostLevel(cfg: AudioLabConfig, level: BoostLevel): AudioLabConfig {
  if (level === "off") {
    return { ...cfg, preImbe: { ...cfg.preImbe, agcEnabled: false } };
  }
  const p = BOOST_PRESETS[level];
  return {
    ...cfg,
    preImbe: {
      ...cfg.preImbe,
      agcEnabled: true,
      agcTargetRms: p.rms,
      agcMaxGain: p.gain,
    },
  };
}

export type WindLevel = "off" | "mild" | "strong";

export function readWindLevel(cfg: AudioLabConfig): WindLevel {
  if (!cfg.preImbe.windGateEnabled && !cfg.preImbe.windHpfEnabled) return "off";
  // "Strong" only matches when both the adaptive gate AND the steep HPF are on
  // (that's what applyWindLevel("strong") sets). An advanced-view config with
  // only the HPF enabled is closer to "mild" than to "strong" — it's still a
  // single-stage filter, just a different one.
  if (cfg.preImbe.windGateEnabled && cfg.preImbe.windHpfEnabled) return "strong";
  return "mild";
}

export function applyWindLevel(cfg: AudioLabConfig, level: WindLevel): AudioLabConfig {
  if (level === "off") {
    return {
      ...cfg,
      preImbe: { ...cfg.preImbe, windGateEnabled: false, windHpfEnabled: false },
    };
  }
  if (level === "mild") {
    return {
      ...cfg,
      preImbe: {
        ...cfg.preImbe,
        windGateEnabled: true,
        windGateThresholdDb: 12,
        windGateAttenuationDb: -12,
        windHpfEnabled: false,
        // Reset the HPF cutoff/order to defaults too — otherwise downgrading
        // from "strong" leaves stale 200 Hz / 4th-order values in the stored
        // config, which any future consumer reading them without checking
        // windHpfEnabled would apply unintentionally.
        windHpfHz: 200,
        windHpfOrder: 4,
      },
    };
  }
  // strong
  return {
    ...cfg,
    preImbe: {
      ...cfg.preImbe,
      windGateEnabled: true,
      windGateThresholdDb: 8,
      windGateAttenuationDb: -18,
      windHpfEnabled: true,
      windHpfHz: 200,
      windHpfOrder: 4,
    },
  };
}

export type MicProcessing = "standard" | "minimal";

export function readMicProcessing(cfg: AudioLabConfig): MicProcessing {
  return cfg.preImbe.bypassMicProcessing ? "minimal" : "standard";
}

export function applyMicProcessing(cfg: AudioLabConfig, level: MicProcessing): AudioLabConfig {
  return {
    ...cfg,
    preImbe: { ...cfg.preImbe, bypassMicProcessing: level === "minimal" },
  };
}

export type QualityLevel = "standard" | "improved" | "best";

export function readQualityLevel(cfg: AudioLabConfig): QualityLevel {
  // "linear" is a diagnostic mode in the advanced view; in simple terms it's
  // closest to the standard cheap upsample so we show it as such.
  if (cfg.postDecode.upsampleMode === "polyphase24") return "best";
  if (cfg.postDecode.upsampleMode === "polyphase") return "improved";
  return "standard";
}

const QUALITY_MODE: Record<QualityLevel, UpsampleMode> = {
  standard: "duplicate",
  improved: "polyphase",
  best: "polyphase24",
};

export function applyQualityLevel(cfg: AudioLabConfig, level: QualityLevel): AudioLabConfig {
  return {
    ...cfg,
    postDecode: { ...cfg.postDecode, upsampleMode: QUALITY_MODE[level] },
  };
}

// Bass/Treble: when the slider sits at 0 dB the underlying shelf is disabled
// outright (no point burning CPU on a no-op filter, and it keeps the advanced
// view's enable toggles honest).
const BASS_HZ = 200;
const TREBLE_HZ = 2500;

export function readBassDb(cfg: AudioLabConfig): number {
  return cfg.postDecode.lowShelfEnabled ? cfg.postDecode.lowShelfDb : 0;
}

export function applyBassDb(cfg: AudioLabConfig, db: number): AudioLabConfig {
  return {
    ...cfg,
    postDecode: {
      ...cfg.postDecode,
      lowShelfEnabled: db !== 0,
      lowShelfHz: BASS_HZ,
      lowShelfDb: db,
    },
  };
}

export function readTrebleDb(cfg: AudioLabConfig): number {
  return cfg.postDecode.highShelfEnabled ? cfg.postDecode.highShelfDb : 0;
}

export function applyTrebleDb(cfg: AudioLabConfig, db: number): AudioLabConfig {
  return {
    ...cfg,
    postDecode: {
      ...cfg.postDecode,
      highShelfEnabled: db !== 0,
      highShelfHz: TREBLE_HZ,
      highShelfDb: db,
    },
  };
}

// ---------- Components ----------

interface SimpleControlsProps {
  config: AudioLabConfig;
  setConfig: (cfg: AudioLabConfig) => void;
}

export function SimpleControls({ config, setConfig }: SimpleControlsProps) {
  return (
    <section className="audio-lab-simple">
      <SimpleSection
        title="Mic processing"
        description='"Standard" runs noise suppression, AGC and the TX expander — best in noisy vehicles. "Bridge-style minimal" turns it all off, matching the radio-bridge mic chain — use if hand-held audio sounds "processed" or "pumpy" compared to the bridge feed.'
      >
        <ButtonGroup<MicProcessing>
          value={readMicProcessing(config)}
          onChange={(v) => setConfig(applyMicProcessing(config, v))}
          options={[
            { value: "standard", label: "Standard" },
            { value: "minimal", label: "Bridge-style minimal" },
          ]}
        />
      </SimpleSection>

      <SimpleSection
        title="Boost quiet voices"
        description="Automatically lifts soft talkers so everyone sounds about the same loudness. Higher settings rescue more, but can also amplify background hiss in silent moments."
      >
        <ButtonGroup<BoostLevel>
          value={readBoostLevel(config)}
          onChange={(v) => setConfig(applyBoostLevel(config, v))}
          options={[
            { value: "off", label: "Off" },
            { value: "some", label: "A little" },
            { value: "more", label: "Normal" },
            { value: "most", label: "Maximum" },
          ]}
        />
      </SimpleSection>

      <SimpleSection
        title="Reduce wind & background noise"
        description="Suppresses gusts and steady rumble before voice encoding. Stronger settings cut more noise but can also dampen distant voices."
      >
        <ButtonGroup<WindLevel>
          value={readWindLevel(config)}
          onChange={(v) => setConfig(applyWindLevel(config, v))}
          options={[
            { value: "off", label: "Off" },
            { value: "mild", label: "Mild" },
            { value: "strong", label: "Strong" },
          ]}
        />
      </SimpleSection>

      <SimpleSection
        title="Voice tone"
        description="Shape the playback EQ. Move sliders to 0 dB to disable each band. Bass adds chest-thump warmth around 200 Hz; Treble adds or removes sibilance around 2.5 kHz."
      >
        <SimpleRange
          label="Bass"
          unit="dB"
          min={-6}
          max={9}
          step={0.5}
          value={readBassDb(config)}
          onChange={(v) => setConfig(applyBassDb(config, v))}
        />
        <SimpleRange
          label="Treble"
          unit="dB"
          min={-6}
          max={4}
          step={0.5}
          value={readTrebleDb(config)}
          onChange={(v) => setConfig(applyTrebleDb(config, v))}
        />
      </SimpleSection>

      <SimpleSection
        title="Audio quality"
        description="How the codec output is rendered for playback. Over-the-air audio always uses the Standard path; Higher quality is a listening-only A/B (the IMBE codec only carries audio up to ~4 kHz regardless)."
      >
        <ButtonGroup<QualityLevel>
          value={readQualityLevel(config)}
          onChange={(v) => setConfig(applyQualityLevel(config, v))}
          options={[
            { value: "standard", label: "Standard (matches production)" },
            { value: "improved", label: "Improved clarity" },
            { value: "best", label: "Higher quality (listen-only)" },
          ]}
        />
      </SimpleSection>
    </section>
  );
}

function SimpleSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="audio-lab-simple-section">
      <legend>{title}</legend>
      <div className="muted small audio-lab-simple-description">{description}</div>
      {children}
    </fieldset>
  );
}

function ButtonGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="audio-lab-buttongroup" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={"btn sm" + (value === opt.value ? " primary" : "")}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SimpleRange({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="audio-lab-range">
      <span className="audio-lab-range-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="audio-lab-range-value">
        {value > 0 ? "+" : ""}
        {step < 1 ? value.toFixed(1) : value} {unit}
      </span>
    </label>
  );
}
