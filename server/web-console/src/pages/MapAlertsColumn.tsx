import { lazy, Suspense, useCallback, useEffect, useState, type PointerEvent } from "react";
const MapPanel = lazy(() => import("./MapPanel").then((m) => ({ default: m.MapPanel })));
import { AlertsPanel } from "./AlertsPanel";
import { PopOutSection } from "./PopOutSection";

const HEIGHT_STORAGE_KEY = "securityradio.mapHeightPx";
const DEFAULT_MAP_HEIGHT = 520;
const MIN_MAP_HEIGHT = 240;
const MAX_MAP_HEIGHT = 1000;

function loadMapHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= MIN_MAP_HEIGHT && n <= MAX_MAP_HEIGHT) {
      return n;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MAP_HEIGHT;
}

/**
 * Right column: a fixed-height (drag-resizable) map on top, alerts sized to their content below.
 * A map can't size to its content, so it keeps an explicit pixel height the operator can drag; the
 * rest of the console scrolls as one page, so there are no nested scroll regions around it.
 */
export function MapAlertsColumn() {
  const [mapHeight, setMapHeight] = useState(loadMapHeight);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setMapReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(mapHeight));
    } catch {
      /* storage unavailable */
    }
  }, [mapHeight]);

  const beginResize = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = mapHeight;

      function onMove(ev: globalThis.PointerEvent) {
        const next = startHeight + (ev.clientY - startY);
        setMapHeight(Math.max(MIN_MAP_HEIGHT, Math.min(MAX_MAP_HEIGHT, next)));
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [mapHeight],
  );

  return (
    <div className="map-alerts-column">
      <div className="map-alerts-map" style={{ height: `${mapHeight}px` }}>
        {mapReady ? (
          <Suspense fallback={<div className="empty">Loading map…</div>}>
            <MapPanel />
          </Suspense>
        ) : (
          <div className="empty">Loading map…</div>
        )}
      </div>
      <button
        type="button"
        className="map-alerts-splitter"
        aria-label="Resize map height"
        onPointerDown={beginResize}
      />
      <div className="map-alerts-alerts">
        <PopOutSection
          title="Alerts & Paging"
          route="/console/alerts"
          windowName="safetConsoleAlerts"
          width={480}
          height={820}
          render={(onPopOut) => <AlertsPanel onPopOut={onPopOut} />}
        />
      </div>
    </div>
  );
}
