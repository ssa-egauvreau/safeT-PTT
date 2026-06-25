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
  group: "ai_dispatch" | "webhooks" | "lookups" | "ten8_cad" | "ten8_new_incident";
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
    key: "ai_dispatch_wake_word",
    label: "AI dispatcher wake word",
    description:
      "Spoken phrase that engages the dispatcher on channels set to Supervised (e.g. “Hey AI, 27-000 show me on a patrol check”). " +
      "If empty, the default “hey ai” is used. A short, distinctive phrase works best.",
    kind: "text",
    group: "ai_dispatch",
    availability: "active",
    placeholder: "hey ai",
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
    description: "PlateToVIN.com API key for 912 plate lookups (Authorization header, no Bearer prefix).",
    kind: "secret",
    group: "lookups",
    availability: "active",
    placeholder: "PlateToVIN key",
  },
  {
    key: "vin_lookup_api_key",
    label: "VIN lookup API key",
    description: "Auto.dev API key for 17-character VIN decode. Falls back to plate key if empty.",
    kind: "secret",
    group: "lookups",
    availability: "active",
  },
  {
    key: "plate_lookup_default_state",
    label: "Default plate state",
    description: "Two-letter state when the officer does not say one (default CA).",
    kind: "text",
    group: "lookups",
    availability: "active",
    placeholder: "CA",
  },
  {
    key: "google_maps_geocoding_api_key",
    label: "Google Maps Geocoding API key",
    description:
      "Optional. Improves 10-20 unit location readbacks (POI names, intersections). OpenStreetMap is used when this is empty.",
    kind: "secret",
    group: "lookups",
    availability: "active",
    placeholder: "AIza…",
  },
  {
    key: "ten8_webhook_secret",
    label: "10-8 incident export bearer token",
    description:
      "Shared secret for incident-export posts. Send it as Authorization: Bearer … OR as ?token= on the webhook URL (for 10-8 configs that can't set headers).",
    kind: "secret",
    group: "webhooks",
    availability: "active",
  },
  {
    key: "ten8_webhook_allow_unauthenticated",
    label: "Allow unauthenticated 10-8 webhook",
    description:
      "Set to 1 to accept incident-export posts with NO secret (use only if 10-8 cannot send any auth — the endpoint becomes open to anyone who knows the URL and your agency slug).",
    kind: "text",
    group: "webhooks",
    availability: "active",
    placeholder: "1 to allow, blank to require a secret",
  },
  {
    key: "ten8_api_key",
    label: "10-8 CAD API key (v1.0.8)",
    description:
      "Same as TEN8_API_KEY on the old dispatcher. X-API-Key for reads (pending calls, incident lookup) and CAD comments. Not used to create brand-new incidents.",
    kind: "secret",
    group: "ten8_cad",
    availability: "active",
  },
  {
    key: "ten8_api_secret",
    label: "10-8 CAD API secret (v1.0.8)",
    description: "Same as TEN8_API_SECRET on the old dispatcher. Paired with the CAD API key above.",
    kind: "secret",
    group: "ten8_cad",
    availability: "active",
  },
  {
    key: "ten8_api_base_url",
    label: "10-8 CAD API base URL",
    description:
      "Same as TEN8_API_BASE_URL. Optional; default is the 10-8 AWS gateway (confirmed by 10-8 support). Only set this if 10-8 gives you a different CAD host.",
    kind: "url",
    group: "ten8_cad",
    availability: "active",
    placeholder: "https://ps569km5w9.execute-api.us-gov-west-1.amazonaws.com/prod",
  },
  {
    key: "ten8_live_execution",
    label: "10-8 live CAD writes",
    description:
      "Same as live_execution_enabled on the old dispatcher. 1 = post comments to CAD; 0 = shadow mode (log only, no writes).",
    kind: "text",
    group: "ten8_cad",
    availability: "active",
    placeholder: "0",
  },
  {
    key: "ten8_new_incident_api_key",
    label: "10-8 New Incident API key",
    description:
      "Same as TEN8_NEW_INCIDENT_API_KEY. Basic-auth username for creating new CAD calls (self-dispatch). Separate from the v1.0.8 key pair.",
    kind: "secret",
    group: "ten8_new_incident",
    availability: "active",
  },
  {
    key: "ten8_new_incident_api_secret",
    label: "10-8 New Incident API secret",
    description:
      "Same as TEN8_NEW_INCIDENT_API_SECRET. Basic-auth password paired with the New Incident API key.",
    kind: "secret",
    group: "ten8_new_incident",
    availability: "active",
  },
  {
    key: "ten8_new_incident_api_base_url",
    label: "10-8 New Incident API base URL",
    description:
      "Same as TEN8_NEW_INCIDENT_API_BASE_URL. Optional; default https://interface.10-8systems.com",
    kind: "url",
    group: "ten8_new_incident",
    availability: "active",
    placeholder: "https://interface.10-8systems.com",
  },
];

const BY_KEY = new Map(INTEGRATION_DEFINITIONS.map((d) => [d.key, d]));

export function getIntegrationDefinition(key: string): IntegrationDefinition | undefined {
  return BY_KEY.get(key);
}

export function isIntegrationKey(key: string): boolean {
  return BY_KEY.has(key);
}
