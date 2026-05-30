import {
  ten8GetIncident,
  ten8ListIncidents,
  ten8SearchPersons,
  ten8SearchVehicles,
} from "./client.js";

function callCodeForRadio(incidentType: string | null): string {
  const t = (incidentType ?? "").trim();
  if (!t) {
    return "call";
  }
  const sep = t.match(/^(.+?)\s+[-–—]\s+/);
  if (sep) {
    return sep[1]!.trim();
  }
  const lead = t.match(/^(\d{2,4}[A-Za-z]?)\b/);
  if (lead) {
    return lead[1]!;
  }
  return t;
}

function shortenLocationForRadio(loc: string | null): string {
  if (!loc?.trim()) {
    return "";
  }
  const parts = loc
    .split(",")
    .map((p) => p.replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, "").trim())
    .filter((p) => p && !/^USA$/i.test(p) && !/^\d{5}(?:-\d{4})?$/.test(p) && !/^[A-Z]{2}$/.test(p));
  return parts.slice(0, 2).join(", ");
}

type Ten8Incident = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function incidentCallId(inc: Ten8Incident): string {
  return (
    str(inc.incident_id) ||
    str(inc.incident_id1) ||
    (inc.id != null ? String(inc.id) : "") ||
    str(inc.uuid)
  );
}

function incidentLocation(inc: Ten8Incident): string {
  const direct = str(inc.location);
  if (direct) {
    return direct;
  }
  const parts = [str(inc.address), str(inc.city), str(inc.state)].filter(Boolean);
  return parts.join(", ");
}

function incidentComments(inc: Ten8Incident, max = 3): string | null {
  const comments = inc.comments;
  if (!Array.isArray(comments) || comments.length === 0) {
    return null;
  }
  const texts = comments
    .map((c) => {
      if (!c || typeof c !== "object") {
        return "";
      }
      return str((c as Record<string, unknown>).comment);
    })
    .filter(Boolean);
  if (!texts.length) {
    return null;
  }
  return texts.slice(-max).join("; ").slice(0, 600);
}

function incidentUnits(inc: Ten8Incident): string[] {
  const units = inc.units;
  if (!Array.isArray(units)) {
    return [];
  }
  return units
    .map((u) => {
      if (!u || typeof u !== "object") {
        return "";
      }
      return str((u as Record<string, unknown>).unit);
    })
    .filter(Boolean);
}

/** Map a live 10-8 Incident object into the shape used by pending/call-detail radio readbacks. */
export function mapTen8ApiIncident(inc: Ten8Incident): {
  call_id: string;
  incident_type: string | null;
  status: string | null;
  location: string | null;
  payload: { incident: Ten8Incident };
} {
  return {
    call_id: incidentCallId(inc),
    incident_type: str(inc.type) || null,
    status: str(inc.status) || null,
    location: incidentLocation(inc) || null,
    payload: { incident: inc },
  };
}

export function buildCadPersonSearchParams(subject: string): Record<string, unknown> {
  const s = subject.trim();
  const params: Record<string, unknown> = { limit: 5 };
  const dobMatch = s.match(/\b(?:dob|born)\s*[:\s]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/i);
  if (dobMatch) {
    params.dob = dobMatch[1]!.trim();
  }
  const withoutDob = dobMatch ? s.replace(dobMatch[0], " ").replace(/\s+/g, " ").trim() : s;
  if (withoutDob) {
    params.q = withoutDob;
  }
  return params;
}

const VEHICLE_SEARCH_STOPWORDS = new Set([
  "PLATE",
  "RUN",
  "CAD",
  "RECORDS",
  "VEHICLE",
  "BLACK",
  "WHITE",
  "HONDA",
  "FORD",
  "TOYOTA",
]);

export function buildCadVehicleSearchParams(subject: string): Record<string, unknown> {
  const s = subject.trim().toUpperCase();
  const params: Record<string, unknown> = { limit: 5 };
  const vinMatch = s.match(/\b([A-HJ-NPR-Z0-9]{11,17})\b/);
  if (vinMatch) {
    params.vin = vinMatch[1]!;
  } else {
    const tokens = s.match(/\b[A-Z0-9]{5,8}\b/g) ?? [];
    const plate = tokens.find((t) => !VEHICLE_SEARCH_STOPWORDS.has(t) && /\d/.test(t));
    if (plate) {
      params.license = plate;
    } else {
      params.q = subject.trim();
    }
  }
  const stateMatch = s.match(/\b(CA|NV|AZ|OR|TX|FL|NY)\b/);
  if (stateMatch) {
    params.state = stateMatch[1]!;
  }
  return params;
}

function personLabel(p: Record<string, unknown>): string {
  const parts = [str(p.firstName), str(p.middleName), str(p.lastName)].filter(Boolean);
  const name = parts.join(" ") || str(p.alias) || "unknown name";
  const extras: string[] = [];
  if (str(p.dob)) {
    extras.push(`DOB ${str(p.dob)}`);
  }
  if (str(p.sex) || str(p.race)) {
    extras.push([str(p.sex), str(p.race)].filter(Boolean).join(" "));
  }
  const calls = Array.isArray(p.calls) ? p.calls.length : 0;
  if (calls > 0) {
    extras.push(`${calls} prior call${calls === 1 ? "" : "s"}`);
  }
  return extras.length ? `${name}, ${extras.join(", ")}` : name;
}

function vehicleLabel(v: Record<string, unknown>): string {
  const plate = [str(v.state), str(v.license)].filter(Boolean).join(" ");
  const desc = [str(v.year), str(v.color), str(v.make), str(v.model)].filter(Boolean).join(" ");
  const calls = Array.isArray(v.calls) ? v.calls.length : 0;
  const parts = [plate || str(v.vin), desc].filter(Boolean);
  if (calls > 0) {
    parts.push(`${calls} prior call${calls === 1 ? "" : "s"}`);
  }
  return parts.join(", ") || "unknown vehicle";
}

export async function fetchCadPersonSearchRadio(
  agencyId: number,
  subject: string,
): Promise<{ ok: boolean; line: string; status?: number }> {
  const res = await ten8SearchPersons(agencyId, buildCadPersonSearchParams(subject));
  if (!res.ok) {
    const err =
      res.data && typeof res.data === "object"
        ? str((res.data as Record<string, unknown>).error) ||
            str((res.data as Record<string, unknown>).message)
        : "";
    if (res.status === 0 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      if (d.error === "ten8_unreachable") {
        return { ok: false, line: "negative, cannot reach 10-8 CAD right now.", status: res.status };
      }
    }
    return {
      ok: false,
      line: err ? `negative, CAD person search failed, ${err}.` : "negative, CAD person search failed.",
      status: res.status,
    };
  }
  const data = res.data as Record<string, unknown> | null;
  const results = Array.isArray(data?.results) ? (data!.results as Record<string, unknown>[]) : [];
  if (results.length === 0) {
    return { ok: true, line: "no matching persons in CAD." };
  }
  const items = results.slice(0, 3).map(personLabel);
  let body = results.length === 1 ? `one match: ${items[0]}` : `${results.length} matches: ${items.join("; ")}`;
  if (data?.truncated === true) {
    body += "; narrow the search for more";
  }
  return { ok: true, line: body };
}

export async function fetchCadVehicleSearchRadio(
  agencyId: number,
  subject: string,
): Promise<{ ok: boolean; line: string; status?: number }> {
  const res = await ten8SearchVehicles(agencyId, buildCadVehicleSearchParams(subject));
  if (!res.ok) {
    const err =
      res.data && typeof res.data === "object"
        ? str((res.data as Record<string, unknown>).error) ||
            str((res.data as Record<string, unknown>).message)
        : "";
    if (res.status === 0 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      if (d.error === "ten8_unreachable") {
        return { ok: false, line: "negative, cannot reach 10-8 CAD right now.", status: res.status };
      }
    }
    return {
      ok: false,
      line: err ? `negative, CAD vehicle search failed, ${err}.` : "negative, CAD vehicle search failed.",
      status: res.status,
    };
  }
  const data = res.data as Record<string, unknown> | null;
  const results = Array.isArray(data?.results) ? (data!.results as Record<string, unknown>[]) : [];
  if (results.length === 0) {
    return { ok: true, line: "no matching vehicles in CAD." };
  }
  const items = results.slice(0, 3).map(vehicleLabel);
  let body = results.length === 1 ? `one match: ${items[0]}` : `${results.length} matches: ${items.join("; ")}`;
  if (data?.truncated === true) {
    body += "; narrow the search for more";
  }
  return { ok: true, line: body };
}

export async function fetchCadIncidentLookupRadio(
  agencyId: number,
  lookup: string,
): Promise<{ ok: boolean; line: string; status?: number }> {
  const res = await ten8GetIncident(agencyId, lookup.trim());
  if (!res.ok) {
    if (res.status === 404) {
      return { ok: false, line: "negative, incident not found in CAD.", status: res.status };
    }
    if (res.status === 0 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      if (d.error === "ten8_unreachable") {
        return { ok: false, line: "negative, cannot reach 10-8 CAD right now.", status: res.status };
      }
    }
    return { ok: false, line: "negative, CAD incident lookup failed.", status: res.status };
  }
  const inc = (res.data && typeof res.data === "object" ? res.data : {}) as Ten8Incident;
  const mapped = mapTen8ApiIncident(inc);
  const typeName = callCodeForRadio(mapped.incident_type);
  const loc = shortenLocationForRadio(mapped.location);
  const parts = [loc ? `${typeName} at ${loc}` : typeName];
  if (mapped.status) {
    parts.push(`status ${mapped.status}`);
  }
  const units = incidentUnits(inc);
  if (units.length) {
    parts.push(`units ${units.slice(0, 4).join(", ")}`);
  }
  const comments = incidentComments(inc);
  parts.push(comments ? `comments: ${comments}` : "no comments on the call yet");
  const tags = Array.isArray(inc.tags)
    ? (inc.tags as Record<string, unknown>[]).map((t) => str(t.tag)).filter(Boolean)
    : [];
  if (tags.length) {
    parts.push(`tags ${tags.slice(0, 4).join(", ")}`);
  }
  return { ok: true, line: parts.join(", ") };
}

export async function fetchCadOpenIncidentsRadio(
  agencyId: number,
): Promise<{ ok: boolean; incidents: ReturnType<typeof mapTen8ApiIncident>[]; line?: string; status?: number }> {
  const res = await ten8ListIncidents(agencyId);
  if (!res.ok) {
    if (res.status === 0 && res.data && typeof res.data === "object") {
      const d = res.data as Record<string, unknown>;
      if (d.error === "ten8_unreachable") {
        return {
          ok: false,
          incidents: [],
          line: "negative, cannot reach 10-8 CAD right now.",
          status: res.status,
        };
      }
    }
    return { ok: false, incidents: [], line: "negative, could not list open calls from CAD.", status: res.status };
  }
  const rows = Array.isArray(res.data) ? (res.data as Ten8Incident[]) : [];
  const open = rows.filter((inc) => inc.isClosed !== 1);
  return { ok: true, incidents: open.map(mapTen8ApiIncident) };
}

/** Build POST /v1/incidents/{lookup}/persons body from dispatcher parse fields. */
export function buildCadPersonLinkBody(link: {
  relation: string | null;
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
  notes: string | null;
}): Record<string, unknown> {
  const person: Record<string, unknown> = {};
  if (link.first_name) {
    person.firstName = link.first_name;
  }
  if (link.last_name) {
    person.lastName = link.last_name;
  }
  if (link.dob) {
    person.dob = link.dob;
  }
  const body: Record<string, unknown> = { person };
  if (link.relation) {
    body.relation = link.relation;
  }
  if (link.notes) {
    body.notes = link.notes;
  }
  return body;
}
