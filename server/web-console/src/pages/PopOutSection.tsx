import { useEffect, useState, type ReactNode } from "react";

/** Props every pop-out-capable console section accepts. */
export interface SectionProps {
  /** "embedded" runs inside the console grid; "window" fills a pop-out window. */
  variant?: "embedded" | "window";
  /** Provided only when embedded — opens this section in its own window. */
  onPopOut?: () => void;
}

/** A section title bar with an optional "Pop out" button. */
export function SectionHeader({
  title,
  onPopOut,
}: {
  title: string;
  onPopOut?: () => void;
}) {
  return (
    <div className="section-head">
      <h3>{title}</h3>
      {onPopOut && (
        <button
          className="btn sm section-popout"
          onClick={onPopOut}
          title="Open this panel in a separate window"
        >
          Pop out
        </button>
      )}
    </div>
  );
}

/**
 * Hosts one console section. Renders it inline until the operator pops it out,
 * then detaches it into a standalone browser window and shows a placeholder in
 * its place — restoring the inline view when that window closes.
 */
export function PopOutSection({
  title,
  route,
  windowName,
  width,
  height,
  render,
}: {
  title: string;
  route: string;
  windowName: string;
  width: number;
  height: number;
  render: (onPopOut: () => void) => ReactNode;
}) {
  const [popup, setPopup] = useState<Window | null>(null);

  // While detached, watch for the operator closing that window.
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
    const win = window.open(route, windowName, `popup=yes,width=${width},height=${height}`);
    if (win) {
      win.focus();
      setPopup(win);
    }
  }

  if (popup) {
    return (
      <div className="section-panel">
        <div className="section-head">
          <h3>{title}</h3>
        </div>
        <div className="map-popped">
          <strong>{title} opened in a separate window</strong>
          <p>This panel is running in its own window — drag it wherever you need it.</p>
          <div className="map-popped-actions">
            <button className="btn sm" onClick={() => popup.focus()}>
              Focus window
            </button>
            <button
              className="btn sm"
              onClick={() => {
                popup.close();
                setPopup(null);
              }}
            >
              Show here again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{render(popOut)}</>;
}
