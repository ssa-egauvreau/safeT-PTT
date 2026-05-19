import { useEffect } from "react";
import { MapView } from "./MapPanel";

/** Standalone full-window radio map — the target of the console's "Pop out" button. */
export function MapWindowPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Radio Map — safeT PTT";
    return () => {
      document.title = previous;
    };
  }, []);

  return <MapView variant="window" />;
}
