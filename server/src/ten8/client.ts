import { getAgencyIntegrationValue } from "../store.js";
import { finalizeTen8NewIncidentBody } from "./incidentPayload.js";

// 10-8 retired the AWS GovCloud gateway in the v1.1.0 spec (it now 502s). The
// CAD API is served from connect.10-8systems.com. Per-agency overrides via
// `ten8_api_base_url` still win for anyone on a different host.
const DEFAULT_BASE = "https://connect.10-8systems.com";

async function ten8Config(agencyId: number): Promise<{
  baseUrl: string;
  apiKey: string | null;
  apiSecret: string | null;
  live: boolean;
} | null> {
  const apiKey = await getAgencyIntegrationValue(agencyId, "ten8_api_key");
  const apiSecret = await getAgencyIntegrationValue(agencyId, "ten8_api_secret");
  if (!apiKey?.trim() || !apiSecret?.trim()) {
    return null;
  }
  const baseUrl =
    (await getAgencyIntegrationValue(agencyId, "ten8_api_base_url"))?.trim() || DEFAULT_BASE;
  const liveRaw = await getAgencyIntegrationValue(agencyId, "ten8_live_execution");
  const live = liveRaw === "1" || liveRaw?.toLowerCase() === "true";
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), live };
}

async function ten8Fetch(
  agencyId: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const cfg = await ten8Config(agencyId);
  if (!cfg) {
    return { ok: false, status: 0, data: { error: "ten8_not_configured" } };
  }
  // Strip special characters from everything we send (10-8 only accepts letters, numbers, spaces,
  // commas, and periods; dashes/brackets/etc. can crash it).
  const safeBody = body !== undefined ? sanitizeTen8Body(body) : undefined;
  if (!cfg.live && method !== "GET") {
    console.log(`[ten8] shadow ${method} ${path}`, safeBody ?? "");
    return { ok: true, status: 200, data: { shadow: true, method, path, body: safeBody } };
  }
  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: {
        "X-API-Key": cfg.apiKey!,
        "X-API-Secret": cfg.apiSecret!,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: safeBody !== undefined ? JSON.stringify(safeBody) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // The host is unreachable (DNS/TLS/connection refused/timeout) — fetch rejects rather than
    // returning a response. Surface it as a structured network error (status 0) instead of letting
    // it bubble up as an opaque 500, so callers (and the API tester) can see why.
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const reason = e.cause?.code || e.cause?.message || e.message || "network_error";
    console.error(`[ten8] ${method} ${url} failed: ${reason}`);
    return {
      ok: false,
      status: 0,
      data: { error: "ten8_unreachable", reason: String(reason), url: cfg.baseUrl },
    };
  }
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    data = await r.text().catch(() => null);
  }
  return { ok: r.ok, status: r.status, data };
}

/**
 * 10-8's incident API rejects (and can crash on) special characters. Reduce text to letters,
 * numbers, spaces, commas, and periods only — dashes, brackets, parentheses, slashes, etc. out.
 */
function sanitizeForTen8(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 ,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strictest: letters, numbers, and spaces only — used for free-text comments. */
function sanitizeForTen8Strict(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Recursively sanitize every string value in a request body before it is sent to 10-8. */
function sanitizeTen8Body(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeForTen8(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeTen8Body);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeTen8Body(v);
    }
    return out;
  }
  return value;
}

/**
 * Build a safe New Incident payload for 10-8.
 *
 * Most fields are sanitized, but `type` must stay byte-identical to the
 * agency-approved CAD call-type string (including hyphens / spacing) or later
 * 10-8 workflows can reject it as not valid for that agency.
 */
export function prepareTen8NewIncidentBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeTen8Body(body) as Record<string, unknown>;
  if (typeof body.type === "string") {
    sanitized.type = body.type;
  }
  return finalizeTen8NewIncidentBody(sanitized);
}

export async function ten8AddVehicle(
  agencyId: number,
  callId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; shadow?: boolean; status?: number; data?: unknown }> {
  const lookup = encodeURIComponent(callId);
  const res = await ten8Fetch(agencyId, "POST", `/v1/incidents/${lookup}/vehicles`, body);
  return {
    ok: res.ok,
    shadow: (res.data as { shadow?: boolean })?.shadow === true,
    status: res.status,
    data: res.data,
  };
}

export async function ten8AddComment(
  agencyId: number,
  callId: string,
  comment: string,
): Promise<{ ok: boolean; shadow?: boolean; data?: unknown }> {
  const lookup = encodeURIComponent(callId);
  // Comments are restricted to letters, numbers, and spaces only (no commas/periods either).
  const res = await ten8Fetch(agencyId, "POST", `/v1/incidents/${lookup}/comments`, {
    officer: "AI Dispatch",
    comment: sanitizeForTen8Strict(comment).slice(0, 4000),
    type: "comment",
  });
  return { ok: res.ok, shadow: (res.data as { shadow?: boolean })?.shadow === true, data: res.data };
}

export async function ten8Configured(agencyId: number): Promise<boolean> {
  return (await ten8Config(agencyId)) != null;
}

export async function ten8ListIncidents(
  agencyId: number,
  opts?: { from?: number; to?: number; field?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let qs = "";
  if (opts?.from != null && opts.field) {
    const params = new URLSearchParams({ from: String(opts.from), field: opts.field });
    if (opts.to != null) {
      params.set("to", String(opts.to));
    }
    qs = `?${params.toString()}`;
  }
  return ten8Fetch(agencyId, "GET", `/v1/incidents${qs}`);
}

const DEFAULT_NEW_INCIDENT_BASE = "https://interface.10-8systems.com";

async function newIncidentConfig(agencyId: number): Promise<{
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  live: boolean;
} | null> {
  let apiKey = (await getAgencyIntegrationValue(agencyId, "ten8_new_incident_api_key"))?.trim() ?? "";
  let apiSecret =
    (await getAgencyIntegrationValue(agencyId, "ten8_new_incident_api_secret"))?.trim() ?? "";
  if (!apiKey || !apiSecret) {
    const cad = await ten8Config(agencyId);
    if (!cad) {
      return null;
    }
    apiKey = cad.apiKey!;
    apiSecret = cad.apiSecret!;
  }
  const baseUrl =
    (await getAgencyIntegrationValue(agencyId, "ten8_new_incident_api_base_url"))?.trim() ||
    DEFAULT_NEW_INCIDENT_BASE;
  const liveRaw = await getAgencyIntegrationValue(agencyId, "ten8_live_execution");
  const live = liveRaw === "1" || liveRaw?.toLowerCase() === "true";
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, apiSecret, live };
}

export async function ten8NewIncidentConfigured(agencyId: number): Promise<boolean> {
  return (await newIncidentConfig(agencyId)) != null;
}

/** Create a CAD call via 10-8 legacy New Incident API (Basic auth). */
export async function ten8CreateIncident(
  agencyId: number,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; shadow?: boolean; status?: number; data?: unknown }> {
  const cfg = await newIncidentConfig(agencyId);
  if (!cfg) {
    return { ok: false, data: { error: "ten8_new_incident_not_configured" } };
  }
  const safeBody = prepareTen8NewIncidentBody(body);
  if (!cfg.live) {
    console.log("[ten8] shadow POST /incidents", safeBody);
    return { ok: true, shadow: true, data: { shadow: true, path: "/incidents", body: safeBody } };
  }
  const credentials = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64");
  let r: Response;
  try {
    r = await fetch(`${cfg.baseUrl}/incidents`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(safeBody),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string; message?: string } };
    const reason = e.cause?.code || e.cause?.message || e.message || "network_error";
    console.error(`[ten8] POST ${cfg.baseUrl}/incidents failed: ${reason}`);
    return { ok: false, status: 0, data: { error: "ten8_unreachable", reason: String(reason), url: cfg.baseUrl } };
  }
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    data = await r.text().catch(() => null);
  }
  return { ok: r.ok, status: r.status, data };
}

// --- v1.1.0 CAD API helpers (additive) -------------------------------------
// Thin wrappers over ten8Fetch used by the admin "10-8 CAD API tester". They do
// not change any base URL, auth, or sanitization: reads execute live; writes
// shadow unless the agency has live CAD writes enabled (see ten8Fetch).

/** Result shape returned by the CAD-API-tester helpers. */
export type Ten8CallResult = { ok: boolean; shadow?: boolean; status?: number; data?: unknown };

function wrapTen8(res: { ok: boolean; status: number; data: unknown }): Ten8CallResult {
  return {
    ok: res.ok,
    shadow: (res.data as { shadow?: boolean })?.shadow === true,
    status: res.status,
    data: res.data,
  };
}

/** Build a query string, keeping ONLY keys whose value is a non-empty string/number. */
function ten8QueryString(params: Record<string, unknown> | undefined): string {
  if (!params) {
    return "";
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    const str = typeof value === "string" ? value.trim() : String(value);
    if (str === "") {
      continue;
    }
    search.set(key, str);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** GET /v1/health — service health probe, routed through the agency's CAD config. */
export async function ten8Health(agencyId: number): Promise<Ten8CallResult> {
  return wrapTen8(await ten8Fetch(agencyId, "GET", "/v1/health"));
}

/** GET /v1/incidents/{lookup} — numeric id, incident number, or UUID. */
export async function ten8GetIncident(agencyId: number, lookup: string): Promise<Ten8CallResult> {
  return wrapTen8(await ten8Fetch(agencyId, "GET", `/v1/incidents/${encodeURIComponent(lookup)}`));
}

/** GET /v1/persons — fuzzy/explicit person search. */
export async function ten8SearchPersons(
  agencyId: number,
  params: Record<string, unknown>,
): Promise<Ten8CallResult> {
  return wrapTen8(await ten8Fetch(agencyId, "GET", `/v1/persons${ten8QueryString(params)}`));
}

/** GET /v1/vehicles — fuzzy/explicit vehicle search. */
export async function ten8SearchVehicles(
  agencyId: number,
  params: Record<string, unknown>,
): Promise<Ten8CallResult> {
  return wrapTen8(await ten8Fetch(agencyId, "GET", `/v1/vehicles${ten8QueryString(params)}`));
}

/** POST /v1/incidents/{lookup}/persons — link an existing person or create-and-link. */
export async function ten8AddPerson(
  agencyId: number,
  lookup: string,
  body: Record<string, unknown>,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "POST", `/v1/incidents/${encodeURIComponent(lookup)}/persons`, body),
  );
}

/** DELETE /v1/incidents/{lookup}/persons — unlink a person by id. */
export async function ten8RemovePerson(
  agencyId: number,
  lookup: string,
  personId: number,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "DELETE", `/v1/incidents/${encodeURIComponent(lookup)}/persons`, {
      personId,
    }),
  );
}

/** POST /v1/incidents/{lookup}/vehicles — link an existing vehicle or create-and-link. */
export async function ten8AddVehicleRecord(
  agencyId: number,
  lookup: string,
  body: Record<string, unknown>,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "POST", `/v1/incidents/${encodeURIComponent(lookup)}/vehicles`, body),
  );
}

/** DELETE /v1/incidents/{lookup}/vehicles — unlink a vehicle by id. */
export async function ten8RemoveVehicle(
  agencyId: number,
  lookup: string,
  vehicleId: number,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "DELETE", `/v1/incidents/${encodeURIComponent(lookup)}/vehicles`, {
      vehicleId,
    }),
  );
}

/** POST /v1/incidents/{lookup}/tags — add a tag by id or name. */
export async function ten8AddTag(
  agencyId: number,
  lookup: string,
  body: Record<string, unknown>,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "POST", `/v1/incidents/${encodeURIComponent(lookup)}/tags`, body),
  );
}

/** DELETE /v1/incidents/{lookup}/tags — remove a tag by id. */
export async function ten8RemoveTag(
  agencyId: number,
  lookup: string,
  tagId: number,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(agencyId, "DELETE", `/v1/incidents/${encodeURIComponent(lookup)}/tags`, {
      tagId,
    }),
  );
}

/** PUT /v1/incidents/{lookup}/comments/{commentId} — edit an existing comment. */
export async function ten8UpdateComment(
  agencyId: number,
  lookup: string,
  commentId: number,
  comment: string,
): Promise<Ten8CallResult> {
  return wrapTen8(
    await ten8Fetch(
      agencyId,
      "PUT",
      `/v1/incidents/${encodeURIComponent(lookup)}/comments/${encodeURIComponent(String(commentId))}`,
      { comment },
    ),
  );
}
