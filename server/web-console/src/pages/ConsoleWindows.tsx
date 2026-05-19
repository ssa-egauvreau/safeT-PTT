import { useEffect } from "react";
import { sounds } from "../sounds";
import { ChannelListPanel } from "./ChannelListPanel";
import { OnAirPanel } from "./OnAirPanel";
import { AlertsPanel } from "./AlertsPanel";

/** Window-title + audio setup shared by every detached console section. */
function useConsoleWindow(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — safeT PTT`;
    sounds.preload();
    const stopSoundSync = sounds.startAutoRefresh();
    return () => {
      document.title = previous;
      stopSoundSync();
    };
  }, [title]);
}

/** Standalone window for the popped-out "Channels" list. */
export function ChannelsWindowPage() {
  useConsoleWindow("Channels");
  return <ChannelListPanel variant="window" />;
}

/** Standalone window for the popped-out "Channels on air" section. */
export function OnAirWindowPage() {
  useConsoleWindow("Channels on air");
  return <OnAirPanel variant="window" />;
}

/** Standalone window for the popped-out "Alerts & Paging" section. */
export function AlertsWindowPage() {
  useConsoleWindow("Alerts & Paging");
  return <AlertsPanel variant="window" />;
}
