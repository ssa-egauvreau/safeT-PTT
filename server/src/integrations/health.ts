/**
 * Credit / quota health for the external providers we depend on. Most providers expose no balance
 * endpoint, so health is built from two signals:
 *   - reactive: the last live call's outcome (credit/auth failures are remembered until a call
 *     succeeds again), which covers Claude, plate, and VIN lookups.
 *   - proactive: ElevenLabs publishes remaining characters via /v1/user/subscription, so it is
 *     polled (cached briefly) and can warn before it runs dry.
 * State is in-memory; it self-heals as calls succeed and the dashboard polls.
 */

import { getAgencyIntegrationValue } from "../store.js";
import { resolveElevenLabsApiKey } from "../aiDispatch/elevenLabsCreds.js";
import { getAiDispatchPlatformStatus } from "../aiDispatch/platformConfig.js";

export type ProviderStatus = "ok" | "low" | "out" | "error" | "unknown";

export interface ProviderHealth {
  provider: string;
  label: string;
  status: ProviderStatus;
  detail: string;
  /** Remaining credits/characters when a provider exposes them (ElevenLabs). */
  remaining?: number | null;
  limit?: number | null;
}

export interface IntegrationHealthPayload {
  providers: ProviderHealth[];
  checkedAt: string;
}

interface ReactiveState {
  status: ProviderStatus;
  detail: string;
  at: number;
}

/** Platform-wide providers keyed on env (the LLM API key is shared across agencies). */
const platformReactive = new Map<string, ReactiveState>();
/** Per-agency providers (keys live in agency_integrations). */
const agencyReactive = new Map<number, Map<string, ReactiveState>>();

const EL_CACHE_TTL_MS = 120_000;
const EL_LOW_RATIO = 0.1;
const elevenLabsCache = new Map<number, { at: number; health: ProviderHealth }>();

/**
 * Map an outbound provider call's HTTP status + response body to a dashboard
 * health status.
 *
 * Exported (rather than file-local) so the credit/quota detection contract
 * can be pinned in unit tests — this helper decides whether the admin
 * Integrations page surfaces an actionable "Out of credits" warning vs a
 * generic "Provider error". Regressions silently classify a real credit
 * outage as a transient error (admins never see the alert) or vice versa
 * (admins are nagged about a one-off 500).
 */
export function classifyFailure(
  httpStatus?: number,
  body?: string,
): { status: ProviderStatus; detail: string } {
  const text = (body ?? "").toLowerCase();
  if (
    httpStatus === 402 ||
    text.includes("quota_exceeded") ||
    text.includes("insufficient") ||
    text.includes("credit balance") ||
    text.includes("out of credit")
  ) {
    return { status: "out", detail: "Out of credits / quota exceeded" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "error", detail: "Authentication failed — check the API key" };
  }
  if (httpStatus === 429) {
    return { status: "error", detail: "Rate limited or over quota" };
  }
  return { status: "error", detail: httpStatus ? `Provider error (HTTP ${httpStatus})` : "Provider error" };
}

function setAgencyState(agencyId: number, provider: string, state: ReactiveState | null): void {
  let byProvider = agencyReactive.get(agencyId);
  if (!byProvider) {
    byProvider = new Map();
    agencyReactive.set(agencyId, byProvider);
  }
  if (state) {
    byProvider.set(provider, state);
  } else {
    byProvider.delete(provider);
  }
}

/** LLM (Claude/OpenAI) call outcome; clears on success. `provider` matches the platform provider. */
export function recordLlmCall(
  provider: "anthropic" | "openai",
  ok: boolean,
  httpStatus?: number,
  body?: string,
): void {
  if (ok) {
    platformReactive.delete(provider);
    return;
  }
  platformReactive.set(provider, { ...classifyFailure(httpStatus, body), at: Date.now() });
}

/** ElevenLabs TTS call outcome; clears on success (the proactive poll refines the level). */
export function recordElevenLabsCall(
  agencyId: number,
  ok: boolean,
  httpStatus?: number,
  body?: string,
): void {
  if (ok) {
    setAgencyState(agencyId, "elevenlabs", null);
    elevenLabsCache.delete(agencyId);
    return;
  }
  setAgencyState(agencyId, "elevenlabs", { ...classifyFailure(httpStatus, body), at: Date.now() });
  elevenLabsCache.delete(agencyId);
}

/** Plate/VIN lookup outcome. Only credit/auth failures flag; transient errors leave prior state. */
export function recordLookupResult(
  agencyId: number,
  provider: "plate_lookup" | "vin_lookup",
  result: { ok: boolean; reason?: string },
): void {
  if (result.ok || result.reason === "no_record") {
    setAgencyState(agencyId, provider, null);
    return;
  }
  if (result.reason === "insufficient_credit") {
    setAgencyState(agencyId, provider, { status: "out", detail: "Out of credits", at: Date.now() });
  } else if (result.reason === "auth_error") {
    setAgencyState(agencyId, provider, {
      status: "error",
      detail: "Authentication failed — check the API key",
      at: Date.now(),
    });
  }
}

function reactiveToHealth(provider: string, label: string, state: ReactiveState | undefined): ProviderHealth {
  if (!state) {
    return { provider, label, status: "ok", detail: "No recent credit or auth errors" };
  }
  return { provider, label, status: state.status, detail: state.detail };
}

async function elevenLabsHealth(agencyId: number, apiKey: string): Promise<ProviderHealth> {
  const cached = elevenLabsCache.get(agencyId);
  if (cached && Date.now() - cached.at < EL_CACHE_TTL_MS) {
    return cached.health;
  }
  const label = "ElevenLabs (TTS)";
  let health: ProviderHealth;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      health = { provider: "elevenlabs", label, ...classifyFailure(res.status, body) };
    } else {
      const data = (await res.json()) as { character_count?: number; character_limit?: number };
      const limit = Number(data.character_limit ?? 0);
      const used = Number(data.character_count ?? 0);
      const remaining = Math.max(0, limit - used);
      if (limit <= 0) {
        health = { provider: "elevenlabs", label, status: "unknown", detail: "No quota reported", remaining, limit };
      } else if (remaining <= 0) {
        health = { provider: "elevenlabs", label, status: "out", detail: "Out of credits", remaining, limit };
      } else if (remaining / limit < EL_LOW_RATIO) {
        health = {
          provider: "elevenlabs",
          label,
          status: "low",
          detail: `Low: ${remaining.toLocaleString()} of ${limit.toLocaleString()} characters left`,
          remaining,
          limit,
        };
      } else {
        health = {
          provider: "elevenlabs",
          label,
          status: "ok",
          detail: `${remaining.toLocaleString()} of ${limit.toLocaleString()} characters left`,
          remaining,
          limit,
        };
      }
    }
  } catch (e) {
    // Network/parse failure: fall back to whatever the last live TTS call told us.
    const reactive = agencyReactive.get(agencyId)?.get("elevenlabs");
    health = reactive
      ? { provider: "elevenlabs", label, status: reactive.status, detail: reactive.detail }
      : { provider: "elevenlabs", label, status: "unknown", detail: "Could not reach ElevenLabs" };
  }
  elevenLabsCache.set(agencyId, { at: Date.now(), health });
  return health;
}

export async function getIntegrationHealth(agencyId: number): Promise<IntegrationHealthPayload> {
  const providers: ProviderHealth[] = [];

  const platform = getAiDispatchPlatformStatus();
  if (platform.llmConfigured) {
    const provider = platform.llmProvider === "openai" ? "openai" : "anthropic";
    const label = provider === "anthropic" ? "Claude API (Anthropic)" : "LLM (OpenAI)";
    providers.push(reactiveToHealth(provider, label, platformReactive.get(provider)));
  }

  const elKey = (await resolveElevenLabsApiKey(agencyId))?.trim();
  if (elKey) {
    providers.push(await elevenLabsHealth(agencyId, elKey));
  }

  const plateKey = (await getAgencyIntegrationValue(agencyId, "license_plate_lookup_api_key"))?.trim();
  if (plateKey) {
    providers.push(
      reactiveToHealth("plate_lookup", "License plate lookup", agencyReactive.get(agencyId)?.get("plate_lookup")),
    );
  }

  const vinKey = (await getAgencyIntegrationValue(agencyId, "vin_lookup_api_key"))?.trim() || plateKey;
  if (vinKey) {
    providers.push(reactiveToHealth("vin_lookup", "VIN lookup", agencyReactive.get(agencyId)?.get("vin_lookup")));
  }

  return { providers, checkedAt: new Date().toISOString() };
}
