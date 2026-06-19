import { getAgencyIntegrationValue } from "../store.js";
import { recordLookupResult } from "../integrations/health.js";
import type { CadPlateLookupHit } from "../ten8/cadRadioLookup.js";
import {
  callSignForReadback,
  plateToSpokenPhonetic,
  stateCodeToSpoken,
  vinLast6Spoken,
} from "./platePhonetics.js";
import { plateLookupFailureLine, vinLookupFailureLine } from "./lookupSpeech.js";

export interface PlateLookupResult {
  ok: boolean;
  plate?: string | null;
  state?: string | null;
  year?: string | null;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  vin?: string | null;
  provider?: string;
  reason?: string;
  message?: string;
  ms?: number;
}

const PLACEHOLDER = new Set([
  "unknown",
  "unspecified",
  "n/a",
  "na",
  "none",
  "null",
]);

function cleanField(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const s = String(value).trim();
  if (!s || PLACEHOLDER.has(s.toLowerCase())) {
    return null;
  }
  return s;
}

async function getPlateConfig(agencyId: number): Promise<{
  apiKey: string | null;
  provider: string;
  defaultState: string;
  vinKey: string | null;
}> {
  const apiKey = await getAgencyIntegrationValue(agencyId, "license_plate_lookup_api_key");
  const provider =
    (await getAgencyIntegrationValue(agencyId, "plate_lookup_provider"))?.trim().toLowerCase() ||
    process.env.PLATE_LOOKUP_PROVIDER?.trim().toLowerCase() ||
    "platetovin";
  const defaultState =
    (await getAgencyIntegrationValue(agencyId, "plate_lookup_default_state"))?.trim().toUpperCase() ||
    process.env.PLATE_LOOKUP_DEFAULT_STATE?.trim().toUpperCase() ||
    "CA";
  const vinKey = await getAgencyIntegrationValue(agencyId, "vin_lookup_api_key");
  return { apiKey: apiKey?.trim() || null, provider, defaultState, vinKey: vinKey?.trim() || null };
}

async function lookupPlateToVin(
  plate: string,
  state: string,
  apiKey: string,
): Promise<PlateLookupResult> {
  const started = Date.now();
  try {
    const r = await fetch("https://platetovin.com/api/convert", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ state, plate }),
    });
    const parsed = (await r.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
      vin?: Record<string, unknown>;
    } | null;
    if (r.ok && parsed?.success && parsed.vin) {
      const v = parsed.vin;
      return {
        ok: true,
        plate,
        state,
        year: cleanField(v.year),
        make: cleanField(v.make),
        model: cleanField(v.model),
        vin: cleanField(v.vin),
        color: cleanField(v.color && typeof v.color === "object" ? (v.color as { name?: string }).name : v.color),
        provider: "platetovin",
        ms: Date.now() - started,
      };
    }
    if (r.status === 401) {
      return { ok: false, plate, state, reason: "auth_error", message: "Invalid plate API key", provider: "platetovin", ms: Date.now() - started };
    }
    if (r.status === 402) {
      return { ok: false, plate, state, reason: "insufficient_credit", message: parsed?.message ?? "Out of credits", provider: "platetovin", ms: Date.now() - started };
    }
    if (r.status === 200 && parsed?.success === false) {
      return { ok: false, plate, state, reason: "no_record", message: parsed?.message ?? "No record", provider: "platetovin", ms: Date.now() - started };
    }
    return { ok: false, plate, state, reason: "api_error", message: parsed?.message ?? `HTTP ${r.status}`, provider: "platetovin", ms: Date.now() - started };
  } catch (e) {
    return { ok: false, plate, state, reason: "network_error", message: e instanceof Error ? e.message : String(e), provider: "platetovin", ms: Date.now() - started };
  }
}

export async function lookupVin(agencyId: number, vin: string): Promise<PlateLookupResult> {
  const clean = vin.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(clean)) {
    return { ok: false, reason: "invalid_vin", vin: clean };
  }
  const { vinKey, apiKey } = await getPlateConfig(agencyId);
  const key = vinKey || apiKey;
  if (!key) {
    return { ok: false, reason: "not_configured", message: "Set VIN or plate lookup API key in Integrations" };
  }
  const started = Date.now();
  try {
    const r = await fetch(`https://api.auto.dev/vin/${encodeURIComponent(clean)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const parsed = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (r.ok && parsed) {
      recordLookupResult(agencyId, "vin_lookup", { ok: true });
      return {
        ok: true,
        vin: clean,
        year: cleanField(parsed.year ?? (parsed.vehicle as Record<string, unknown> | undefined)?.year),
        make: cleanField(parsed.make ?? (parsed.vehicle as Record<string, unknown> | undefined)?.make),
        model: cleanField(parsed.model ?? (parsed.vehicle as Record<string, unknown> | undefined)?.model),
        provider: "autodev",
        ms: Date.now() - started,
      };
    }
    const reason =
      r.status === 404
        ? "no_record"
        : r.status === 401 || r.status === 403
          ? "auth_error"
          : r.status === 402
            ? "insufficient_credit"
            : "api_error";
    const result: PlateLookupResult = {
      ok: false,
      vin: clean,
      reason,
      message: String(parsed?.error ?? parsed?.message ?? `HTTP ${r.status}`),
      provider: "autodev",
      ms: Date.now() - started,
    };
    recordLookupResult(agencyId, "vin_lookup", result);
    return result;
  } catch (e) {
    return { ok: false, vin: clean, reason: "network_error", message: e instanceof Error ? e.message : String(e), provider: "autodev", ms: Date.now() - started };
  }
}

export async function runPlateLookup(
  agencyId: number,
  plate: string,
  state?: string | null,
): Promise<PlateLookupResult> {
  const p = plate.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(p)) {
    return { ok: false, reason: "invalid_plate", plate: p };
  }
  const { apiKey, defaultState } = await getPlateConfig(agencyId);
  if (!apiKey) {
    return { ok: false, reason: "not_configured", message: "Set license plate lookup API key in Admin → Integrations" };
  }
  const st = (state || defaultState).toUpperCase();
  const result = await lookupPlateToVin(p, st, apiKey);
  recordLookupResult(agencyId, "plate_lookup", result);
  return result;
}

function normalizeVehicleToken(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when DMV decode adds year/make/model not already stated from 10-8. */
export function cadMissingDmvVehicleFields(
  cad: CadPlateLookupHit | null,
  dmv: PlateLookupResult,
): boolean {
  if (!dmv.ok) {
    return false;
  }
  if (!cad?.found || !cad.vehicleSummary) {
    return true;
  }
  const cadNorm = normalizeVehicleToken(cad.vehicleSummary);
  for (const field of [dmv.year, dmv.make, dmv.model, dmv.color]) {
    const tok = normalizeVehicleToken(field);
    if (tok && tok.length >= 3 && !cadNorm.includes(tok)) {
      return true;
    }
  }
  return false;
}

function dmvVehiclePhrase(lookup: PlateLookupResult): string {
  const parts = [lookup.year, lookup.make, lookup.model].filter(Boolean).join(" ");
  return parts || "a vehicle with no further details available";
}

/** First on-air line: 10-8 CAD hit or NO MAKE. */
export function buildPlateCadLeadReadback(
  unitId: string,
  plate: string,
  state: string | null | undefined,
  cad: CadPlateLookupHit | null,
): string {
  const cs = callSignForReadback(unitId);
  const csPart = cs ? `${cs}, ` : "";
  const phonetic = plateToSpokenPhonetic(plate);
  const stSpoken = stateCodeToSpoken(state);
  if (!cad?.found) {
    return `${csPart}your ${stSpoken} plate of ${phonetic} comes back NO MAKE`;
  }
  const vehicle = cad.vehicleSummary?.trim() || "vehicle on file";
  let line = `${csPart}your ${stSpoken} plate of ${phonetic} comes back ${vehicle}`;
  if (cad.historyLine?.trim()) {
    line += `, ${cad.historyLine.trim()}`;
  }
  return line;
}

/** Second on-air line: PlateToVin confirmation (always when DMV succeeds). */
export function buildPlateDmvTailReadback(
  unitId: string,
  dmv: PlateLookupResult,
  cad: CadPlateLookupHit | null,
): string | null {
  if (!dmv.ok) {
    const cs = callSignForReadback(unitId);
    const csPart = cs ? `${cs}, ` : "";
    return plateLookupFailureLine(csPart, dmv);
  }
  const cs = callSignForReadback(unitId);
  const csPart = cs ? `${cs}, ` : "";
  const vehicle = dmvVehiclePhrase(dmv);
  const vinPart = dmv.vin ? ` the last six of the vin is ${vinLast6Spoken(dmv.vin)}` : "";
  if (cad?.found && !cadMissingDmvVehicleFields(cad, dmv)) {
    if (dmv.vin) {
      return `${csPart}DMV confirms, last six of the vin is ${vinLast6Spoken(dmv.vin)}.`;
    }
    return null;
  }
  return `${csPart}to a ${vehicle}${vinPart}.`;
}

/**
 * Single fluid plate readback: the 10-8 (CAD) lead and the DMV/PlateToVin tail
 * spoken as ONE transmission instead of two. The tail's repeated call-sign prefix
 * is stripped so it reads as one continuous sentence rather than two separate
 * calls with a pause between them.
 */
export function buildPlateCombinedReadback(
  unitId: string,
  plate: string,
  state: string | null | undefined,
  cad: CadPlateLookupHit | null,
  dmv: PlateLookupResult,
): string {
  const lead = buildPlateCadLeadReadback(unitId, plate, state, cad);
  const tail = buildPlateDmvTailReadback(unitId, dmv, cad);
  const leadClean = lead.replace(/[.\s]+$/, "");
  if (!tail?.trim()) {
    return `${leadClean}.`;
  }
  const cs = callSignForReadback(unitId);
  const prefix = cs ? `${cs}, ` : "";
  const tailBody = prefix && tail.startsWith(prefix) ? tail.slice(prefix.length) : tail;
  return `${leadClean}. ${tailBody.trim()}`;
}

export function buildPlateReadback(unitId: string, lookup: PlateLookupResult): string {
  const cs = callSignForReadback(unitId);
  const csPart = cs ? `${cs}, ` : "";
  if (!lookup.ok) {
    if (lookup.reason === "no_record" && lookup.plate) {
      return `${csPart}your ${stateCodeToSpoken(lookup.state)} plate of ${plateToSpokenPhonetic(lookup.plate)}, ${plateLookupFailureLine("", lookup).trim()}`;
    }
    return plateLookupFailureLine(csPart, lookup);
  }
  const vehicleParts = [lookup.color, lookup.year, lookup.make, lookup.model].filter(Boolean).join(" ");
  const phonetic = plateToSpokenPhonetic(lookup.plate ?? "");
  const vinPart = lookup.vin ? `, last six of vin ${vinLast6Spoken(lookup.vin)}` : "";
  if (!vehicleParts) {
    return `${csPart}your ${stateCodeToSpoken(lookup.state)} plate of ${phonetic} comes back to a vehicle with no further details available.`;
  }
  return `${csPart}your ${stateCodeToSpoken(lookup.state)} plate of ${phonetic} comes back to a ${vehicleParts}${vinPart}.`;
}

export function buildVinReadback(unitId: string, lookup: PlateLookupResult): string {
  const cs = callSignForReadback(unitId);
  const csPart = cs ? `${cs}, ` : "";
  if (!lookup.ok) {
    return vinLookupFailureLine(csPart, lookup);
  }
  const core = [lookup.year, lookup.make, lookup.model].filter(Boolean).join(" ");
  if (!core) {
    return `${csPart}vin comes back valid but vehicle details are unavailable.`;
  }
  return `${csPart}vin comes back to a ${core}.`;
}

/** Pending 912 — unit asked for plate without giving plate yet. */
const pendingPlate = new Map<string, number>();
const PLATE_TTL_MS = 30_000;

function pendingKey(agencyId: number, unitId: string): string {
  return `${agencyId}:${unitId}`;
}

export function notePendingPlateRequest(agencyId: number, unitId: string): void {
  pendingPlate.set(pendingKey(agencyId, unitId), Date.now());
}

export function consumePendingPlateRequest(agencyId: number, unitId: string): boolean {
  const key = pendingKey(agencyId, unitId);
  const at = pendingPlate.get(key);
  if (!at) {
    return false;
  }
  pendingPlate.delete(key);
  return Date.now() - at <= PLATE_TTL_MS;
}
