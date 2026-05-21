import { getAgencyIntegrationValue } from "../store.js";

export async function postOutboundWebhook(
  agencyId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = await getAgencyIntegrationValue(agencyId, "outbound_webhook_url");
  if (!url) {
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[ai-dispatch] webhook ${res.status} for agency ${agencyId}`);
    }
  } catch (err) {
    console.warn("[ai-dispatch] webhook failed", err);
  }
}
