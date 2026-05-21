/**
 * Registry of per-agency integration slots shown on the admin Integrations page.
 * Platform-wide AI dispatcher behavior is configured via Railway env (see aiDispatch/platformConfig.ts).
 */

export type IntegrationFieldKind = "secret" | "text" | "url" | "multiline";

export type IntegrationAvailability = "active" | "coming_soon";

export interface IntegrationDefinition {
  key: string;
  label: string;
  description: string;
  kind: IntegrationFieldKind;
  group: "ai_dispatch" | "webhooks" | "lookups";
  availability: IntegrationAvailability;
  /** Optional placeholder for empty inputs in the admin UI. */
  placeholder?: string;
}

export const INTEGRATION_DEFINITIONS: IntegrationDefinition[] = [
  {
    key: "elevenlabs_api_key",
    label: "ElevenLabs API key",
    description: "Text-to-speech for the built-in AI dispatcher on channels where AI dispatch is enabled.",
    kind: "secret",
    group: "ai_dispatch",
    availability: "active",
    placeholder: "sk_…",
  },
  {
    key: "elevenlabs_voice_id",
    label: "ElevenLabs voice ID",
    description: "Voice used for AI dispatcher replies (from your ElevenLabs voice library).",
    kind: "text",
    group: "ai_dispatch",
    availability: "active",
    placeholder: "e.g. 21m00Tcm4TlvDq8ikWAM",
  },
  {
    key: "ai_dispatch_system_prompt",
    label: "AI dispatcher system prompt",
    description:
      "Instructions for your agency only: 10-codes, call signs, tone, and local radio policy. " +
      "If empty, the server default from Railway is used.",
    kind: "multiline",
    group: "ai_dispatch",
    availability: "active",
    placeholder:
      "Example: You are dispatch for Metro Fire. Use 10-4 for acknowledge. Units are called by number…",
  },
  {
    key: "outbound_webhook_url",
    label: "Outbound webhook URL",
    description:
      "Optional HTTPS endpoint that receives JSON when the AI dispatcher acts (transcript in, reply out). For your own logging or CAD hooks.",
    kind: "url",
    group: "webhooks",
    availability: "active",
    placeholder: "https://…",
  },
  {
    key: "license_plate_lookup_api_key",
    label: "License plate lookup API key",
    description: "Reserved for plate-to-vehicle lookup in the dispatch portal (coming soon).",
    kind: "secret",
    group: "lookups",
    availability: "coming_soon",
  },
  {
    key: "vin_lookup_api_key",
    label: "VIN lookup API key",
    description: "Reserved for VIN decode / vehicle info in the dispatch portal (coming soon).",
    kind: "secret",
    group: "lookups",
    availability: "coming_soon",
  },
];

const BY_KEY = new Map(INTEGRATION_DEFINITIONS.map((d) => [d.key, d]));

export function getIntegrationDefinition(key: string): IntegrationDefinition | undefined {
  return BY_KEY.get(key);
}

export function isIntegrationKey(key: string): boolean {
  return BY_KEY.has(key);
}
