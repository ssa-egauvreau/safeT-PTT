import { listPositions } from "../store.js";
import { listTen8ActiveIncidents } from "../ten8/store.js";
import { ten8Configured } from "../ten8/client.js";
import {
  fetchCadCallTagsRadio,
  fetchCadIncidentLookupRadio,
  fetchCadOpenIncidentsRadio,
  fetchCadPersonSearchRadio,
  fetchCadVehicleSearchRadio,
} from "../ten8/cadRadioLookup.js";
import { extractCallLookupNumber } from "./cadDispatchRules.js";
import { lookupSsaProperty } from "./ssaProperties.js";
import { accountCodeDashForm } from "./speech/numbers.js";
import { prepareLocationForTts } from "./speech/locationSpeech.js";
import { formatPhoneForTts } from "./speech/phoneSpeech.js";
import type { InfoRequestFields } from "./parse.js";
import { isWebSearchConfigured, webSearchAnswer } from "./webSearch.js";
import {
  cadLookupFailedLine,
  cadSystemDownLine,
  webSearchFailureLine,
  webSearchNotConfiguredLine,
} from "./lookupSpeech.js";
import {
  buildUnitLocationResponse,
  findRadioMapPosition,
  parseUnitLocationSubject,
} from "./unitLocation.js";

function normalizeUnitId(u: string): string {
  return u.trim().toLowerCase().replace(/^27-/, "");
}

/** True when the incident has at least one unit assigned in CAD payload. */
export function incidentHasAssignedUnits(inc: { payload: unknown }): boolean {
  if (!inc.payload || typeof inc.payload !== "object") {
    return false;
  }
  const body = inc.payload as Record<string, unknown>;
  const incident =
    body.incident && typeof body.incident === "object"
      ? (body.incident as Record<string, unknown>)
      : body;
  const units = incident.units ?? incident.Units;
  if (!Array.isArray(units) || units.length === 0) {
    return false;
  }
  return units.some((u) => {
    if (!u || typeof u !== "object") {
      return false;
    }
    const row = u as Record<string, unknown>;
    return String(row.unit ?? row.id ?? row.unitId ?? row.unit_id ?? "").trim().length > 0;
  });
}

export function incidentPayloadHasUnit(inc: { payload: unknown }, targetUnit: string): boolean {
  if (!targetUnit || !inc.payload || typeof inc.payload !== "object") {
    return false;
  }
  // Stored payload is the full webhook body { action, incident: { units: [{ unit: "352" }] } }.
  const body = inc.payload as Record<string, unknown>;
  const incident =
    body.incident && typeof body.incident === "object"
      ? (body.incident as Record<string, unknown>)
      : body;
  const units = incident.units ?? incident.Units;
  if (!Array.isArray(units)) {
    return false;
  }
  const want = normalizeUnitId(targetUnit);
  return units.some((u) => {
    if (!u || typeof u !== "object") {
      return false;
    }
    const row = u as Record<string, unknown>;
    const id = String(row.unit ?? row.id ?? row.unitId ?? row.unit_id ?? "").trim();
    return normalizeUnitId(id) === want;
  });
}

type ActiveIncident = Awaited<ReturnType<typeof listTen8ActiveIncidents>>[number];

/**
 * Speak just the radio code, not the full call type: "415 - Disturbing the Peace" → "415",
 * "961 - Car Stop" → "961". Types with no leading code (e.g. "Issue Notice") are read as-is.
 *
 * Exported (rather than file-local) so the radio-readback contract can be pinned in unit
 * tests — every spoken `unit_status` / `pending_calls` / `call_details` / `active_calls_for_unit`
 * answer renders through this helper, so a regression here changes what the AI dispatcher
 * actually says on the air for every active incident in the fleet.
 */
export function callCodeForRadio(incidentType: string | null): string {
  const t = (incidentType ?? "").trim();
  if (!t) {
    return "call";
  }
  const sep = t.match(/^(.+?)\s+[-–—]\s+/); // code before " - description"
  if (sep) {
    return sep[1]!.trim();
  }
  const lead = t.match(/^(\d{2,4}[A-Za-z]?)\b/); // bare leading code, e.g. "415" / "415e"
  if (lead) {
    return lead[1]!;
  }
  return t;
}

/**
 * Find one active incident matching the spoken subject (call number, type, or location words).
 *
 * Exported so the matching priority (call_id exact > digits-only id > full-substring on
 * call_id+type+location > all-words-substring) can be pinned in unit tests — this is the
 * function that decides which incident the dispatcher reads back details for when the
 * officer asks "what's on the 415 at the park", so a regression silently routes the
 * spoken answer to the wrong call.
 */
export function findIncidentBySubject(incidents: ActiveIncident[], subject: string | null): ActiveIncident | null {
  if (!subject?.trim()) {
    return incidents.length === 1 ? incidents[0]! : null;
  }
  const q = subject.trim().toLowerCase();
  const qDigits = q.replace(/[^0-9]/g, "");
  for (const inc of incidents) {
    const cid = (inc.call_id ?? "").toLowerCase();
    if (cid && (cid === q || (qDigits.length >= 3 && cid.replace(/[^0-9]/g, "") === qDigits))) {
      return inc;
    }
  }
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  for (const inc of incidents) {
    const hay = `${inc.call_id ?? ""} ${inc.incident_type ?? ""} ${inc.location ?? ""}`.toLowerCase();
    if (hay.includes(q) || (words.length > 0 && words.every((w) => hay.includes(w)))) {
      return inc;
    }
  }
  return null;
}

function commentValueToText(v: unknown): string | null {
  if (!v) {
    return null;
  }
  if (typeof v === "string") {
    return v.trim() || null;
  }
  if (Array.isArray(v)) {
    const texts = v
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const t = o.comment ?? o.text ?? o.note ?? o.body ?? o.message ?? o.value;
          return typeof t === "string" ? t.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
    return texts.length ? texts.slice(-3).join("; ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const t = o.comment ?? o.text ?? o.note ?? o.body ?? o.message;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  }
  return null;
}

/**
 * Pull comment/narrative text out of the stored 10-8 webhook payload, trying common field names.
 *
 * Exported so the field-name fallback order (comments / comment / narrative / notes / remarks /
 * details / description / callNotes / call_notes), the array-shape "last 3 items joined" rule,
 * and the 600-char cap can be pinned in unit tests. This is what the dispatcher actually reads
 * back when the officer asks for "details on call X" — a regression silently strips comments
 * (so the officer hears "no comments on the call yet" when CAD has them) or leaks the wrong
 * field, which is hard to catch without seeing it on the air.
 */
export function extractCommentsFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const inc =
    root.incident && typeof root.incident === "object"
      ? (root.incident as Record<string, unknown>)
      : root;
  const keys = [
    "comments",
    "comment",
    "narrative",
    "notes",
    "remarks",
    "details",
    "description",
    "callNotes",
    "call_notes",
  ];
  for (const k of keys) {
    const text = commentValueToText(inc[k] ?? root[k]);
    if (text) {
      return text.slice(0, 600);
    }
  }
  return null;
}

/**
 * Trim a full street address to street + city for brevity on the air (drop state/zip/country).
 *
 * Exported so the airtime-shortening rule (strip "STATE 12345" or "STATE 12345-6789", strip
 * a bare 5-digit ZIP, strip "USA", strip a bare 2-letter state token, then keep only the
 * first two comma parts) can be pinned in unit tests. Every spoken `unit_status` /
 * `active_calls_for_unit` / `call_details` / `pending_calls` answer pipes the call's
 * location through this helper, so a regression that lets the state/zip/country leak
 * through wastes ~3 seconds of airtime per readback and makes the dispatcher sound robotic.
 */
export function shortenLocationForRadio(loc: string | null): string {
  if (!loc?.trim()) {
    return "";
  }
  const parts = loc
    .split(",")
    .map((p) => p.replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, "").trim())
    .filter((p) => p && !/^USA$/i.test(p) && !/^\d{5}(?:-\d{4})?$/.test(p) && !/^[A-Z]{2}$/.test(p));
  return parts.slice(0, 2).join(", ");
}

export function buildInfoRequestAck(requestingUnit: string | null | undefined): string {
  if (!requestingUnit) {
    return "Copy. Standby.";
  }
  const csShort = /^27-0[0-3]0$/.test(requestingUnit)
    ? requestingUnit
    : requestingUnit.replace(/^27-/, "");
  return `${csShort}, copy. Standby.`;
}

/** Slow lookups: web search (phone book uses web, not a local list). */
export function infoRequestNeedsAsync(infoRequest: InfoRequestFields): boolean {
  const t = infoRequest.type;
  return [
    "phone",
    "contact",
    "external_address",
    "legal_code",
    "general_query",
    "cad_person_search",
    "cad_vehicle_search",
    "cad_incident_lookup",
    "cad_call_tags",
  ].includes(t);
}

function webNotConfiguredLine(csPart: string): string {
  return webSearchNotConfiguredLine(csPart);
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
        parts.push(`at ${prepareLocationForTts(prop.street)}`);
      }
      if (prop.city) {
        parts.push(prop.city);
      }
      return `${csPart}${parts.join(", ")}.`;
    }

    case "pending_calls": {
      let pending: ActiveIncident[] = [];
      if (await ten8Configured(agencyId)) {
        const live = await fetchCadOpenIncidentsRadio(agencyId);
        if (live.ok) {
          pending = live.incidents.map((inc) => ({
            ...inc,
            priority: null,
            updated_at: new Date().toISOString(),
          }));
        } else if (live.line) {
          return `${csPart}${live.line}`;
        }
      }
      if (pending.length === 0) {
        pending = await listTen8ActiveIncidents(agencyId);
      }
      if (pending.length === 0) {
        return `${csPart}no pending calls at this time.`;
      }
      const MAX_READ = 6;
      const items = pending.slice(0, MAX_READ).map((inc) => {
        const codeOrType = callCodeForRadio(inc.incident_type);
        const loc = shortenLocationForRadio(inc.location);
        const line = loc ? `${codeOrType} at ${loc}` : codeOrType;
        return inc.call_id ? `${line}, call ${inc.call_id}` : line;
      });
      const intro = pending.length === 1 ? "one pending call:" : `${pending.length} pending calls:`;
      let body = items.join("; ");
      if (pending.length > MAX_READ) {
        body += `; plus ${pending.length - MAX_READ} more on the dashboard`;
      }
      return `${csPart}${intro} ${body}.`;
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
      const codeOrType = callCodeForRadio(inc.incident_type);
      const loc = shortenLocationForRadio(inc.location) || "unknown location";
      return `${csPart}you're on ${codeOrType} at ${loc}.`;
    }

    case "call_details": {
      const subject = infoRequest.subject?.trim();
      const callNum = subject ? extractCallLookupNumber(subject) : null;
      if (callNum && (await ten8Configured(agencyId))) {
        const live = await fetchCadIncidentLookupRadio(agencyId, callNum);
        if (live.ok) {
          return `${csPart}${live.line}.`;
        }
        if (live.status === 404) {
          return `${csPart}${live.line}`;
        }
      }
      if (subject && !callNum) {
        return `${csPart}10-9 the call number to look up that incident.`;
      }
      const active = await listTen8ActiveIncidents(agencyId);
      if (active.length === 0) {
        return `${csPart}no active calls at this time.`;
      }
      const match = findIncidentBySubject(active, infoRequest.subject);
      if (!match) {
        return `${csPart}negative, I can't find that call. Say the call number or type.`;
      }
      const typeName = callCodeForRadio(match.incident_type);
      const loc = shortenLocationForRadio(match.location);
      const parts = [loc ? `${typeName} at ${loc}` : typeName];
      if (match.status?.trim()) {
        parts.push(`status ${match.status.trim()}`);
      }
      const comments = extractCommentsFromPayload(match.payload);
      parts.push(comments ? `comments: ${comments}` : "no comments on the call yet");
      return `${csPart}${parts.join(", ")}.`;
    }

    case "cad_person_search": {
      if (!(await ten8Configured(agencyId))) {
        return `${csPart}10-8 CAD is not configured.`;
      }
      if (!infoRequest.subject?.trim()) {
        return `${csPart}negative, no name or description for the person search.`;
      }
      const result = await fetchCadPersonSearchRadio(agencyId, infoRequest.subject);
      if (!result.ok) {
        return result.line.includes("CAD is down")
          ? cadSystemDownLine(csPart)
          : `${csPart}${result.line}.`;
      }
      return `${csPart}${result.line}.`;
    }

    case "cad_vehicle_search": {
      if (!(await ten8Configured(agencyId))) {
        return `${csPart}10-8 CAD is not configured.`;
      }
      if (!infoRequest.subject?.trim()) {
        return `${csPart}negative, no plate, VIN, or vehicle description heard.`;
      }
      const result = await fetchCadVehicleSearchRadio(agencyId, infoRequest.subject);
      if (!result.ok) {
        return result.line.includes("CAD is down")
          ? cadSystemDownLine(csPart)
          : `${csPart}${result.line}.`;
      }
      return `${csPart}${result.line}.`;
    }

    case "cad_incident_lookup": {
      if (!(await ten8Configured(agencyId))) {
        return `${csPart}10-8 CAD is not configured.`;
      }
      const lookup = infoRequest.subject?.trim() ?? "";
      const callNum = extractCallLookupNumber(lookup) ?? (/\d/.test(lookup) ? lookup : "");
      if (!callNum) {
        return `${csPart}10-9 the call number to look up that incident.`;
      }
      const result = await fetchCadIncidentLookupRadio(agencyId, callNum);
      if (!result.ok) {
        if (result.status === 404) {
          return `${csPart}${result.line}.`;
        }
        return result.line.includes("CAD is down")
          ? cadSystemDownLine(csPart)
          : cadLookupFailedLine(csPart);
      }
      return `${csPart}${result.line}.`;
    }

    case "cad_call_tags": {
      if (!(await ten8Configured(agencyId))) {
        return `${csPart}10-8 CAD is not configured.`;
      }
      const subject = infoRequest.subject?.trim() ?? "";
      const callNum = extractCallLookupNumber(subject);
      let tagQuery = subject.replace(callNum ?? "", "").trim();
      if (!tagQuery && subject && !callNum) {
        tagQuery = subject;
      }
      let callId = callNum;
      if (!callId) {
        const targetUnit = (requestingUnit ?? "").trim();
        const active = await listTen8ActiveIncidents(agencyId);
        const inc = active.find((i) => incidentPayloadHasUnit(i, targetUnit));
        callId = inc?.call_id?.trim() ?? null;
      }
      if (!callId) {
        return `${csPart}negative, no open call found for your unit. Say the call number.`;
      }
      const result = await fetchCadCallTagsRadio(agencyId, callId, tagQuery || null);
      if (!result.ok) {
        return result.line.includes("CAD is down")
          ? cadSystemDownLine(csPart)
          : cadLookupFailedLine(csPart);
      }
      return `${csPart}${result.line}`;
    }

    case "unit_location": {
      let parsed = parseUnitLocationSubject(infoRequest.subject);
      if (!parsed && requestingUnit) {
        const wantFullAddress = /\bfull\s+(street\s+)?address\b/i.test(infoRequest.subject ?? "");
        parsed = { targetUnit: requestingUnit, wantFullAddress };
      }
      if (!parsed) {
        return `${csPart}negative, which unit do you need a 10-20 on.`;
      }
      return buildUnitLocationResponse(agencyId, parsed, requestingUnit);
    }

    case "unit_status": {
      // "is 27-020 10-8?" / "is X on the air" / "is X available" / "what's X's status".
      // We don't have an explicit status field from CAD, so we infer:
      //   1. On an open call (assigned in 10-8) → busy / 10-23 on [code] at [loc]
      //   2. Otherwise: fresh GPS/presence (<10 min) → shows 10-8
      //   3. Otherwise: stale GPS/presence (<60 min) → last in service N minutes ago
      //   4. Otherwise: no recent radio activity, can't confirm status
      const parsedSubj = parseUnitLocationSubject(infoRequest.subject);
      const targetUnit =
        parsedSubj?.targetUnit?.trim() ||
        infoRequest.subject?.trim() ||
        requestingUnit?.trim() ||
        "";
      if (!targetUnit) {
        return `${csPart}negative, which unit do you want the status on.`;
      }
      const spokenUnit = /^27-0[0-3]0$/.test(targetUnit)
        ? targetUnit
        : targetUnit.replace(/^27-/, "");

      const active = await listTen8ActiveIncidents(agencyId);
      const assignedCall = active.find((i) => incidentPayloadHasUnit(i, targetUnit));
      if (assignedCall) {
        const codeOrType = callCodeForRadio(assignedCall.incident_type);
        const loc = shortenLocationForRadio(assignedCall.location);
        return loc
          ? `${csPart}${spokenUnit} is currently on ${codeOrType} at ${loc}.`
          : `${csPart}${spokenUnit} is currently on ${codeOrType}.`;
      }

      const positions = await listPositions(agencyId);
      const pos = findRadioMapPosition(positions, targetUnit);
      if (!pos) {
        return `${csPart}negative, no recent activity from ${spokenUnit} — last status unknown.`;
      }
      const lastSeenMs = Date.parse(pos.updated_at);
      if (!Number.isFinite(lastSeenMs)) {
        return `${csPart}negative, no recent activity from ${spokenUnit} — last status unknown.`;
      }
      const ageMin = Math.max(0, Math.round((Date.now() - lastSeenMs) / 60_000));
      if (ageMin <= 10) {
        return `${csPart}${spokenUnit} shows 10-8.`;
      }
      if (ageMin <= 60) {
        return `${csPart}${spokenUnit} last checked in ${ageMin} minutes ago in service.`;
      }
      return `${csPart}negative, no recent activity from ${spokenUnit} — last check-in was over an hour ago.`;
    }

    case "phone":
    case "contact": {
      if (!infoRequest.subject) {
        return `${csPart}negative, no contact specified.`;
      }
      if (!isWebSearchConfigured()) {
        return webNotConfiguredLine(csPart);
      }
      const webResult = await webSearchAnswer(infoRequest.subject, "phone");
      if (webResult.ok && webResult.raw) {
        const phone = typeof webResult.raw.phone === "string" ? webResult.raw.phone : null;
        if (phone) {
          const phoneSpoken = formatPhoneForTts(phone);
          const name =
            (typeof webResult.raw.name === "string" && webResult.raw.name) || infoRequest.subject;
          return `${csPart}${name}, number is ${phoneSpoken}.`;
        }
      }
      if (!webResult.ok) {
        return webSearchFailureLine(csPart, webResult);
      }
      return `${csPart}I can't find that information.`;
    }

    case "external_address": {
      if (!infoRequest.subject) {
        return `${csPart}negative, no place specified.`;
      }
      if (!isWebSearchConfigured()) {
        return webNotConfiguredLine(csPart);
      }
      const webResult = await webSearchAnswer(infoRequest.subject, "external_address");
      if (webResult.ok && webResult.raw && typeof webResult.raw.street === "string") {
        const r = webResult.raw;
        const name =
          (typeof r.name === "string" && r.name) || infoRequest.subject;
        const addressParts = [r.street, r.city, r.state].filter(Boolean).join(", ");
        return `${csPart}${name}, address is ${prepareLocationForTts(addressParts)}.`;
      }
      if (!webResult.ok) {
        return webSearchFailureLine(csPart, webResult);
      }
      return `${csPart}I can't find that information.`;
    }

    case "legal_code": {
      if (!infoRequest.subject) {
        return `${csPart}negative, no code question heard.`;
      }
      if (!isWebSearchConfigured()) {
        return webNotConfiguredLine(csPart);
      }
      const webResult = await webSearchAnswer(infoRequest.subject, "legal_code");
      if (webResult.ok && webResult.raw && typeof webResult.raw.code_section === "string") {
        const r = webResult.raw;
        const codeSpoken = String(r.code_section)
          .replace(/[()]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const parts = [codeSpoken];
        if (typeof r.short_title === "string" && r.short_title) {
          parts.push(r.short_title);
        }
        if (typeof r.brief_summary === "string" && r.brief_summary) {
          parts.push(r.brief_summary);
        }
        return `${csPart}${parts.join(", ")}`;
      }
      if (!webResult.ok) {
        return webSearchFailureLine(csPart, webResult);
      }
      return `${csPart}I can't find that information.`;
    }

    case "general_query": {
      if (!infoRequest.subject) {
        return `${csPart}negative, no question heard.`;
      }
      if (!isWebSearchConfigured()) {
        return webNotConfiguredLine(csPart);
      }
      const webResult = await webSearchAnswer(infoRequest.subject, "general");
      if (webResult.ok && webResult.raw && typeof webResult.raw.answer === "string") {
        return `${csPart}${webResult.raw.answer}`;
      }
      if (!webResult.ok) {
        return webSearchFailureLine(csPart, webResult);
      }
      return `${csPart}I can't find that information.`;
    }

    default:
      // "unknown" / unrecognized type: we have no specific lookup to run. Return null so the
      // caller keeps the model's own dispatcher_response instead of speaking a canned "negative"
      // line — otherwise normal traffic the model mis-tags as request_info gets no real reply.
      return null;
  }
}
