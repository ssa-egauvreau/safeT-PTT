import { useEffect } from "react";
import { sounds } from "../sounds";
import { Topbar } from "../Topbar";
import { MapPanel } from "./MapPanel";
import { AlertsPanel } from "./AlertsPanel";
import { ChannelListPanel } from "./ChannelListPanel";
import { OnAirPanel } from "./OnAirPanel";
import { PopOutSection } from "./PopOutSection";

export function ConsolePage() {
  useEffect(() => {
    sounds.preload();
    return sounds.startAutoRefresh();
  }, []);

  return (
    <div className="app-shell">
      <Topbar section="console" />

      <div className="console-grid">
        <div className="console-col">
          <PopOutSection
            title="Channels"
            route="/console/channels"
            windowName="safetConsoleChannels"
            width={460}
            height={900}
            render={(onPopOut) => <ChannelListPanel onPopOut={onPopOut} />}
          />
        </div>

        <div className="console-col">
          <PopOutSection
            title="Channels on air"
            route="/console/onair"
            windowName="safetConsoleOnAir"
            width={1040}
            height={900}
            render={(onPopOut) => <OnAirPanel onPopOut={onPopOut} />}
          />
        </div>

        <div className="console-col">
          <MapPanel />
          <div className="alerts-slot">
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
      </div>
    </div>
  );
}
