import { useEffect } from "react";
import { ConsoleErrorBoundary } from "../ConsoleErrorBoundary";
import { bindLostLinkBusyAlerts, sounds } from "../sounds";
import { ChannelsPanel } from "./ChannelsPanel";
import { AlertsPanel } from "./AlertsPanel";

/** Window-title + audio setup shared by every detached console section. */
function useConsoleWindow(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — safeT PTT`;
    sounds.preload();
    const stopSoundSync = sounds.startAutoRefresh();
    const stopLostLink = bindLostLinkBusyAlerts();
    return () => {
      document.title = previous;
      stopSoundSync();
      stopLostLink();
    };
  }, [title]);
}

/** Standalone window for the popped-out "Channels" section. */
export function ChannelsWindowPage() {
  useConsoleWindow("Channels");
  return (
    <ConsoleErrorBoundary>
      <ChannelsPanel variant="window" />
    </ConsoleErrorBoundary>
  );
}

/** Standalone window for the popped-out "Alerts & Paging" section. */
export function AlertsWindowPage() {
  useConsoleWindow("Alerts & Paging");
  return <AlertsPanel variant="window" />;
}
