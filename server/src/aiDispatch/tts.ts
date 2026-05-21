import { getAgencyIntegrationValue } from "../store.js";
import { recordElevenLabsCall } from "../integrations/health.js";
import { prepareTextForTts } from "./speech/prepareTextForTts.js";
import { getTtsPrecacheHit, scheduleAgencyTtsPrecache } from "./ttsPrecache.js";

/** Legacy Flash path — only when [resolveTtsProfile] returns `fast` and env overrides model. */
const DEFAULT_FAST_MODEL_ID = "eleven_v3";

/**
 * Default TTS — Eleven v3 (fleet-preferred expressive voice).
 * If the sync API returns 4xx for v3, [synthesizeElevenLabsMp3] retries with turbo.
 */
const DEFAULT_EXPRESSIVE_MODEL_ID = "eleven_v3";

const FALLBACK_MODEL_ID = "eleven_turbo_v2_5";

/** Under this length (after prep), use fast unless speech kind forces expressive. */
const DEFAULT_FAST_MAX_CHARS = 140;

export type TtsSpeechKind =
  | "auto"
  | "radio_ack"
  | "plate_readback"
  | "info_lookup"
  | "callout"
  | "emergency";

export type TtsProfile = "fast" | "expressive";

type ElevenVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
};

/** Creative-style when using v3 or turbo for longer lines. */
const EXPRESSIVE_VOICE_SETTINGS: ElevenVoiceSettings = {
  stability: 0,
  similarity_boost: 0.78,
  style: 0.32,
  speed: 1.02,
  use_speaker_boost: true,
};

/** Tuned for short dispatcher acks on Flash/Turbo (matches legacy 10-8 dispatcher). */
const FAST_VOICE_SETTINGS: ElevenVoiceSettings = {
  stability: 0.55,
  similarity_boost: 0.78,
  style: 0.32,
  speed: 1.02,
  use_speaker_boost: true,
};

function fastModelId(): string {
  return process.env.ELEVENLABS_FAST_MODEL_ID?.trim() || DEFAULT_FAST_MODEL_ID;
}

function expressiveModelId(): string {
  return (
    process.env.ELEVENLABS_LONG_MODEL_ID?.trim() ||
    process.env.ELEVENLABS_MODEL_ID?.trim() ||
    DEFAULT_EXPRESSIVE_MODEL_ID
  );
}

function fastMaxChars(): number {
  const n = Number(process.env.ELEVENLABS_FAST_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAST_MAX_CHARS;
}

/** Pick fast vs expressive model from speech kind and text length. */
export function resolveTtsProfile(text: string, kind: TtsSpeechKind = "auto"): TtsProfile {
  if (kind === "plate_readback" || kind === "info_lookup" || kind === "callout" || kind === "emergency") {
    return "expressive";
  }
  if (kind === "radio_ack") {
    return "expressive";
  }
  const prepared = text.trim();
  if (prepared.length > fastMaxChars()) {
    return "expressive";
  }
  const sentences = prepared.match(/[.?!]/g)?.length ?? 0;
  if (sentences >= 2 && prepared.length > 80) {
    return "expressive";
  }
  const flashModel = process.env.ELEVENLABS_FAST_MODEL_ID?.trim();
  if (flashModel && flashModel.includes("flash")) {
    return "fast";
  }
  return "expressive";
}

function isV3Model(modelId: string): boolean {
  return modelId.toLowerCase().includes("v3");
}

function modelAndSettings(profile: TtsProfile): { model_id: string; voice_settings: ElevenVoiceSettings } {
  const model_id = profile === "fast" ? fastModelId() : expressiveModelId();
  const useExpressiveTuning = profile === "expressive" || isV3Model(model_id);

  if (!useExpressiveTuning) {
    const raw = process.env.ELEVENLABS_FAST_STABILITY?.trim();
    const settings = { ...FAST_VOICE_SETTINGS };
    if (raw !== undefined && raw !== "") {
      const stability = Number(raw);
      if (Number.isFinite(stability)) {
        settings.stability = Math.min(1, Math.max(0, stability));
      }
    }
    return { model_id, voice_settings: settings };
  }

  const raw = process.env.ELEVENLABS_STABILITY?.trim();
  const settings = { ...EXPRESSIVE_VOICE_SETTINGS };
  if (raw !== undefined && raw !== "") {
    const stability = Number(raw);
    if (Number.isFinite(stability)) {
      settings.stability = Math.min(1, Math.max(0, stability));
    }
  }
  return { model_id, voice_settings: settings };
}

function fallbackModels(primaryModelId: string): string[] {
  const out = [primaryModelId];
  if (isV3Model(primaryModelId) && primaryModelId !== FALLBACK_MODEL_ID) {
    out.push(FALLBACK_MODEL_ID);
  }
  return out;
}

export async function synthesizeElevenLabsMp3(
  agencyId: number,
  text: string,
  opts?: { skipPrecache?: boolean; speechKind?: TtsSpeechKind; profile?: TtsProfile },
): Promise<Buffer | null> {
  const apiKey = await getAgencyIntegrationValue(agencyId, "elevenlabs_api_key");
  const voiceId =
    (await getAgencyIntegrationValue(agencyId, "elevenlabs_voice_id")) ?? "21m00Tcm4TlvDq8ikWAM";
  if (!apiKey) {
    return null;
  }

  const profile = opts?.profile ?? resolveTtsProfile(text, opts?.speechKind ?? "auto");
  const pacedText = prepareTextForTts(text).slice(0, 2_000);

  scheduleAgencyTtsPrecache(agencyId);

  if (!opts?.skipPrecache) {
    const cached = getTtsPrecacheHit(agencyId, text);
    if (cached && cached.length > 0) {
      return cached;
    }
  }

  const { model_id: primaryModel, voice_settings } = modelAndSettings(profile);
  const models = fallbackModels(primaryModel);

  for (let i = 0; i < models.length; i++) {
    const model_id = models[i]!;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": apiKey,
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: pacedText,
        model_id,
        voice_settings,
      }),
    });
    if (res.ok) {
      recordElevenLabsCall(agencyId, true);
      const buf = Buffer.from(await res.arrayBuffer());
      if (i > 0) {
        console.warn(`[ai-dispatch] ElevenLabs used fallback model=${model_id} profile=${profile}`);
      }
      return buf.length > 0 ? buf : null;
    }

    const err = await res.text().catch(() => "");
    const canRetry = i < models.length - 1 && res.status >= 400 && res.status < 500;
    if (canRetry) {
      console.warn(
        `[ai-dispatch] ElevenLabs ${res.status} model=${model_id} — retrying with ${models[i + 1]}`,
      );
      continue;
    }
    console.warn(
      `[ai-dispatch] ElevenLabs ${res.status} profile=${profile} model=${model_id}: ${err.slice(0, 200)}`,
    );
    recordElevenLabsCall(agencyId, false, res.status, err);
    return null;
  }

  return null;
}
