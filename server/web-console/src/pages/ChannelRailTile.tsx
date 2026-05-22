import { useRef, useSyncExternalStore, type DragEvent } from "react";
import type { UserChannel } from "../api";
import { IconHeadphones, IconRadio } from "../icons";
import {
  createRailDragGhostElement,
  getRailDragPreview,
  setRailDragPreview,
  subscribeRailDragPreview,
  workspacePreviewForChannel,
} from "./workspaceRailDrag";

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
  const ghostRef = useRef<HTMLElement | null>(null);
  const railDrag = useSyncExternalStore(
    subscribeRailDragPreview,
    getRailDragPreview,
    () => null,
  );
  const isDragSource = railDrag?.channelId === channel.id;

  function onGripDragStart(e: DragEvent) {
    e.stopPropagation();
    const idText = String(channel.id);
    e.dataTransfer.setData("text/channel-id", idText);
    e.dataTransfer.setData("text/plain", idText);
    e.dataTransfer.effectAllowed = "move";
    const { size, colSpan } = workspacePreviewForChannel(channel, docked);
    setRailDragPreview({
      channelId: channel.id,
      channelName: channel.name,
      color: channel.color ?? null,
      simulcast: channel.simulcast === true,
      size,
      colSpan,
    });
    const ghost = createRailDragGhostElement(channel, size, colSpan);
    ghostRef.current = ghost;
    document.body.appendChild(ghost);
    const rect = ghost.getBoundingClientRect();
    e.dataTransfer.setDragImage(ghost, Math.min(rect.width * 0.5, 80), 28);
  }

  function onDragEnd() {
    ghostRef.current?.remove();
    ghostRef.current = null;
    setRailDragPreview(null);
  }

  return (
    <div
      className={`channel-rail-tile${docked ? " docked" : ""}${monitoring ? " monitoring" : ""}${
        isDragSource ? " drag-source" : ""
      }`}
      style={
        channel.color
          ? { borderLeftColor: channel.color, borderLeftWidth: 3 }
          : undefined
      }
      title="Tap the name to open it in the workspace, or drag the ⋮⋮ grip to drag it in"
    >
      <span
        className="channel-rail-grip"
        aria-hidden
        draggable
        onDragStart={onGripDragStart}
        onDragEnd={onDragEnd}
        title="Drag into workspace"
      >
        ⋮⋮
      </span>
      <button type="button" className="channel-rail-tile-main" onClick={onDock}>
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
