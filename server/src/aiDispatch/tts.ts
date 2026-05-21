import { getAgencyIntegrationValue } from "../store.js";

export async function synthesizeElevenLabsMp3(agencyId: number, text: string): Promise<Buffer | null> {
  const apiKey = await getAgencyIntegrationValue(agencyId, "elevenlabs_api_key");
  const voiceId =
    (await getAgencyIntegrationValue(agencyId, "elevenlabs_voice_id")) ?? "21m00Tcm4TlvDq8ikWAM";
  if (!apiKey) {
    return null;
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text.slice(0, 2_000),
      model_id: "eleven_turbo_v2_5",
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
