import { geocodeAddressForAgency, parseTen8CoordinateString } from "./geocode.js";
import { listTen8ActiveIncidents } from "./store.js";

export type Ten8MapIncident = {
  call_id: string;
  label: string;
  incident_type: string | null;
  location: string | null;
  lat: number;
  lon: number;
};

/**
 * Short pin label for the dispatch map.
 *
 * Exported (rather than file-local) so the labeling contract can be pinned
 * in unit tests — every active 10-8 call rendered on the dispatch map runs
 * through this helper, and a regression silently changes what every pin
 * reads on every console.
 */
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

/**
 * Pull a lat/lon pair out of a raw 10-8 incident payload (multiple shapes).
 *
 * Exported (rather than file-local) so the field-name allow-list and
 * coordinate-validity bounds can be pinned in unit tests — this helper
 * decides whether a CAD call shows up on the dispatch map at all, and
 * an out-of-range coordinate would place the pin in the middle of the
 * ocean (or skip the call from the map entirely).
 */
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

  for (const key of ["coordinates", "latlng", "latLng"] as const) {
    const parsed = parseTen8CoordinateString(incident[key]);
    if (parsed) {
      return parsed;
    }
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
      coords = await geocodeAddressForAgency(agencyId, row.location);
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
