import { getAgencyIntegrationValue } from "../store.js";
import { prepareTextForTts } from "./speech/prepareTextForTts.js";
import { getTtsPrecacheHit, scheduleAgencyTtsPrecache } from "./ttsPrecache.js";

/**
 * Real-time dispatcher voice. `eleven_v3` is not served on the synchronous /text-to-speech
 * endpoint used below, so selecting it makes the call 4xx and the dispatcher go silent. Default to
 * `eleven_turbo_v2_5` (real-time, broadly available); set ELEVENLABS_MODEL_ID to override.
 */
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";

/**
 * Stability presets (UI labels → API value):
 *   Creative = 0.0 (widest emotional range)
 *   Natural  = 0.5
 *   Robust   = 1.0 (most consistent)
 */
const DEFAULT_STABILITY = 0;

type ElevenVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
};

const DEFAULT_VOICE_SETTINGS: ElevenVoiceSettings = {
  stability: DEFAULT_STABILITY,
  similarity_boost: 0.78,
  style: 0.32,
  speed: 1.02,
  use_speaker_boost: true,
};

function elevenLabsModelId(): string {
  return process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
}

function elevenLabsVoiceSettings(): ElevenVoiceSettings {
  const raw = process.env.ELEVENLABS_STABILITY?.trim();
  if (raw === undefined || raw === "") {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
  const stability = Number(raw);
  if (!Number.isFinite(stability)) {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
  return { ...DEFAULT_VOICE_SETTINGS, stability: Math.min(1, Math.max(0, stability)) };
}

export async function synthesizeElevenLabsMp3(
  agencyId: number,
  text: string,
  opts?: { skipPrecache?: boolean },
): Promise<Buffer | null> {
  const apiKey = await getAgencyIntegrationValue(agencyId, "elevenlabs_api_key");
  const voiceId =
    (await getAgencyIntegrationValue(agencyId, "elevenlabs_voice_id")) ?? "21m00Tcm4TlvDq8ikWAM";
  if (!apiKey) {
    return null;
  }

  scheduleAgencyTtsPrecache(agencyId);

  if (!opts?.skipPrecache) {
    const cached = getTtsPrecacheHit(agencyId, text);
    if (cached && cached.length > 0) {
      return cached;
    }
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: prepareTextForTts(text).slice(0, 2_000),
      model_id: elevenLabsModelId(),
      voice_settings: elevenLabsVoiceSettings(),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.warn(`[ai-dispatch] ElevenLabs ${res.status}: ${err.slice(0, 200)}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 0 ? buf : null;
}
