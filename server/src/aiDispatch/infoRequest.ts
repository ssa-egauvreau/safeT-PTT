import { listTen8ActiveIncidents } from "../ten8/store.js";

function normalizeUnitId(u: string): string {
  return u.trim().toLowerCase().replace(/^27-/, "");
}

function incidentPayloadHasUnit(inc: { payload: unknown }, targetUnit: string): boolean {
  if (!targetUnit || !inc.payload || typeof inc.payload !== "object") {
    return false;
  }
  const body = inc.payload as Record<string, unknown>;
  const units = body.units ?? body.Units;
  if (!Array.isArray(units)) {
    return false;
  }
  const want = normalizeUnitId(targetUnit);
  return units.some((u) => {
    if (!u || typeof u !== "object") {
      return false;
    }
    const row = u as Record<string, unknown>;
    const id = String(row.id ?? row.unitId ?? row.unit_id ?? "").trim();
    return normalizeUnitId(id) === want;
  });
}
import { lookupSsaProperty } from "./ssaProperties.js";
import { accountCodeDashForm } from "./speech/numbers.js";
import type { InfoRequestFields } from "./parse.js";

export function buildInfoRequestAck(requestingUnit: string | null | undefined): string {
  if (!requestingUnit) {
    return "Copy. Standby.";
  }
  const csShort = /^27-0[0-3]0$/.test(requestingUnit)
    ? requestingUnit
    : requestingUnit.replace(/^27-/, "");
  return `${csShort}, copy. Standby.`;
}

export function infoRequestNeedsAsync(infoRequest: InfoRequestFields): boolean {
  const t = infoRequest.type;
  return ["external_address", "legal_code", "general_query"].includes(t);
}

export async function buildInfoRequestResponse(
  agencyId: number,
  infoRequest: InfoRequestFields,
  requestingUnit: string | null | undefined,
): Promise<string | null> {
  const csPart = requestingUnit
    ? `${/^27-0[0-3]0$/.test(requestingUnit) ? requestingUnit : requestingUnit.replace(/^27-/, "")}, `
    : "";

  switch (infoRequest.type) {
    case "address": {
      if (!infoRequest.account_code) {
        return `${csPart}negative, no account number heard. 10-9 with the account number.`;
      }
      const prop = lookupSsaProperty(infoRequest.account_code);
      if (!prop) {
        return `${csPart}negative, account ${infoRequest.account_code} is not in our property database.`;
      }
      const accountSpoken = accountCodeDashForm(infoRequest.account_code);
      const parts = [`account ${accountSpoken} is ${prop.name}`];
      if (prop.street) {
        parts.push(`at ${prop.street}`);
      }
      if (prop.city) {
        parts.push(prop.city);
      }
      return `${csPart}${parts.join(", ")}.`;
    }

    case "pending_calls": {
      const pending = await listTen8ActiveIncidents(agencyId);
      if (pending.length === 0) {
        return `${csPart}no pending calls at this time.`;
      }
      if (pending.length === 1) {
        const inc = pending[0]!;
        const codeOrType = inc.incident_type || "call";
        const loc = inc.location || "unknown location";
        return `${csPart}one pending call: ${codeOrType} at ${loc}.`;
      }
      return `${csPart}${pending.length} pending calls. Check the dashboard for details.`;
    }

    case "active_calls_for_unit": {
      const targetUnit = (infoRequest.subject || requestingUnit || "")
        .trim()
        .replace(/^27-/, "")
        .toLowerCase();
      const active = await listTen8ActiveIncidents(agencyId);
      const inc = active.find((i) => incidentPayloadHasUnit(i, targetUnit));
      if (!inc) {
        return `${csPart}no active calls assigned at this time.`;
      }
      const codeOrType = inc.incident_type || "call";
      const loc = inc.location || "unknown location";
      return `${csPart}you're on ${codeOrType} at ${loc}.`;
    }

    case "phone":
    case "contact":
      return `${csPart}negative, that contact is not in our database.`;

    case "external_address":
    case "legal_code":
    case "general_query":
      return `${csPart}negative, web lookup is not configured on this server.`;

    default:
      return `${csPart}negative, I don't have that information.`;
  }
}
