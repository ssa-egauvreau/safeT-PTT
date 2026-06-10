import { useState } from "react";
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
}

export function ScreenshotTabs({ tabs }: ScreenshotTabsProps) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  if (!current) {
    return null;
  }

  return (
    <div className="screenshot-tabs">
      <div className="screenshot-tabs-nav" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            className={tab.id === active ? "screenshot-tab active" : "screenshot-tab"}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="screenshot-tabs-panel" role="tabpanel">
        <DeviceFrame variant={current.variant} src={current.src} alt={current.alt} />
      </div>
    </div>
  );
}
