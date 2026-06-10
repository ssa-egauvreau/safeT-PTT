import { useEffect } from "react";
import { ConsoleErrorBoundary } from "../ConsoleErrorBoundary";
import { bindLostLinkBusyAlerts, sounds } from "../sounds";
import { Topbar } from "../Topbar";
import { ChannelsPanel } from "./ChannelsPanel";
import { MapAlertsColumn } from "./MapAlertsColumn";
import { MissionControlLayout } from "./MissionControlLayout";
import { PopOutSection } from "./PopOutSection";

export function ConsolePage() {
  useEffect(() => {
    sounds.preload();
    const stopSoundSync = sounds.startAutoRefresh();
    const stopLostLink = bindLostLinkBusyAlerts();
    return () => {
      stopSoundSync();
      stopLostLink();
    };
  }, []);

  return (
    <div className="app-shell">
      <ConsoleErrorBoundary>
      <Topbar section="console" />

        <MissionControlLayout
          channels={
            <PopOutSection
              title="Channels"
              route="/console/channels"
              windowName="safetConsoleChannels"
              width={720}
              height={900}
              render={(onPopOut) => <ChannelsPanel onPopOut={onPopOut} />}
            />
          }
          mapAlerts={<MapAlertsColumn />}
        />
      </ConsoleErrorBoundary>
    </div>
  );
}
