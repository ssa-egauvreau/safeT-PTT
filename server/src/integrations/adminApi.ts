import type { Request, Response } from "express";
import { agencyPromptSource, getAiDispatchPlatformStatus } from "../aiDispatch/platformConfig.js";
import {
  deleteAgencyIntegration,
  getAgencyIntegrationValue,
  listAgencyIntegrationRows,
  setAgencyIntegrationValue,
  writeAudit,
} from "../store.js";
import {
  getIntegrationDefinition,
  INTEGRATION_DEFINITIONS,
  isIntegrationKey,
  type IntegrationDefinition,
} from "./catalog.js";
import { maskSecret } from "./mask.js";
import { getIntegrationHealth } from "./health.js";

const GROUP_LABELS: Record<IntegrationDefinition["group"], string> = {
  ai_dispatch: "AI dispatcher (agency)",
  webhooks: "Webhooks",
  lookups: "Lookups (portal)",
  ten8_cad: "10-8 CAD API (reads & comments)",
  ten8_new_incident: "10-8 New Incident API (create calls)",
};

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "").trim();
}

async function buildIntegrationPayload(
  agencyId: number,
  rows: Awaited<ReturnType<typeof listAgencyIntegrationRows>>,
) {
  const byKey = new Map(rows.map((r) => [r.integration_key, r]));
  const groups = new Map<
    string,
    {
      id: string;
      label: string;
      items: Array<{
        key: string;
        label: string;
        description: string;
        kind: string;
        availability: string;
        placeholder?: string;
        configured: boolean;
        display_value: string | null;
        updated_at: string | null;
      }>;
    }
  >();

  const promptSource = await agencyPromptSource(agencyId);

  for (const def of INTEGRATION_DEFINITIONS) {
    if (!groups.has(def.group)) {
      groups.set(def.group, { id: def.group, label: GROUP_LABELS[def.group], items: [] });
    }
    const row = byKey.get(def.key);
    const raw = row?.value?.trim() ?? "";
    let configured = raw.length > 0;
    let display_value = maskSecret(raw, def.kind);
    if (def.key === "ai_dispatch_system_prompt" && promptSource === "sunset_bundled") {
      configured = true;
      display_value = "Built-in Sunset Safety prompt (server)";
    }
    groups.get(def.group)!.items.push({
      key: def.key,
      label: def.label,
      description: def.description,
      kind: def.kind,
      availability: def.availability,
      placeholder: def.placeholder,
      configured,
      display_value,
      updated_at: row?.updated_at ?? null,
    });
  }

  return {
    platform: getAiDispatchPlatformStatus(),
    platform_note:
      "AI dispatcher LLM and master on/off are set in Railway environment variables for this deployment. Keys below are per agency.",
    prompt_source: promptSource,
    groups: [...groups.values()],
  };
}

export async function handleListIntegrations(req: Request, res: Response): Promise<void> {
  const agencyId = req.authUser!.agencyId!;
  const rows = await listAgencyIntegrationRows(agencyId);
  res.json(await buildIntegrationPayload(agencyId, rows));
}

export async function handleSetIntegration(req: Request, res: Response): Promise<void> {
  const agencyId = req.authUser!.agencyId!;
  const key = String(req.params.key ?? "").trim();
  if (!isIntegrationKey(key)) {
    res.status(404).json({ error: "unknown_integration" });
    return;
  }
  const def = getIntegrationDefinition(key)!;
  if (def.availability !== "active") {
    res.status(400).json({ error: "integration_not_available" });
    return;
  }

  const body = req.body as { value?: unknown };
  const value = body?.value === undefined || body?.value === null ? "" : String(body.value).trim();
  const maxLen = def.kind === "multiline" ? 72_000 : 4_096;
  if (value.length > maxLen) {
    res.status(400).json({ error: "value_too_long" });
    return;
  }

  if (def.kind === "url" && value.length > 0) {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        res.status(400).json({ error: "invalid_url" });
        return;
      }
    } catch {
      res.status(400).json({ error: "invalid_url" });
      return;
    }
  }

  if (value.length === 0) {
    // Blank save on secrets keeps the existing key (UI: "leave blank to keep").
    if (def.kind === "secret") {
      const existing = await getAgencyIntegrationValue(agencyId, key);
      if (existing) {
        const rows = await listAgencyIntegrationRows(agencyId);
        res.json(await buildIntegrationPayload(agencyId, rows));
        return;
      }
    }
    await deleteAgencyIntegration(agencyId, key);
  } else {
    await setAgencyIntegrationValue(agencyId, key, value, req.authUser!.id);
  }

  await writeAudit({
    agencyId,
    actorUserId: req.authUser!.id,
    actorName: req.authUser!.username,
    action: value.length === 0 ? "integration_clear" : "integration_set",
    target: key,
    detail: { kind: def.kind },
    ip: clientIp(req),
  });

  const rows = await listAgencyIntegrationRows(agencyId);
  res.json(await buildIntegrationPayload(agencyId, rows));
}

export async function handleIntegrationHealth(req: Request, res: Response): Promise<void> {
  const agencyId = req.authUser!.agencyId!;
  res.json(await getIntegrationHealth(agencyId));
}

/** Internal: read a configured agency secret (server-side only). */
export async function readAgencyIntegrationSecret(
  agencyId: number,
  key: string,
): Promise<string | null> {
  if (!isIntegrationKey(key)) {
    return null;
  }
  return getAgencyIntegrationValue(agencyId, key);
}
