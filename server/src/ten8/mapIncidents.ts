import { getAgencyIntegrationValue } from "../store.js";
import { listTen8ActiveIncidents } from "./store.js";

const GEO_CACHE = new Map<string, { lat: number; lon: number; at: number }>();
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type Ten8MapIncident = {
  call_id: string;
  label: string;
  incident_type: string | null;
  location: string | null;
  lat: number;
  lon: number;
};

export function callLabel(incidentType: string | null, callId: string): string {
  const t = (incidentType ?? "").trim();
  const sep = t.match(/^(.+?)\s+[-–—]\s+/);
  if (sep?.[1]) {
    return sep[1].trim();
  }
  if (t) {
    return t.length > 40 ? `${t.slice(0, 38)}…` : t;
  }
  return callId;
}

export function coordsFromPayload(payload: unknown): { lat: number; lon: number } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload as Record<string, unknown>;
  const incident =
    body.incident && typeof body.incident === "object"
      ? (body.incident as Record<string, unknown>)
      : body;

  const candidates: Array<[unknown, unknown]> = [
    [incident.latitude, incident.longitude],
    [incident.lat, incident.lng],
    [incident.lat, incident.lon],
    [incident.Latitude, incident.Longitude],
    [incident.locationLat, incident.locationLng],
    [incident.location_lat, incident.location_lng],
  ];

  for (const [la, lo] of candidates) {
    const lat = Number(la);
    const lon = Number(lo);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon };
    }
  }
  return null;
}

async function geocodeAddress(
  agencyId: number,
  address: string,
): Promise<{ lat: number; lon: number } | null> {
  const key = address.trim().toLowerCase();
  if (!key) {
    return null;
  }
  const cached = GEO_CACHE.get(key);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) {
    return { lat: cached.lat, lon: cached.lon };
  }

  const googleKey =
    (await getAgencyIntegrationValue(agencyId, "google_maps_geocoding_api_key"))?.trim() ||
    process.env.GOOGLE_MAPS_GEOCODING_API_KEY?.trim() ||
    "";

  if (googleKey) {
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", address);
      url.searchParams.set("key", googleKey);
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = (await r.json()) as {
          status?: string;
          results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
        };
        const loc = data.results?.[0]?.geometry?.location;
        const lat = Number(loc?.lat);
        const lon = Number(loc?.lng);
        if (data.status === "OK" && Number.isFinite(lat) && Number.isFinite(lon)) {
          GEO_CACHE.set(key, { lat, lon, at: Date.now() });
          return { lat, lon };
        }
      }
    } catch {
      /* try nominatim */
    }
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", address);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");
    const r = await fetch(url.toString(), {
      headers: { "User-Agent": "SafeT-PTT-Console/1.0 (10-8 map pins)" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = (await r.json()) as Array<{ lat?: string; lon?: string }>;
      const hit = data[0];
      const lat = Number(hit?.lat);
      const lon = Number(hit?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        GEO_CACHE.set(key, { lat, lon, at: Date.now() });
        return { lat, lon };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Active 10-8 calls with coordinates for the dispatch map (geocoded when needed). */
export async function listTen8MapIncidents(agencyId: number): Promise<Ten8MapIncident[]> {
  const rows = await listTen8ActiveIncidents(agencyId);
  const out: Ten8MapIncident[] = [];

  for (const row of rows) {
    let coords = coordsFromPayload(row.payload);
    if (!coords && row.location?.trim()) {
      coords = await geocodeAddress(agencyId, row.location);
    }
    if (!coords) {
      continue;
    }
    out.push({
      call_id: row.call_id,
      label: callLabel(row.incident_type, row.call_id),
      incident_type: row.incident_type,
      location: row.location,
      lat: coords.lat,
      lon: coords.lon,
    });
  }
  return out;
}
