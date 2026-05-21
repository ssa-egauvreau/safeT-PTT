/**
 * Platform-wide AI dispatcher settings — set on Railway (or host env), not per agency.
 * Per-agency API keys, system prompt, and webhooks live in agency_integrations.
 */

import { getAgencyIntegrationValue } from "../store.js";
import {
  agencyUsesSunsetSafetyBundledPrompt,
  getSunsetSafetyBundledPrompt,
} from "./prompts/sunsetSafety.js";

export type LlmProvider = "anthropic" | "openai";

export interface AiDispatchPlatformConfig {
  enabled: boolean;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  /** Anthropic ephemeral prompt cache TTL (large SSA system prompt). */
  promptCacheTtl: "5m" | "1h";
  defaultSystemPrompt: string;
  dispatchUnitId: string;
  yieldsToUnitsDefault: boolean;
}

function envFlag(name: string, defaultOn = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return defaultOn;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Loaded once per process; env changes require restart. */
let cached: AiDispatchPlatformConfig | null = null;

export function getAiDispatchPlatformConfig(): AiDispatchPlatformConfig {
  if (cached) {
    return cached;
  }
  const llmApiKey = process.env.AI_DISPATCH_LLM_API_KEY?.trim() ?? "";
  const providerRaw = process.env.AI_DISPATCH_LLM_PROVIDER?.trim().toLowerCase();
  const llmProvider: LlmProvider =
    providerRaw === "openai"
      ? "openai"
      : providerRaw === "anthropic" || !providerRaw
        ? "anthropic"
        : llmApiKey.startsWith("sk-ant-")
          ? "anthropic"
          : "openai";
  const cacheTtlRaw = process.env.AI_DISPATCH_PROMPT_CACHE_TTL?.trim().toLowerCase();
  const promptCacheTtl: "5m" | "1h" = cacheTtlRaw === "5m" ? "5m" : "1h";

  cached = {
    enabled: envFlag("AI_DISPATCH_ENABLED"),
    llmProvider,
    llmApiKey,
    llmBaseUrl: (process.env.AI_DISPATCH_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    ),
    llmModel:
      process.env.AI_DISPATCH_LLM_MODEL?.trim() ||
      (llmProvider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini"),
    promptCacheTtl,
    defaultSystemPrompt:
      process.env.AI_DISPATCH_SYSTEM_PROMPT?.trim() ||
      "You are a professional public-safety radio dispatcher. Be brief, clear, and use standard 10-codes when appropriate.",
    dispatchUnitId: (process.env.AI_DISPATCH_UNIT_ID?.trim() || "AI-DISPATCH").slice(0, 64),
    yieldsToUnitsDefault: process.env.AI_DISPATCH_YIELDS_DEFAULT?.trim() !== "0",
  };
  return cached;
}

/** Safe summary for admin UI — never exposes secrets. */
export function getAiDispatchPlatformStatus(): {
  enabled: boolean;
  llmConfigured: boolean;
  llmProvider: LlmProvider;
  model: string;
  promptCacheTtl: string;
  dispatchUnitId: string;
} {
  const c = getAiDispatchPlatformConfig();
  return {
    enabled: c.enabled,
    llmConfigured: c.llmApiKey.length > 0,
    llmProvider: c.llmProvider,
    model: c.llmModel,
    promptCacheTtl: c.promptCacheTtl,
    dispatchUnitId: c.dispatchUnitId,
  };
}

/** Agency prompt: Integrations override → Sunset Safety bundled (SSA) → Railway default. */
export async function resolveAiDispatchSystemPrompt(agencyId: number): Promise<string> {
  const custom = await getAgencyIntegrationValue(agencyId, "ai_dispatch_system_prompt");
  if (custom?.trim()) {
    return custom.trim();
  }
  if (await agencyUsesSunsetSafetyBundledPrompt(agencyId)) {
    return getSunsetSafetyBundledPrompt();
  }
  return getAiDispatchPlatformConfig().defaultSystemPrompt;
}

export async function agencyPromptSource(agencyId: number): Promise<"custom" | "sunset_bundled" | "railway_default"> {
  const custom = await getAgencyIntegrationValue(agencyId, "ai_dispatch_system_prompt");
  if (custom?.trim()) {
    return "custom";
  }
  if (await agencyUsesSunsetSafetyBundledPrompt(agencyId)) {
    return "sunset_bundled";
  }
  return "railway_default";
}

export function normalizeDispatchUnitId(unitId: string): string {
  return unitId.trim().toUpperCase();
}

export function isAiDispatchUnit(unitId: string | null | undefined): boolean {
  if (!unitId?.trim()) {
    return false;
  }
  return normalizeDispatchUnitId(unitId) === normalizeDispatchUnitId(getAiDispatchPlatformConfig().dispatchUnitId);
}
