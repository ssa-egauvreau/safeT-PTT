import { getAgencyIntegrationValue } from "../store.js";

/**
 * ElevenLabs credentials, resolved env-first then per-agency.
 *
 * A fleet operator can set ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID once in the
 * hosting environment (Railway) to give every agency the same dispatcher voice,
 * instead of pasting the key into each agency's Admin → Integrations. The
 * per-agency DB value remains a fallback (and a per-agency override when the env
 * var is unset), so existing single-tenant setups keep working.
 */

/** Default ElevenLabs voice when neither env nor agency configures one. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** API key: env ELEVENLABS_API_KEY wins, else the agency's stored key. */
export async function resolveElevenLabsApiKey(agencyId: number): Promise<string | null> {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromAgency = (await getAgencyIntegrationValue(agencyId, "elevenlabs_api_key"))?.trim();
  return fromAgency || null;
}

/** Voice id: env ELEVENLABS_VOICE_ID wins, else the agency's, else the default. */
export async function resolveElevenLabsVoiceId(agencyId: number): Promise<string> {
  const fromEnv = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromAgency = (await getAgencyIntegrationValue(agencyId, "elevenlabs_voice_id"))?.trim();
  return fromAgency || DEFAULT_ELEVENLABS_VOICE_ID;
}
