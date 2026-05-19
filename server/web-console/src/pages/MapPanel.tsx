import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, describeError, deviceTypeLabel, type Geofence, type PositionSample } from "../api";
import { useAuth } from "../auth";
import { useUnitAliasResolver } from "../unitAliases";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";
const ESRI_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION = "Imagery &copy; Esri";
const POLL_MS = 5000;
/** A radio that has not reported within this window is shown faded. */
const STALE_MS = 5 * 60_000;
/** Zoom level the map flies to when a radio goes into emergency. */
const EMERGENCY_ZOOM = 16;
/** Default radius (metres) for a freshly dropped circle geofence. */
const DEFAULT_GEOFENCE_RADIUS = 250;
const GEOFENCE_DEFAULT_COLOR = "#22c5e5";
/** Route the pop-out window loads — a standalone full-window map. */
const MAP_WINDOW_PATH = "/console/map";

type MarkerState = "live" | "stale" | "emergency";
type DrawMode = "view" | "place";
type DrawShape = "circle" | "polygon";
type BaseLayer = "street" | "satellite";

type CircleDraft = { shape: "circle"; lat: number; lon: number; radiusM: number };
type PolygonDraft = { shape: "polygon"; points: [number, number][] };
type GeofenceDraft = CircleDraft | PolygonDraft;

/** Inner SVG markup for a handheld-radio marker glyph. */
const RADIO_GLYPH =
  '<rect x="7" y="8" width="10" height="13" rx="1.6"/>' +
  '<path d="M13.5 8 16.5 3"/>' +
  '<line x1="9.5" y1="11.5" x2="14.5" y2="11.5"/>' +
  '<circle cx="12" cy="16.5" r="1.6"/>';

/** Inner SVG markup for an in-car (police cruiser) marker glyph. */
const CAR_GLYPH =
  '<path d="M2.8 15.2 L2.8 13 L5.5 13 L8 8.7 L15 8.7 L17.6 13 L21.2 13.4 L21.2 15.2 Z"/>' +
  '<line x1="2.8" y1="13" x2="21.2" y2="13"/>' +
  '<line x1="10.8" y1="8.7" x2="10.8" y2="13"/>' +
  '<rect x="8.8" y="6.9" width="4.6" height="1.9" rx="0.5"/>' +
  '<circle cx="7.5" cy="15.4" r="2"/>' +
  '<circle cx="16.6" cy="15.4" r="2"/>';

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

/** A unit that reports as an in-car radio gets the cruiser glyph; everything else, a handheld. */
function glyphFor(deviceType: string | null): string {
  return deviceType === "unit_radio" ? CAR_GLYPH : RADIO_GLYPH;
}

/** Marker icon: a device glyph tinted by state, a heading arrow, and the unit's label. */
function radioDivIcon(
  state: MarkerState,
  deviceType: string | null,
  heading: number | null,
  label: string,
): L.DivIcon {
  const arrow =
    heading == null
      ? ""
      : `<i class="rm-heading" style="transform:rotate(${Math.round(heading)}deg)"></i>`;
  return L.divIcon({
    className: "radio-marker",
    html:
      `<div class="rm">` +
      `<div class="rm-pin ${state}">${arrow}` +
      `<svg class="rm-glyph" viewBox="0 0 24 24">${glyphFor(deviceType)}</svg>` +
      `</div>` +
      `<div class="rm-label">${escapeHtml(label)}</div>` +
      `</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -17],
  });
}

/** Formats a local datetime-input value (yyyy-MM-ddThh:mm) for a Date. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Hover label for one GPS-track sample. */
function trackTip(sample: PositionSample): string {
  const time = new Date(sample.recorded_at).toLocaleString([], {
    dateStyle: "short",
    timeStyle: "medium",
  });
  const speed =
    typeof sample.speed_mps === "number" && sample.speed_mps > 0.5
      ? ` · ${Math.round(sample.speed_mps * 2.237)} mph`
      : "";
  return escapeHtml(time + speed);
}

const tuple = (p: [number, number]): L.LatLngTuple => [p[0], p[1]];

interface UnitOption {
  unitId: string;
  label: string;
}

interface MapViewProps {
  /** "embedded" runs inside the console column; "window" fills a pop-out window. */
  variant?: "embedded" | "window";
  onPopOut?: () => void;
}

/** The live radio map — markers, geofence overlays, and GPS-log search. */
export function MapView({ variant = "embedded", onPopOut }: MapViewProps) {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "dispatcher";

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: L.Marker; iconKey: string }>>(new Map());
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const geoLayerRef = useRef<L.LayerGroup | null>(null);
  const trackLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  // Units already auto-zoomed to, so a standing emergency only pulls the map once.
  const emergencyZoomedRef = useRef<Set<string>>(new Set());

  const [stats, setStats] = useState({ total: 0, emergency: 0 });
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>("street");
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);

  // Geofences
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [geoPanelOpen, setGeoPanelOpen] = useState(false);
  const [mode, setMode] = useState<DrawMode>("view");
  const [drawShape, setDrawShape] = useState<DrawShape>("circle");
  const [polyPoints, setPolyPoints] = useState<[number, number][]>([]);
  const [draft, setDraft] = useState<GeofenceDraft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(GEOFENCE_DEFAULT_COLOR);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // GPS log search
  const [gpsPanelOpen, setGpsPanelOpen] = useState(false);
  const [trackUnit, setTrackUnit] = useState("");
  const [trackFrom, setTrackFrom] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 3600 * 1000)),
  );
  const [trackTo, setTrackTo] = useState(() => toLocalInput(new Date()));
  const [track, setTrack] = useState<PositionSample[] | null>(null);
  const [trackStatus, setTrackStatus] = useState<string | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);

  // The poll effect runs once; refs keep it reading the latest values.
  const aliasFor = useUnitAliasResolver();
  const aliasRef = useRef(aliasFor);
  aliasRef.current = aliasFor;
  const modeRef = useRef<DrawMode>(mode);
  modeRef.current = mode;
  const drawShapeRef = useRef<DrawShape>(drawShape);
  drawShapeRef.current = drawShape;

  const refreshGeofences = useCallback(() => {
    api
      .geofences()
      .then((res) => setGeofences(res.geofences))
      .catch(() => undefined);
  }, []);

  // --- map bootstrap -----------------------------------------------------
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) {
      return;
    }
    const map = L.map(mapElRef.current).setView([39.5, -98.35], 4);
    mapRef.current = map;
    // A click while drawing builds the geofence shape.
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== "place") {
        return;
      }
      const point: [number, number] = [e.latlng.lat, e.latlng.lng];
      if (drawShapeRef.current === "circle") {
        setDraft({ shape: "circle", lat: point[0], lon: point[1], radiusM: DEFAULT_GEOFENCE_RADIUS });
        setMode("view");
      } else {
        setPolyPoints((prev) => [...prev, point]);
      }
    });
    const resize = window.setTimeout(() => map.invalidateSize(), 200);
    const markers = markersRef.current;
    return () => {
      window.clearTimeout(resize);
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      geoLayerRef.current = null;
      trackLayerRef.current = null;
      draftLayerRef.current = null;
      markers.clear();
    };
  }, []);

  useEffect(() => {
    refreshGeofences();
  }, [refreshGeofences]);

  // --- base tile layer ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    baseLayerRef.current?.remove();
    const cfg =
      baseLayer === "satellite"
        ? { url: ESRI_TILE_URL, attribution: ESRI_ATTRIBUTION }
        : { url: OSM_TILE_URL, attribution: OSM_ATTRIBUTION };
    const layer = L.tileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution });
    layer.addTo(map);
    layer.bringToBack();
    baseLayerRef.current = layer;
  }, [baseLayer]);

  // The map needs a size recheck whenever the surrounding layout changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const timer = window.setTimeout(() => map.invalidateSize(), 240);
    return () => window.clearTimeout(timer);
  }, [expanded, geoPanelOpen, gpsPanelOpen]);

  // --- geofence overlays -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const layer = geoLayerRef.current ?? L.layerGroup().addTo(map);
    geoLayerRef.current = layer;
    layer.clearLayers();
    for (const fence of geofences) {
      const color = fence.color ?? GEOFENCE_DEFAULT_COLOR;
      const style = { color, fillColor: color, fillOpacity: 0.1, weight: 2 };
      let shape: L.Path | null = null;
      if (fence.shape === "polygon" && fence.points && fence.points.length >= 3) {
        shape = L.polygon(fence.points.map(tuple), style);
      } else if (fence.center_lat != null && fence.center_lon != null && fence.radius_m != null) {
        shape = L.circle([fence.center_lat, fence.center_lon], { ...style, radius: fence.radius_m });
      }
      if (shape) {
        shape.bindTooltip(escapeHtml(fence.name), { direction: "top", sticky: true }).addTo(layer);
      }
    }
  }, [geofences]);

  // The dashed preview of the geofence being drawn (in-progress or completed).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const layer = draftLayerRef.current ?? L.layerGroup().addTo(map);
    draftLayerRef.current = layer;
    layer.clearLayers();
    const style = {
      color: draftColor,
      fillColor: draftColor,
      fillOpacity: 0.12,
      weight: 2,
      dashArray: "5 5",
    };
    if (polyPoints.length > 0) {
      const latlngs = polyPoints.map(tuple);
      (latlngs.length >= 3 ? L.polygon(latlngs, style) : L.polyline(latlngs, style)).addTo(layer);
      for (const ll of latlngs) {
        L.circleMarker(ll, {
          radius: 4,
          color: draftColor,
          fillColor: "#ffffff",
          fillOpacity: 1,
          weight: 2,
        }).addTo(layer);
      }
      return;
    }
    if (!draft) {
      return;
    }
    if (draft.shape === "circle") {
      L.circle([draft.lat, draft.lon], { ...style, radius: draft.radiusM }).addTo(layer);
    } else {
      L.polygon(draft.points.map(tuple), style).addTo(layer);
    }
  }, [draft, draftColor, polyPoints]);

  // --- GPS track overlay -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const layer = trackLayerRef.current ?? L.layerGroup().addTo(map);
    trackLayerRef.current = layer;
    layer.clearLayers();
    if (!track || track.length === 0) {
      return;
    }
    const points = track.map((s) => [s.lat, s.lon] as L.LatLngTuple);
    L.polyline(points, { color: "#2563eb", weight: 3, opacity: 0.85 }).addTo(layer);
    // Decimate the per-fix dots so a long track stays light to render.
    const step = Math.max(1, Math.floor(track.length / 180));
    track.forEach((sample, index) => {
      if (index % step !== 0) {
        return;
      }
      L.circleMarker([sample.lat, sample.lon], {
        radius: 3,
        color: "#2563eb",
        fillColor: "#ffffff",
        fillOpacity: 1,
        weight: 1.5,
      })
        .bindTooltip(trackTip(sample), { direction: "top" })
        .addTo(layer);
    });
    L.circleMarker(points[0], {
      radius: 6,
      color: "#16a34a",
      fillColor: "#16a34a",
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindTooltip("Track start", { direction: "top" })
      .addTo(layer);
    L.circleMarker(points[points.length - 1], {
      radius: 6,
      color: "#ef4444",
      fillColor: "#ef4444",
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindTooltip("Track end", { direction: "top" })
      .addTo(layer);
    map.fitBounds(L.latLngBounds(points).pad(0.25));
  }, [track]);

  // --- live position polling --------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        // Positions drive the map; alerts only tint markers, so a failed
        // alerts fetch must not stop position updates.
        const [locsResult, alertsResult] = await Promise.allSettled([api.locations(), api.alerts()]);
        const map = mapRef.current;
        if (cancelled || !map) {
          return;
        }
        if (locsResult.status !== "fulfilled") {
          setError("Could not load radio positions.");
          return;
        }
        setError(null);
        const locs = locsResult.value;

        const emergencyUnits = new Set(
          alertsResult.status === "fulfilled"
            ? alertsResult.value.alerts
                .filter((a) => a.kind === "emergency" && a.active && a.from_unit)
                .map((a) => String(a.from_unit).toUpperCase())
            : [],
        );

        const seen = new Set<string>();
        let emergencyCount = 0;
        let flewToEmergency = false;
        for (const p of locs.positions) {
          seen.add(p.unit_id);
          const inEmergency = emergencyUnits.has(p.unit_id.toUpperCase());
          const state: MarkerState = inEmergency
            ? "emergency"
            : isStale(p.updated_at)
              ? "stale"
              : "live";
          if (inEmergency) {
            emergencyCount++;
          }
          const heading =
            typeof p.heading === "number" && Number.isFinite(p.heading) ? p.heading : null;
          const latlng: L.LatLngExpression = [p.lat, p.lon];
          // Pull the map to a radio the moment it goes into emergency.
          if (inEmergency && !emergencyZoomedRef.current.has(p.unit_id) && !flewToEmergency) {
            emergencyZoomedRef.current.add(p.unit_id);
            flewToEmergency = true;
            map.flyTo(latlng, Math.max(map.getZoom(), EMERGENCY_ZOOM));
          }
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
            (p.device_type
              ? `Device: ${escapeHtml(deviceTypeLabel(p.device_type))}<br/>`
              : "") +
            (speed ? `Speed: ${escapeHtml(speed)}<br/>` : "") +
            (typeof p.accuracy_m === "number"
              ? `Accuracy: &plusmn;${Math.round(p.accuracy_m)} m<br/>`
              : "") +
            `Updated ${escapeHtml(ageText(p.updated_at))}`;

          const iconKey = `${state}:${p.device_type ?? "x"}:${
            heading == null ? "x" : Math.round(heading / 15)
          }:${label}`;
          let entry = markersRef.current.get(p.unit_id);
          if (!entry) {
            const marker = L.marker(latlng, {
              icon: radioDivIcon(state, p.device_type, heading, label),
              zIndexOffset: inEmergency ? 1000 : 0,
            }).addTo(map);
            entry = { marker, iconKey };
            markersRef.current.set(p.unit_id, entry);
          } else {
            entry.marker.setLatLng(latlng);
            if (entry.iconKey !== iconKey) {
              entry.marker.setIcon(radioDivIcon(state, p.device_type, heading, label));
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
        // Forget emergencies that have cleared, so a later re-trigger zooms again.
        for (const unit of [...emergencyZoomedRef.current]) {
          if (!emergencyUnits.has(unit.toUpperCase())) {
            emergencyZoomedRef.current.delete(unit);
          }
        }
        setStats({ total: locs.positions.length, emergency: emergencyCount });
        setUnitOptions(
          locs.positions
            .map((p) => ({ unitId: p.unit_id, label: p.display_name || aliasRef.current(p.unit_id) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
        if (!fittedRef.current && !flewToEmergency && !track && markersRef.current.size > 0) {
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
  }, [track]);

  // --- geofence actions --------------------------------------------------
  function startDrawing(shape: DrawShape) {
    setGeoPanelOpen(true);
    setGeoError(null);
    setDraft(null);
    setPolyPoints([]);
    setDraftName("");
    setDraftColor(GEOFENCE_DEFAULT_COLOR);
    setDrawShape(shape);
    setMode("place");
  }

  function cancelDraft() {
    setDraft(null);
    setPolyPoints([]);
    setMode("view");
    setGeoError(null);
  }

  function undoPoint() {
    setPolyPoints((prev) => prev.slice(0, -1));
  }

  function finishPolygon() {
    if (polyPoints.length < 3) {
      return;
    }
    setDraft({ shape: "polygon", points: polyPoints });
    setPolyPoints([]);
    setMode("view");
  }

  async function saveGeofence() {
    if (!draft) {
      return;
    }
    const name = draftName.trim();
    if (!name) {
      setGeoError("Name the geofence first.");
      return;
    }
    setGeoBusy(true);
    setGeoError(null);
    try {
      if (draft.shape === "circle") {
        await api.createGeofence({
          shape: "circle",
          name,
          centerLat: draft.lat,
          centerLon: draft.lon,
          radiusM: Math.round(draft.radiusM),
          color: draftColor,
        });
      } else {
        await api.createGeofence({
          shape: "polygon",
          name,
          points: draft.points,
          color: draftColor,
        });
      }
      setDraft(null);
      setDraftName("");
      refreshGeofences();
    } catch (err) {
      setGeoError(describeError(err));
    } finally {
      setGeoBusy(false);
    }
  }

  async function removeGeofence(id: number) {
    try {
      await api.deleteGeofence(id);
      refreshGeofences();
    } catch (err) {
      setGeoError(describeError(err));
    }
  }

  function focusGeofence(fence: Geofence) {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (fence.shape === "polygon" && fence.points && fence.points.length >= 3) {
      map.fitBounds(L.latLngBounds(fence.points.map(tuple)).pad(0.3));
    } else if (fence.center_lat != null && fence.center_lon != null) {
      map.flyTo([fence.center_lat, fence.center_lon], 14);
    }
  }

  // --- GPS log actions ---------------------------------------------------
  async function showTrack() {
    const unit = trackUnit.trim();
    if (!unit) {
      setTrackStatus("Pick a radio to trace.");
      return;
    }
    setTrackBusy(true);
    setTrackStatus("Loading GPS log…");
    try {
      const fromIso = trackFrom ? new Date(trackFrom).toISOString() : undefined;
      const toIso = trackTo ? new Date(trackTo).toISOString() : undefined;
      const res = await api.locationHistory(unit, fromIso, toIso);
      if (res.samples.length === 0) {
        setTrack(null);
        setTrackStatus("No GPS log for that radio in this range.");
      } else {
        setTrack(res.samples);
        setTrackStatus(`${res.samples.length} fixes plotted for ${unit}.`);
      }
    } catch (err) {
      setTrack(null);
      setTrackStatus(describeError(err));
    } finally {
      setTrackBusy(false);
    }
  }

  function clearTrack() {
    setTrack(null);
    setTrackStatus(null);
  }

  const rootClass =
    variant === "window"
      ? "map-panel windowed"
      : expanded
        ? "map-panel expanded"
        : "map-panel";

  return (
    <div className={rootClass}>
      <div className="map-head">
        <h3>Radio Map</h3>
        <span className="count">
          {stats.total} reporting
          {stats.emergency > 0 && <span className="count-emg"> · {stats.emergency} emergency</span>}
        </span>
        <div className="map-tools">
          <div className="map-layer-toggle">
            <button
              className={baseLayer === "street" ? "active" : ""}
              onClick={() => setBaseLayer("street")}
            >
              Street
            </button>
            <button
              className={baseLayer === "satellite" ? "active" : ""}
              onClick={() => setBaseLayer("satellite")}
            >
              Satellite
            </button>
          </div>
          <button
            className={geoPanelOpen ? "btn sm active" : "btn sm"}
            onClick={() => setGeoPanelOpen((v) => !v)}
          >
            Geofences
          </button>
          <button
            className={gpsPanelOpen ? "btn sm active" : "btn sm"}
            onClick={() => setGpsPanelOpen((v) => !v)}
          >
            GPS log
          </button>
          {variant === "embedded" && onPopOut && (
            <button className="btn sm" onClick={onPopOut}>
              Pop out
            </button>
          )}
          {variant === "embedded" && (
            <button className="btn sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {mode === "place" && (
        <div className="banner info map-draw-hint">
          <span>
            {drawShape === "circle"
              ? "Click the map to drop the geofence centre."
              : "Click the map to add polygon corners — three or more."}
          </span>
          <button className="btn sm" onClick={cancelDraft}>
            Cancel
          </button>
        </div>
      )}

      {geoPanelOpen && (
        <div className="map-tool-panel">
          <div className="map-tool-head">
            <strong>Geofence overlays</strong>
            {canEdit && mode === "view" && !draft && (
              <div className="geofence-add">
                <button className="btn sm" onClick={() => startDrawing("circle")}>
                  + Circle
                </button>
                <button className="btn sm" onClick={() => startDrawing("polygon")}>
                  + Polygon
                </button>
              </div>
            )}
          </div>
          {geoError && <div className="banner error">{geoError}</div>}

          {mode === "place" && drawShape === "polygon" && (
            <div className="geofence-poly">
              <span>
                {polyPoints.length} point{polyPoints.length === 1 ? "" : "s"} placed
              </span>
              <button className="btn sm" onClick={undoPoint} disabled={polyPoints.length === 0}>
                Undo point
              </button>
              <button
                className="btn sm primary"
                onClick={finishPolygon}
                disabled={polyPoints.length < 3}
              >
                Finish shape
              </button>
            </div>
          )}

          {draft && (
            <div className="geofence-draft">
              <label>
                Name
                <input
                  type="text"
                  value={draftName}
                  maxLength={80}
                  placeholder={draft.shape === "circle" ? "e.g. Downtown patrol" : "e.g. Stadium zone"}
                  autoFocus
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </label>
              <div className="geofence-draft-row">
                {draft.shape === "circle" && (
                  <label>
                    Radius (m)
                    <input
                      type="number"
                      min={25}
                      max={50000}
                      step={25}
                      value={Math.round(draft.radiusM)}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        if (Number.isFinite(next) && next > 0) {
                          setDraft({ ...draft, radiusM: next });
                        }
                      }}
                    />
                  </label>
                )}
                <label>
                  Colour
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                  />
                </label>
                {draft.shape === "polygon" && (
                  <span className="geofence-draft-note">{draft.points.length}-corner polygon</span>
                )}
              </div>
              <div className="geofence-draft-actions">
                <button className="btn sm primary" onClick={saveGeofence} disabled={geoBusy}>
                  {geoBusy ? "Saving…" : "Save geofence"}
                </button>
                <button className="btn sm" onClick={cancelDraft} disabled={geoBusy}>
                  Discard
                </button>
              </div>
            </div>
          )}

          {geofences.length === 0 && !draft ? (
            <div className="empty">
              {canEdit
                ? "No geofences yet — add a circle or polygon to mark a zone."
                : "No geofences have been drawn."}
            </div>
          ) : (
            <ul className="geofence-list">
              {geofences.map((fence) => (
                <li key={fence.id}>
                  <button
                    className="geofence-name"
                    onClick={() => focusGeofence(fence)}
                    title="Centre the map on this geofence"
                  >
                    <span
                      className="geofence-swatch"
                      style={{ background: fence.color ?? GEOFENCE_DEFAULT_COLOR }}
                    />
                    {fence.name}
                    <span className="geofence-meta">
                      {fence.shape === "polygon"
                        ? `Polygon · ${fence.points?.length ?? 0} pts`
                        : `${Math.round(fence.radius_m ?? 0)} m`}
                    </span>
                  </button>
                  {canEdit && (
                    <button className="geofence-remove" onClick={() => removeGeofence(fence.id)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {gpsPanelOpen && (
        <div className="map-tool-panel">
          <div className="map-tool-head">
            <strong>Search GPS logs</strong>
          </div>
          <label className="gps-field">
            Radio
            <input
              type="text"
              list="map-unit-options"
              value={trackUnit}
              placeholder="Unit id"
              onChange={(e) => setTrackUnit(e.target.value)}
            />
            <datalist id="map-unit-options">
              {unitOptions.map((u) => (
                <option key={u.unitId} value={u.unitId}>
                  {u.label}
                </option>
              ))}
            </datalist>
          </label>
          <div className="gps-range">
            <label className="gps-field">
              From
              <input
                type="datetime-local"
                value={trackFrom}
                max={trackTo || undefined}
                onChange={(e) => setTrackFrom(e.target.value)}
              />
            </label>
            <label className="gps-field">
              To
              <input
                type="datetime-local"
                value={trackTo}
                min={trackFrom || undefined}
                onChange={(e) => setTrackTo(e.target.value)}
              />
            </label>
          </div>
          <div className="gps-actions">
            <button className="btn sm primary" onClick={showTrack} disabled={trackBusy}>
              {trackBusy ? "Loading…" : "Show track"}
            </button>
            {track && (
              <button className="btn sm" onClick={clearTrack}>
                Clear track
              </button>
            )}
          </div>
          {trackStatus && <div className="gps-status">{trackStatus}</div>}
        </div>
      )}

      <div ref={mapElRef} className="map-canvas" />
    </div>
  );
}

/**
 * The console's map slot. Hosts the embedded {@link MapView} and can detach it
 * into a standalone browser window so the map lives on a second screen.
 */
export function MapPanel() {
  const [popup, setPopup] = useState<Window | null>(null);

  // While the map is detached, watch for the operator closing that window.
  useEffect(() => {
    if (!popup) {
      return;
    }
    const timer = window.setInterval(() => {
      if (popup.closed) {
        setPopup(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [popup]);

  function popOut() {
    if (popup && !popup.closed) {
      popup.focus();
      return;
    }
    const win = window.open(
      MAP_WINDOW_PATH,
      "safetRadioMap",
      "popup=yes,width=1180,height=860",
    );
    if (win) {
      win.focus();
      setPopup(win);
    }
  }

  function bringBack() {
    popup?.close();
    setPopup(null);
  }

  if (popup) {
    return (
      <div className="map-panel">
        <div className="map-head">
          <h3>Radio Map</h3>
        </div>
        <div className="map-popped">
          <strong>Map opened in a separate window</strong>
          <p>The live radio map is running in its own window — drag it to another screen.</p>
          <div className="map-popped-actions">
            <button className="btn sm" onClick={() => popup.focus()}>
              Focus window
            </button>
            <button className="btn sm" onClick={bringBack}>
              Show here again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <MapView variant="embedded" onPopOut={popOut} />;
}
