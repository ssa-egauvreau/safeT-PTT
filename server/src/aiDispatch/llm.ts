import { getAiDispatchPlatformConfig } from "./platformConfig.js";
import { recordLlmCall } from "../integrations/health.js";

export interface LlmCompletionResult {
  text: string;
  provider: "anthropic" | "openai";
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Anthropic Messages API with 1h ephemeral prompt cache (matches 10-8 dispatcher). */
async function completeAnthropic(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  cacheTtl: "5m" | "1h";
  /** "" = omit (model default); low/medium for snappy replies, high/max for thorough lookups. */
  effort?: string;
}): Promise<LlmCompletionResult | null> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [
      {
        type: "text",
        text: opts.systemPrompt,
        cache_control: { type: "ephemeral", ttl: opts.cacheTtl },
      },
    ],
    messages: [{ role: "user", content: opts.userContent }],
  };
  // Lower effort = fewer reasoning tokens = faster on-air reply. Goes inside
  // output_config (not top-level). Omitted when blank so the model uses its default.
  if (opts.effort) {
    body.output_config = { effort: opts.effort };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.warn(`[ai-dispatch] Anthropic ${res.status}: ${err.slice(0, 300)}`);
    recordLlmCall("anthropic", false, res.status, err);
    return null;
  }
  recordLlmCall("anthropic", true);

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const text =
    data.content?.find((b) => b.type === "text")?.text?.trim() ??
    data.content?.[0]?.text?.trim() ??
    "";

  return {
    text,
    provider: "anthropic",
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens,
    cache_read_tokens: data.usage?.cache_read_input_tokens,
    cache_write_tokens: data.usage?.cache_creation_input_tokens,
  };
}

async function completeOpenAi(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
}): Promise<LlmCompletionResult | null> {
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userContent },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[ai-dispatch] OpenAI ${res.status}: ${body.slice(0, 200)}`);
    recordLlmCall("openai", false, res.status, body);
    return null;
  }
  recordLlmCall("openai", true);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, provider: "openai" };
}

export async function completeDispatcherLlm(opts: {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  /** When true, use the complex-tier model + effort (lookups). Defaults to routine. */
  complex?: boolean;
}): Promise<LlmCompletionResult | null> {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.llmApiKey) {
    return null;
  }
  const maxTokens = opts.maxTokens ?? 2500;
  const model = opts.complex ? platform.llmModelComplex : platform.llmModel;
  const effort = opts.complex ? platform.llmEffortComplex : platform.llmEffort;

  if (platform.llmProvider === "anthropic") {
    return completeAnthropic({
      apiKey: platform.llmApiKey,
      model,
      systemPrompt: opts.systemPrompt,
      userContent: opts.userContent,
      maxTokens,
      cacheTtl: platform.promptCacheTtl,
      effort,
    });
  }

  // OpenAI provider ignores effort; the complex tier still swaps the model.
  return completeOpenAi({
    apiKey: platform.llmApiKey,
    baseUrl: platform.llmBaseUrl,
    model,
    systemPrompt: opts.systemPrompt,
    userContent: opts.userContent,
    maxTokens,
  });
}
