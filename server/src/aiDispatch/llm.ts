import { getAiDispatchPlatformConfig } from "./platformConfig.js";

export async function generateDispatcherReply(opts: {
  systemPrompt: string;
  unitId: string;
  channelName: string;
  transcript: string;
}): Promise<string | null> {
  const platform = getAiDispatchPlatformConfig();
  if (!platform.llmApiKey) {
    return null;
  }
  const userContent =
    `Channel: ${opts.channelName}\n` +
    `Transmitting unit: ${opts.unitId}\n` +
    `Transcript: ${opts.transcript}\n\n` +
    `Reply with one brief radio-style dispatch response (plain text only, no markdown).`;

  const res = await fetch(`${platform.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${platform.llmApiKey}`,
    },
    body: JSON.stringify({
      model: platform.llmModel,
      temperature: 0.4,
      max_tokens: 180,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[ai-dispatch] LLM ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  return text.length > 0 ? text : null;
}
