import { completeDispatcherLlm } from "./llm.js";

export interface PlateRequestFields {
  plate: string | null;
  state: string | null;
  vin: string | null;
}

export interface AiDispatchParseResult {
  actionable: boolean;
  intent: string;
  summary: string;
  confidence: number;
  dispatcher_response: string | null;
  trigger_emergency_tone: boolean;
  recommended_action: string | null;
  plate_request: PlateRequestFields | null;
}

const VALID_INTENTS = new Set([
  "status_change",
  "dispatch",
  "on_scene",
  "clear",
  "request_info",
  "acknowledgment",
  "emergency",
  "emergency_clear",
  "inter_unit",
  "info_request_912",
  "info_clear_913",
  "plate_request",
  "plate_transmit",
  "chitchat",
  "unknown",
]);

function tryParseJson(s: string): unknown {
  let cleaned = (s || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    cleaned = cleaned.substring(first, last + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function normalizeAiDispatchParse(raw: unknown): AiDispatchParseResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const ai = raw as Record<string, unknown>;
  if (typeof ai.actionable !== "boolean") {
    return null;
  }
  if (typeof ai.intent !== "string" || !VALID_INTENTS.has(ai.intent)) {
    return null;
  }
  if (typeof ai.summary !== "string" || !ai.summary.trim()) {
    return null;
  }
  if (typeof ai.confidence !== "number" || Number.isNaN(ai.confidence)) {
    return null;
  }
  const dispatcher_response =
    typeof ai.dispatcher_response === "string" && ai.dispatcher_response.trim()
      ? ai.dispatcher_response.trim()
      : null;
  const trigger_emergency_tone = ai.trigger_emergency_tone === true;
  const recommended_action =
    typeof ai.recommended_action === "string" && ai.recommended_action.trim()
      ? ai.recommended_action.trim()
      : null;
  let plate_request: PlateRequestFields | null = null;
  if (ai.plate_request && typeof ai.plate_request === "object" && !Array.isArray(ai.plate_request)) {
    const pr = ai.plate_request as Record<string, unknown>;
    plate_request = {
      plate: typeof pr.plate === "string" ? pr.plate.trim().toUpperCase() : null,
      state: typeof pr.state === "string" ? pr.state.trim().toUpperCase() : null,
      vin:
        typeof pr.vin === "string"
          ? pr.vin.trim().toUpperCase().replace(/[\s-]/g, "")
          : null,
    };
    if (!plate_request.plate && !plate_request.vin) {
      plate_request = null;
    }
  }
  return {
    actionable: ai.actionable,
    intent: ai.intent,
    summary: ai.summary.trim(),
    confidence: ai.confidence,
    dispatcher_response,
    trigger_emergency_tone,
    recommended_action,
    plate_request,
  };
}

export async function parseDispatcherTransmission(opts: {
  systemPrompt: string;
  unitId: string;
  channelName: string;
  transcript: string;
}): Promise<AiDispatchParseResult | null> {
  const pacific = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
  });

  const userContent =
    `Current Pacific time: ${pacific}\n` +
    `Radio channel (use this name on the air instead of "green-1"): ${opts.channelName}\n` +
    `Transmitting unit: ${opts.unitId}\n` +
    `STT confidence: 0.85\n` +
    `Transcript: ${opts.transcript}\n\n` +
    `Return ONLY the JSON object described in the system prompt.`;

  const result = await completeDispatcherLlm({
    systemPrompt: opts.systemPrompt,
    userContent,
    maxTokens: 2500,
  });
  if (!result?.text) {
    return null;
  }
  if (result.cache_read_tokens != null && result.cache_read_tokens > 0) {
    console.log(
      `[ai-dispatch] Anthropic cache read=${result.cache_read_tokens} write=${result.cache_write_tokens ?? 0}`,
    );
  }
  return normalizeAiDispatchParse(tryParseJson(result.text));
}
