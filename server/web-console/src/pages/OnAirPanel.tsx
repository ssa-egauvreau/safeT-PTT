import { useEffect, useState } from "react";
import { api, type UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import { QuickReplay } from "./QuickReplay";
import { TransmissionLog } from "./TransmissionLog";
import { SectionHeader, type SectionProps } from "./PopOutSection";
import {
  closeChannel,
  reconcileChannels,
  reorderChannels,
  setPrimaryChannel,
  useConsoleState,
} from "../consoleStore";

/** The "Channels on air" section — quick replay, the open channel panels, log. */
export function OnAirPanel({ variant = "embedded", onPopOut }: SectionProps) {
  const { open, primary, pttCode, keyboardOn } = useConsoleState();
  const [channels, setChannels] = useState<UserChannel[]>([]);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => {
        setChannels(res.channels);
        reconcileChannels(res.channels.map((c) => c.id));
      })
      .catch(() => undefined);
  }, []);

  const openChannelObjs = open
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is UserChannel => !!c);

  return (
    <div className={variant === "window" ? "section-panel windowed" : "section-panel"}>
      <SectionHeader title="Channels on air" onPopOut={onPopOut} />
      <QuickReplay />
      {openChannelObjs.length === 0 ? (
        <div className="placeholder-box">
          <strong>No channels open</strong>
          Pick a channel in the Channels list — each one you open gets its own control panel here.
        </div>
      ) : (
        <div className="panel-grid">
          {openChannelObjs.map((channel) => (
            <ChannelPanel
              key={channel.id}
              channel={channel}
              primary={primary === channel.id}
              pttCode={pttCode}
              keyboardOn={keyboardOn}
              onMakePrimary={() => setPrimaryChannel(channel.id)}
              onClose={() => closeChannel(channel.id)}
              onReorder={
                openChannelObjs.length > 1
                  ? (fromId) => reorderChannels(fromId, channel.id)
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <TransmissionLog />
    </div>
  );
}
