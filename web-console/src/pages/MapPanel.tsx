import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";

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

function radioIcon(): L.DivIcon {
  return L.divIcon({
    className: "radio-marker",
    html: '<span class="radio-dot"></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

export function MapPanel() {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const fittedRef = useRef(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
        const res = await api.locations();
        const map = mapRef.current;
        if (cancelled || !map) {
          return;
        }
        setError(null);
        setCount(res.positions.length);
        const seen = new Set<string>();
        for (const p of res.positions) {
          seen.add(p.unit_id);
          const latlng: L.LatLngExpression = [p.lat, p.lon];
          const label = p.display_name || p.unit_id;
          const popup =
            `<b>${escapeHtml(label)}</b><br/>` +
            `Channel: ${escapeHtml(p.channel_name ?? "—")}<br/>` +
            `Unit: ${escapeHtml(p.unit_id)}<br/>` +
            `Updated ${escapeHtml(ageText(p.updated_at))}`;
          let marker = markersRef.current.get(p.unit_id);
          if (!marker) {
            marker = L.marker(latlng, { icon: radioIcon() }).addTo(map);
            markersRef.current.set(p.unit_id, marker);
          } else {
            marker.setLatLng(latlng);
          }
          marker.bindPopup(popup);
        }
        for (const [unit, marker] of markersRef.current) {
          if (!seen.has(unit)) {
            marker.remove();
            markersRef.current.delete(unit);
          }
        }
        if (!fittedRef.current && markersRef.current.size > 0) {
          fittedRef.current = true;
          map.fitBounds(L.featureGroup([...markersRef.current.values()]).getBounds().pad(0.3));
        }
      } catch {
        if (!cancelled) {
          setError("Could not load radio positions.");
        }
      }
    }
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="map-panel">
      <div className="map-head">
        <h3>Radio Map</h3>
        <span className="count">{count} reporting</span>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div ref={mapElRef} className="map-canvas" />
    </div>
  );
}
