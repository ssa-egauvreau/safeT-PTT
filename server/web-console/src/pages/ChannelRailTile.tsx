import { useRef, useSyncExternalStore, type DragEvent } from "react";
import type { UserChannel } from "../api";
import { IconBoard, IconHeadphones, IconRadio } from "../icons";
import {
  createRailDragGhostElement,
  getRailDragPreview,
  setRailDragPreview,
  subscribeRailDragPreview,
  workspacePreviewForChannel,
} from "./workspaceRailDrag";

/**
 * One channel row in the left rail. The two states a dispatcher needs at a
 * glance are explicit, separate controls:
 *   - board button: filled when the channel is docked on the workspace;
 *   - headphones button: green "live" when audio is on (monitoring), with a
 *     pulsing dot beside the name as a second cue.
 */
export function ChannelRailTile({
  channel,
  monitoring,
  docked,
  onDock,
  onToggleMonitor,
  onUndock,
}: {
  channel: UserChannel;
  monitoring: boolean;
  docked: boolean;
  onDock: () => void;
  onToggleMonitor: () => void;
  /** Remove channel from the workspace (when docked). */
  onUndock?: () => void;
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

  function toggleBoard() {
    if (docked) {
      onUndock?.();
    } else {
      onDock();
    }
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
      title="Tap the name to open it on the board, or drag the ⋮⋮ grip to drag it in"
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
      <button type="button" className="channel-rail-tile-main" onClick={onDock}>
        <IconRadio size={13} />
        <span className="channel-rail-label">{channel.name}</span>
        {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
        {monitoring && (
          <span className="channel-rail-live-dot" title="Audio on" aria-label="Audio on" role="img" />
        )}
      </button>
      <button
        type="button"
        className={docked ? "channel-rail-board on" : "channel-rail-board"}
        onClick={(e) => {
          e.stopPropagation();
          toggleBoard();
        }}
        aria-pressed={docked}
        aria-label={docked ? `Remove ${channel.name} from the board` : `Open ${channel.name} on the board`}
        title={docked ? "On the board — click to remove" : "Not on the board — click to add"}
      >
        <IconBoard size={12} />
      </button>
      <button
        type="button"
        className={monitoring ? "ch-power active" : "ch-power"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMonitor();
        }}
        aria-pressed={monitoring}
        title={monitoring ? "Audio on — click to turn off" : "Audio off — click to turn on"}
      >
        <IconHeadphones size={15} />
      </button>
    </div>
  );
}
