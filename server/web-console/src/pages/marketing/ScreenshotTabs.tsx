import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceFrame } from "./DeviceFrame";

export interface ScreenshotTab {
  id: string;
  label: string;
  variant: "phone" | "browser";
  src: string;
  alt: string;
}

interface ScreenshotTabsProps {
  tabs: ScreenshotTab[];
  /** Auto-advance interval in ms. Set to 0 to disable. Default 5000. */
  autoAdvanceMs?: number;
}

const DEFAULT_AUTO_MS = 5000;

export function ScreenshotTabs({ tabs, autoAdvanceMs = DEFAULT_AUTO_MS }: ScreenshotTabsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const manualUntilRef = useRef(0);
  const count = tabs.length;

  const goTo = useCallback(
    (index: number, manual = false) => {
      if (count === 0) {
        return;
      }
      setActiveIndex(((index % count) + count) % count);
      if (manual) {
        manualUntilRef.current = Date.now() + autoAdvanceMs;
      }
    },
    [autoAdvanceMs, count],
  );

  useEffect(() => {
    if (count <= 1 || autoAdvanceMs <= 0) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const id = window.setInterval(() => {
      if (Date.now() < manualUntilRef.current) {
        return;
      }
      setActiveIndex((i) => (i + 1) % count);
    }, autoAdvanceMs);

    return () => window.clearInterval(id);
  }, [autoAdvanceMs, count]);

  if (count === 0) {
    return null;
  }

  return (
    <div
      className="screenshot-tabs"
      role="region"
      aria-roledescription="carousel"
      aria-label="Product screenshots"
    >
      <div className="screenshot-tabs-nav" role="tablist" aria-label="Screenshot categories">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`screenshot-tab-${tab.id}`}
            aria-selected={index === activeIndex}
            aria-controls={`screenshot-panel-${tab.id}`}
            className={index === activeIndex ? "screenshot-tab active" : "screenshot-tab"}
            onClick={() => goTo(index, true)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="screenshot-tabs-panel">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            id={`screenshot-panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`screenshot-tab-${tab.id}`}
            aria-hidden={index !== activeIndex}
            className={index === activeIndex ? "screenshot-tabs-slide active" : "screenshot-tabs-slide"}
            data-variant={tab.variant}
          >
            <DeviceFrame variant={tab.variant} src={tab.src} alt={tab.alt} />
          </div>
        ))}
      </div>
    </div>
  );
}
