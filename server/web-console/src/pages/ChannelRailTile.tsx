import { useRef, useSyncExternalStore, type DragEvent } from "react";
import type { UserChannel } from "../api";
import { IconRadio } from "../icons";
import {
  createRailDragGhostElement,
  getRailDragPreview,
  setRailDragPreview,
  subscribeRailDragPreview,
  workspacePreviewForChannel,
} from "./workspaceRailDrag";

/**
 * One channel row in the left rail. Clicking the name toggles the channel on
 * (docked on the board + audio on) or off (removed + audio off) — one action,
 * no separate board/audio buttons. An "on" channel gets the green tile overlay;
 * the ⋮⋮ grip still drags the channel onto a specific spot on the board.
 */
export function ChannelRailTile({
  channel,
  monitoring,
  docked,
  onToggleActive,
}: {
  channel: UserChannel;
  monitoring: boolean;
  docked: boolean;
  /** Toggle the channel on (dock + monitor) / off (undock + stop monitor). */
  onToggleActive: () => void;
}) {
  const ghostRef = useRef<HTMLElement | null>(null);
  const railDrag = useSyncExternalStore(
    subscribeRailDragPreview,
    getRailDragPreview,
    () => null,
  );
  const isDragSource = railDrag?.channelId === channel.id;
  const active = docked || monitoring;

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
      title="Click the name to turn the channel on/off, or drag the ⋮⋮ grip to place it on the board"
    >
      <span
        className="channel-rail-grip"
        aria-hidden
        draggable
        onDragStart={onGripDragStart}
        onDragEnd={onDragEnd}
        title="Drag onto the board"
      >
        ⋮⋮
      </span>
      <button
        type="button"
        className="channel-rail-tile-main"
        onClick={onToggleActive}
        aria-pressed={active}
        title={active ? `Turn ${channel.name} off` : `Turn ${channel.name} on`}
      >
        <IconRadio size={13} />
        <span className="channel-rail-label">{channel.name}</span>
        {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
      </button>
    </div>
  );
}
