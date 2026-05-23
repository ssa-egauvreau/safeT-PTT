import { completeDispatcherLlm } from "./llm.js";

export interface PlateRequestFields {
  plate: string | null;
  state: string | null;
  vin: string | null;
}

export interface InfoRequestFields {
  type:
    | "address"
    | "external_address"
    | "pending_calls"
    | "active_calls_for_unit"
    | "call_details"
    | "unit_location"
    | "unit_status"
    | "phone"
    | "contact"
    | "legal_code"
    | "general_query"
    | "unknown";
  account_code: string | null;
  subject: string | null;
}

export interface AiDispatchParseResult {
  actionable: boolean;
  intent: string;
  unit: string | null;
  summary: string;
  confidence: number;
  dispatcher_response: string | null;
  trigger_emergency_tone: boolean;
  recommended_action: string | null;
  plate_request: PlateRequestFields | null;
  code: string | null;
  location_code: string | null;
  location_name: string | null;
  info_request: InfoRequestFields | null;
  /** ALL-CAPS cop-shorthand for 10-8 CAD comment when logging on an open call. */
  comment_text: string | null;
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
  const unit =
    typeof ai.unit === "string" && ai.unit.trim() ? ai.unit.trim() : null;
  const code = typeof ai.code === "string" && ai.code.trim() ? ai.code.trim() : null;
  const location_code =
    typeof ai.location_code === "string" && /^\d{3,5}$/.test(ai.location_code.trim())
      ? ai.location_code.trim()
      : null;
  const location_name =
    typeof ai.location_name === "string" && ai.location_name.trim()
      ? ai.location_name.trim()
      : null;
  const comment_text =
    typeof ai.comment_text === "string" && ai.comment_text.trim()
      ? ai.comment_text.trim().slice(0, 240)
      : null;

  let info_request: InfoRequestFields | null = null;
  if (ai.info_request && typeof ai.info_request === "object" && !Array.isArray(ai.info_request)) {
    const ir = ai.info_request as Record<string, unknown>;
    const t = typeof ir.type === "string" ? ir.type.trim().toLowerCase() : null;
    const validTypes = new Set([
      "address",
      "external_address",
      "pending_calls",
      "active_calls_for_unit",
      "call_details",
      "unit_location",
      "unit_status",
      "phone",
      "contact",
      "legal_code",
      "general_query",
      "unknown",
    ]);
    if (t && validTypes.has(t)) {
      info_request = {
        type: t as InfoRequestFields["type"],
        account_code:
          typeof ir.account_code === "string" && /^\d{3,5}$/.test(ir.account_code.trim())
            ? ir.account_code.trim()
            : null,
        subject:
          typeof ir.subject === "string" && ir.subject.trim() ? ir.subject.trim() : null,
      };
    }
  }

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
    unit,
    summary: ai.summary.trim(),
    confidence: ai.confidence,
    dispatcher_response,
    trigger_emergency_tone,
    recommended_action,
    plate_request,
    code,
    location_code,
    location_name,
    info_request,
    comment_text,
  };
}

export async function parseDispatcherTransmission(opts: {
  systemPrompt: string;
  unitId: string;
  channelName: string;
  transcript: string;
  /** Relevant agency knowledge (RAG) appended to the user turn, not the cached system prompt. */
  knowledgeContext?: string;
}): Promise<AiDispatchParseResult | null> {
  const pacific = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
  });

  const knowledge = opts.knowledgeContext?.trim()
    ? `\nRelevant agency knowledge (use only if it applies to this transmission):\n${opts.knowledgeContext.trim()}\n`
    : "";

  const userContent =
    `Current Pacific time: ${pacific}\n` +
    `Radio channel (use this name on the air instead of "green-1"): ${opts.channelName}\n` +
    `Transmitting unit: ${opts.unitId}\n` +
    `STT confidence: 0.85\n` +
    `Transcript: ${opts.transcript}\n` +
    knowledge +
    `\nReturn ONLY the JSON object described in the system prompt.`;

  const result = await completeDispatcherLlm({
    systemPrompt: opts.systemPrompt,
    userContent,
    maxTokens: 2500,
  });
  if (!result?.text) {
    console.warn(
      `[ai-dispatch] LLM returned no text (provider=${result?.provider ?? "none"}). Check AI_DISPATCH_LLM_API_KEY / model.`,
    );
    return null;
  }
  if (result.cache_read_tokens != null && result.cache_read_tokens > 0) {
    console.log(
      `[ai-dispatch] Anthropic cache read=${result.cache_read_tokens} write=${result.cache_write_tokens ?? 0}`,
    );
  }
  const parsed = normalizeAiDispatchParse(tryParseJson(result.text));
  if (!parsed) {
    console.warn(
      `[ai-dispatch] parse FAILED: model output did not match the expected JSON schema. raw="${result.text.slice(0, 400).replace(/\s+/g, " ")}"`,
    );
  } else {
    console.log(
      `[ai-dispatch] parsed intent=${parsed.intent} unit=${parsed.unit ?? "?"} has_response=${parsed.dispatcher_response ? "yes" : "no"} info_request=${parsed.info_request?.type ?? "none"}`,
    );
  }
  return parsed;
}
