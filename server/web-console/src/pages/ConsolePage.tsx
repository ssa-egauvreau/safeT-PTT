import { useEffect } from "react";
import { ConsoleErrorBoundary } from "../ConsoleErrorBoundary";
import { bindLostLinkBusyAlerts, sounds } from "../sounds";
import { Topbar } from "../Topbar";
import { ChannelsPanel } from "./ChannelsPanel";
import { MapAlertsColumn } from "./MapAlertsColumn";
import { MissionControlLayout } from "./MissionControlLayout";
import { Link } from "react-router-dom";
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
      <Topbar section="console" />

      <p className="mission-control-intro">
        <Link to="/console/ai-activity">AI dispatch activity log</Link>
        <span className="muted"> — transcripts, 10-33, plate lookups, 10-8 CAD notes</span>
      </p>

      <ConsoleErrorBoundary>
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
