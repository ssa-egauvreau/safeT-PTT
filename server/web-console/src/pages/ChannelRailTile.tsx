import type { DragEvent } from "react";
import type { UserChannel } from "../api";
import { IconHeadphones, IconRadio } from "../icons";

export function ChannelRailTile({
  channel,
  monitoring,
  docked,
  onDock,
  onToggleMonitor,
}: {
  channel: UserChannel;
  monitoring: boolean;
  docked: boolean;
  onDock: () => void;
  onToggleMonitor: () => void;
}) {
  function onDragStart(e: DragEvent) {
    e.dataTransfer.setData("text/channel-id", String(channel.id));
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <div
      className={`channel-rail-tile${docked ? " docked" : ""}${monitoring ? " monitoring" : ""}`}
      draggable
      onDragStart={onDragStart}
      style={
        channel.color
          ? { borderLeftColor: channel.color, borderLeftWidth: 3 }
          : undefined
      }
      title="Tap the name to open it in the workspace, or drag it in"
    >
      <button type="button" className="channel-rail-tile-main" onClick={onDock}>
        <span className="channel-rail-grip" aria-hidden>
          ⋮⋮
        </span>
        <IconRadio size={12} />
        <span className="channel-rail-label">{channel.name}</span>
        {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
      </button>
      <button
        type="button"
        className={monitoring ? "ch-power active" : "ch-power"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMonitor();
        }}
        aria-pressed={monitoring}
        title={monitoring ? "Turn channel off" : "Turn channel on"}
      >
        <IconHeadphones size={14} />
      </button>
    </div>
  );
}
