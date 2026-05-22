import { getAgencyIntegrationValue, listPositions, type RadioPosition } from "../store.js";

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
import { prepareLocationForTts } from "./speech/locationSpeech.js";

const NOMINATIM_USER_AGENT = "SafeT-PTT-AI-Dispatch/1.0 (radio unit location lookup)";
const POSITION_MAX_AGE_MS = 10 * 60 * 1000;

type NominatimAddress = Record<string, string | undefined>;

type NominatimReverse = {
  display_name?: string;
  name?: string;
  address?: NominatimAddress;
};

export type UnitLocationSubject = {
  targetUnit: string;
  wantFullAddress: boolean;
};

/** Parse info_request.subject for unit 10-20: "2009", "unit 2009 full address", etc. */
export function parseUnitLocationSubject(subject: string | null): UnitLocationSubject | null {
  if (!subject?.trim()) {
    return null;
  }
  let raw = subject.trim();
  const wantFullAddress = /\bfull\s+(street\s+)?address\b/i.test(raw) || /\bstreet\s+address\b/i.test(raw);
  raw = raw
    .replace(/\bfull\s+(street\s+)?address\b/gi, "")
    .replace(/\bstreet\s+address\b/gi, "")
    .replace(/\b10[- ]?20\b/gi, "")
    .replace(/\blocation\b/gi, "")
    .replace(/\bwhere\s+(is|are)\b/gi, "")
    .trim();

  const unitMatch = raw.match(/(?:unit\s+)?(\d{3,5}|27-\d{3,5})/i);
  const targetUnit = (unitMatch?.[1] ?? raw).trim();
  if (!targetUnit || targetUnit.length < 2) {
    return null;
  }
  return { targetUnit, wantFullAddress };
}

function normalizeUnitKey(unitId: string): string {
  return unitId.trim().toLowerCase().replace(/^27-/, "").replace(/^0+/, "") || "0";
}

export function findRadioMapPosition(
  positions: RadioPosition[],
  targetUnit: string,
): RadioPosition | null {
  const want = normalizeUnitKey(targetUnit);
  for (const p of positions) {
    if (normalizeUnitKey(p.unit_id) === want) {
      return p;
    }
  }
  for (const p of positions) {
    const id = normalizeUnitKey(p.unit_id);
    if (id.endsWith(want) || want.endsWith(id)) {
      return p;
    }
  }
  return null;
}

function positionIsFresh(updatedAt: string): boolean {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) {
    return false;
  }
  return Date.now() - t <= POSITION_MAX_AGE_MS;
}

async function getGoogleGeocodingKey(agencyId: number): Promise<string | null> {
  const fromAgency = (await getAgencyIntegrationValue(agencyId, "google_maps_geocoding_api_key"))?.trim();
  if (fromAgency) {
    return fromAgency;
  }
  const fromEnv = process.env.GOOGLE_MAPS_GEOCODING_API_KEY?.trim();
  return fromEnv || null;
}

async function reverseGeocodeGoogle(
  lat: number,
  lon: number,
  apiKey: string,
): Promise<{ natural: string; full: string } | null> {
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lon}`);
    url.searchParams.set("key", apiKey);
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      return null;
    }
    const data = (await r.json()) as {
      status?: string;
      results?: Array<{
        formatted_address?: string;
        types?: string[];
        address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
      }>;
    };
    if (data.status !== "OK" || !data.results?.length) {
      return null;
    }
    const hit = data.results[0]!;
    const full = (hit.formatted_address ?? "").trim();
    const types = hit.types ?? [];
    const comps = hit.address_components ?? [];

    const establishment = comps.find((c) => c.types.includes("establishment") || c.types.includes("point_of_interest"));
    const route = comps.find((c) => c.types.includes("route"));
    const locality =
      comps.find((c) => c.types.includes("locality")) ??
      comps.find((c) => c.types.includes("sublocality"));
    const admin2 = comps.find((c) => c.types.includes("administrative_area_level_2"));

    if (types.includes("intersection") && route) {
      const parts = full.split(",").map((s) => s.trim());
      const roads = parts.filter((p) => /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane)\b/i.test(p));
      if (roads.length >= 2) {
        return { natural: `near ${roads[0]} and ${roads[1]}`, full };
      }
    }

    if (establishment) {
      const place = establishment.long_name;
      const city = locality?.long_name ?? admin2?.long_name ?? "";
      const near = route?.long_name;
      const natural = near && city
        ? `in the ${place} in ${city} by ${near}`
        : city
          ? `in the ${place} in ${city}`
          : `at ${place}`;
      return { natural, full };
    }

    if (route && locality) {
      return { natural: `near ${route.long_name} in ${locality.long_name}`, full };
    }

    return full ? { natural: shortenForRadio(full), full } : null;
  } catch {
    return null;
  }
}

async function reverseGeocodeNominatim(lat: number, lon: number): Promise<{ natural: string; full: string } | null> {
  try {
    const url = new URL(NOMINATIM_REVERSE);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return null;
    }
    const data = (await r.json()) as NominatimReverse;
    return formatNominatimResult(data);
  } catch {
    return null;
  }
}

/** Second pass at lower zoom to guess a cross street when no POI name. */
async function reverseGeocodeNominatimCrossHint(
  lat: number,
  lon: number,
  primaryRoad: string | null,
): Promise<string | null> {
  if (!primaryRoad) {
    return null;
  }
  try {
    const url = new URL(NOMINATIM_REVERSE);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "16");

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      return null;
    }
    const data = (await r.json()) as NominatimReverse;
    const road =
      data.address?.road ??
      data.address?.street ??
      data.address?.pedestrian ??
      data.address?.footway;
    if (road && road.toLowerCase() !== primaryRoad.toLowerCase()) {
      return road;
    }
    return null;
  } catch {
    return null;
  }
}

function pickPoiName(addr: NominatimAddress, data: NominatimReverse): string | null {
  const candidates = [
    data.name,
    addr.amenity,
    addr.shop,
    addr.retail,
    addr.brand,
    addr.building,
    addr.office,
    addr.leisure,
    addr.tourism,
    addr.historic,
  ];
  for (const c of candidates) {
    const s = c?.trim();
    if (s && !/^yes$/i.test(s) && s.length > 2) {
      return s;
    }
  }
  return null;
}

function formatNominatimResult(data: NominatimReverse): { natural: string; full: string } | null {
  const addr = data.address ?? {};
  const poi = pickPoiName(addr, data);
  const road = addr.road ?? addr.street ?? addr.pedestrian ?? addr.footway ?? addr.cycleway;
  const house = addr.house_number;
  const city = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county;
  const suburb = addr.suburb ?? addr.neighbourhood ?? addr.quarter;

  const fullParts = [house, road, suburb, city, addr.state].filter(Boolean);
  const full = fullParts.join(", ").replace(/\s+/g, " ").trim();

  const display = (data.display_name ?? "").trim();
  const andInDisplay = display.match(/([^,]+)\s+and\s+([^,]+)/i);
  if (andInDisplay && !poi) {
    const a = andInDisplay[1]!.trim();
    const b = andInDisplay[2]!.trim();
    if (a.length < 80 && b.length < 80) {
      return { natural: `near ${a} and ${b}`, full: full || display };
    }
  }

  if (poi) {
    const cityPart = city ? ` in ${city}` : "";
    const nearPart = road && !display.toLowerCase().includes(road.toLowerCase()) ? ` by ${road}` : "";
    const suburbPart = suburb && !cityPart.includes(suburb) ? ` in ${suburb}` : "";
    return {
      natural: `in the ${poi}${suburbPart}${cityPart}${nearPart}`.replace(/\s+/g, " ").trim(),
      full: full || display,
    };
  }

  if (road && city) {
    return { natural: `near ${road} in ${city}`, full: full || display };
  }

  if (display) {
    return { natural: shortenForRadio(display), full: full || display };
  }

  return full ? { natural: full, full } : null;
}

function shortenForRadio(text: string): string {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^USA$/i.test(p) && !/^\d{5}/.test(p));
  return parts.slice(0, 3).join(", ");
}

export async function describeUnitMapLocation(
  agencyId: number,
  lat: number,
  lon: number,
  wantFullAddress: boolean,
): Promise<{ natural: string; full: string } | null> {
  const googleKey = await getGoogleGeocodingKey(agencyId);
  let geo: { natural: string; full: string } | null = null;

  if (googleKey) {
    geo = await reverseGeocodeGoogle(lat, lon, googleKey);
  }
  if (!geo) {
    geo = await reverseGeocodeNominatim(lat, lon);
  }
  if (!geo) {
    return null;
  }

  if (!wantFullAddress && geo.natural && !/^\s*in the /i.test(geo.natural) && !/\sand\s/i.test(geo.natural)) {
    const primaryRoad = geo.natural.match(/^near\s+(.+?)\s+in\b/i)?.[1]?.trim() ?? null;
    const cross = await reverseGeocodeNominatimCrossHint(lat, lon, primaryRoad);
    if (cross && primaryRoad) {
      geo = { ...geo, natural: `near ${primaryRoad} and ${cross}` };
    }
  }

  return geo;
}

export async function buildUnitLocationResponse(
  agencyId: number,
  subject: UnitLocationSubject,
  requestingUnit: string | null | undefined,
): Promise<string> {
  const csPart = requestingUnit
    ? `${/^27-0[0-3]0$/.test(requestingUnit) ? requestingUnit : requestingUnit.replace(/^27-/, "")}, `
    : "";

  const positions = await listPositions(agencyId);
  const pos = findRadioMapPosition(positions, subject.targetUnit);
  if (!pos) {
    const unitSpoken = subject.targetUnit.replace(/^27-/, "");
    return `${csPart}negative, unit ${unitSpoken} is not showing on the radio map.`;
  }
  if (!positionIsFresh(pos.updated_at)) {
    const unitSpoken = subject.targetUnit.replace(/^27-/, "");
    return `${csPart}negative, unit ${unitSpoken} has no recent GPS on the map.`;
  }

  const geo = await describeUnitMapLocation(
    agencyId,
    pos.lat,
    pos.lon,
    subject.wantFullAddress,
  );
  const unitSpoken = pos.unit_id.replace(/^27-/, "");
  if (!geo) {
    return `${csPart}unit ${unitSpoken} is on the map but I can't resolve an address for that spot.`;
  }

  if (subject.wantFullAddress) {
    return `${csPart}on the map unit ${unitSpoken} full address is ${prepareLocationForTts(geo.full)}.`;
  }

  const natural = prepareLocationForTts(geo.natural);
  return `${csPart}on the map it looks like unit ${unitSpoken} is ${natural}.`;
}
