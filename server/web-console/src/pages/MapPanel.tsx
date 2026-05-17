import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api";
import { useUnitAliasResolver } from "../unitAliases";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";
const POLL_MS = 5000;
/** A radio that has not reported within this window is shown faded. */
const STALE_MS = 5 * 60_000;

type MarkerState = "live" | "stale" | "emergency";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function ageText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) {
    return "just now";
  }
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return `${Math.floor(minutes / 60)} h ago`;
}

function isStale(iso: string): boolean {
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms > STALE_MS;
}

/** Marker icon: a dot tinted by state, with an optional heading arrow. */
function radioDivIcon(state: MarkerState, heading: number | null): L.DivIcon {
  const arrow =
    heading == null
      ? ""
      : `<i class="radio-heading" style="transform:rotate(${Math.round(heading)}deg)"></i>`;
  return L.divIcon({
    className: "radio-marker",
    html: `<span class="radio-pin ${state}">${arrow}<i class="radio-dot"></i></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -13],
  });
}

export function MapPanel() {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; iconKey: string }>>(new Map());
  const fittedRef = useRef(false);
  const [stats, setStats] = useState({ total: 0, emergency: 0 });
  const [error, setError] = useState<string | null>(null);

  // The poll effect runs once; a ref keeps it reading the latest alias resolver.
  const aliasFor = useUnitAliasResolver();
  const aliasRef = useRef(aliasFor);
  aliasRef.current = aliasFor;

  useEffect(() => {
    if (!mapElRef.current || mapRef.current) {
      return;
    }
    const map = L.map(mapElRef.current).setView([39.5, -98.35], 4);
    L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    mapRef.current = map;
    const resize = window.setTimeout(() => map.invalidateSize(), 200);
    const markers = markersRef.current;
    return () => {
      window.clearTimeout(resize);
      map.remove();
      mapRef.current = null;
      markers.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        // Positions and alerts together, so a unit in emergency is flagged on the map.
        const [locs, alertList] = await Promise.all([api.locations(), api.alerts()]);
        const map = mapRef.current;
        if (cancelled || !map) {
          return;
        }
        setError(null);

        const emergencyUnits = new Set(
          alertList.alerts
            .filter((a) => a.kind === "emergency" && a.active && a.from_unit)
            .map((a) => String(a.from_unit).toUpperCase()),
        );

        const seen = new Set<string>();
        let emergencyCount = 0;
        for (const p of locs.positions) {
          seen.add(p.unit_id);
          const inEmergency = emergencyUnits.has(p.unit_id.toUpperCase());
          const state: MarkerState = inEmergency ? "emergency" : isStale(p.updated_at) ? "stale" : "live";
          if (inEmergency) {
            emergencyCount++;
          }
          const heading =
            typeof p.heading === "number" && Number.isFinite(p.heading) ? p.heading : null;
          const latlng: L.LatLngExpression = [p.lat, p.lon];
          const label = p.display_name || aliasRef.current(p.unit_id);
          const speed =
            typeof p.speed_mps === "number" && p.speed_mps > 0.5
              ? `${Math.round(p.speed_mps * 2.237)} mph`
              : null;
          const popup =
            (inEmergency ? `<b class="popup-emg">EMERGENCY</b><br/>` : "") +
            `<b>${escapeHtml(label)}</b><br/>` +
            `Channel: ${escapeHtml(p.channel_name ?? "—")}<br/>` +
            `Unit: ${escapeHtml(aliasRef.current(p.unit_id))}<br/>` +
            (speed ? `Speed: ${escapeHtml(speed)}<br/>` : "") +
            (typeof p.accuracy_m === "number" ? `Accuracy: &plusmn;${Math.round(p.accuracy_m)} m<br/>` : "") +
            `Updated ${escapeHtml(ageText(p.updated_at))}`;

          const iconKey = `${state}:${heading == null ? "x" : Math.round(heading / 15)}`;
          let entry = markersRef.current.get(p.unit_id);
          if (!entry) {
            const marker = L.marker(latlng, {
              icon: radioDivIcon(state, heading),
              zIndexOffset: inEmergency ? 1000 : 0,
            }).addTo(map);
            entry = { marker, iconKey };
            markersRef.current.set(p.unit_id, entry);
          } else {
            entry.marker.setLatLng(latlng);
            if (entry.iconKey !== iconKey) {
              entry.marker.setIcon(radioDivIcon(state, heading));
              entry.marker.setZIndexOffset(inEmergency ? 1000 : 0);
              entry.iconKey = iconKey;
            }
          }
          entry.marker.bindPopup(popup);
        }
        for (const [unit, entry] of markersRef.current) {
          if (!seen.has(unit)) {
            entry.marker.remove();
            markersRef.current.delete(unit);
          }
        }
        setStats({ total: locs.positions.length, emergency: emergencyCount });
        if (!fittedRef.current && markersRef.current.size > 0) {
          fittedRef.current = true;
          map.fitBounds(
            L.featureGroup([...markersRef.current.values()].map((e) => e.marker))
              .getBounds()
              .pad(0.3),
          );
        }
      } catch {
        if (!cancelled) {
          setError("Could not load radio positions.");
        }
      }
    }
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="map-panel">
      <div className="map-head">
        <h3>Radio Map</h3>
        <span className="count">
          {stats.total} reporting
          {stats.emergency > 0 && (
            <span className="count-emg"> · {stats.emergency} emergency</span>
          )}
        </span>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div ref={mapElRef} className="map-canvas" />
    </div>
  );
}
