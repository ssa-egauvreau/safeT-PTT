import { useCallback, useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_ROW_PX,
  getWorkspaceTile,
  reorderDockedChannels,
  setWorkspaceTileRowSpan,
  snapWorkspaceRowSpan,
  workspaceTierFromRowSpan,
} from "../consoleStore";

function insertIndexFromPointer(
  clientX: number,
  clientY: number,
  root: HTMLElement,
  channelIds: number[],
): number {
  type Entry = { id: number; idx: number; top: number; left: number; midY: number; midX: number };
  const entries: Entry[] = [];
  for (const id of channelIds) {
    const el = root.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
    if (!el) {
      continue;
    }
    const idx = channelIds.indexOf(id);
    if (idx < 0) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    entries.push({
      id,
      idx,
      top: rect.top,
      left: rect.left,
      midY: rect.top + rect.height / 2,
      midX: rect.left + rect.width / 2,
    });
  }
  entries.sort((a, b) => a.top - b.top || a.left - b.left);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (clientY < e.midY || (clientY <= e.top + 8 && clientX < e.midX)) {
      return e.idx;
    }
    if (clientY < e.top + 4) {
      return e.idx;
    }
  }
  return channelIds.length;
}

export function ChannelWorkspace({
  dockedChannels,
  open,
  primary,
  pttCode,
  keyboardOn,
  onToggleMonitor,
  onUndock,
  onMakePrimary,
  onDockFromRail,
}: {
  dockedChannels: UserChannel[];
  open: number[];
  primary: number | null;
  pttCode: string;
  keyboardOn: boolean;
  onToggleMonitor: (id: number) => void;
  onUndock: (id: number) => void;
  onMakePrimary: (id: number) => void;
  onDockFromRail: (id: number, insertAt?: number) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [dockDragOver, setDockDragOver] = useState(false);
  const [resizeChannelId, setResizeChannelId] = useState<number | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);

  const channelIds = useMemo(() => dockedChannels.map((c) => c.id), [dockedChannels]);

  const handleWorkspaceDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDockDragOver(false);
      setDragOverChannelId(null);
      const raw = e.dataTransfer.getData("text/channel-id");
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0 || !rootRef.current) {
        return;
      }
      const insertAt = insertIndexFromPointer(
        e.clientX,
        e.clientY,
        rootRef.current,
        channelIds,
      );
      if (channelIds.includes(id)) {
        const next = [...channelIds];
        const from = next.indexOf(id);
        next.splice(from, 1);
        let to = insertAt;
        if (from < to) {
          to -= 1;
        }
        next.splice(Math.max(0, to), 0, id);
        reorderDockedChannels(next);
      } else {
        onDockFromRail(id, insertAt);
      }
    },
    [channelIds, onDockFromRail],
  );

  function beginResizeHeight(e: PointerEvent<HTMLButtonElement>, channelId: number) {
    e.preventDefault();
    e.stopPropagation();
    const origin = getWorkspaceTile(channelId).rowSpan;
    const startY = e.clientY;
    setResizeChannelId(channelId);
    const onMove = (ev: globalThis.PointerEvent) => {
      const deltaRow = Math.round((ev.clientY - startY) / WORKSPACE_ROW_PX);
      setWorkspaceTileRowSpan(channelId, snapWorkspaceRowSpan(origin + deltaRow));
    };
    const onUp = () => {
      setResizeChannelId(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onTileDragStart(e: DragEvent<HTMLDivElement>, channelId: number) {
    if (
      (e.target as HTMLElement).closest(
        "button, input, select, a, .tx-button, .vol-slider, .channel-workspace-resize-h",
      )
    ) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/channel-id", String(channelId));
    e.dataTransfer.effectAllowed = "move";
  }

  function onTileDragOver(e: DragEvent<HTMLDivElement>, channelId: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverChannelId(channelId);
  }

  function onTileDrop(e: DragEvent<HTMLDivElement>, targetId: number) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverChannelId(null);
    const raw = e.dataTransfer.getData("text/channel-id");
    const sourceId = Number(raw);
    if (!Number.isFinite(sourceId) || sourceId === targetId) {
      return;
    }
    const from = channelIds.indexOf(sourceId);
    const to = channelIds.indexOf(targetId);
    if (from < 0 || to < 0) {
      return;
    }
    const next = [...channelIds];
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    reorderDockedChannels(next);
  }

  return (
    <section
      ref={rootRef}
      className={`channel-workspace-rows channel-workspace-grid${dockDragOver ? " drag-over" : ""}`}
      aria-label="Channel workspace"
      style={{ gridAutoRows: `${WORKSPACE_ROW_PX}px` }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDockDragOver(true);
      }}
      onDragLeave={() => setDockDragOver(false)}
      onDrop={handleWorkspaceDrop}
    >
      {dockedChannels.length === 0 ? (
        <div className="channel-workspace-empty">
          <p>Drag channels here from the list on the left.</p>
          <p className="muted">
            Up to four across · short tiles stack vertically · drag bottom edge to resize (volume + XMIT at
            smallest)
          </p>
        </div>
      ) : (
        dockedChannels.map((channel) => {
          const tile = getWorkspaceTile(channel.id);
          const monitoring = open.includes(channel.id);
          const tileMinHeight =
            tile.rowSpan * WORKSPACE_ROW_PX + Math.max(0, tile.rowSpan - 1) * WORKSPACE_GRID_GAP_PX;
          return (
            <div
              key={channel.id}
              data-channel-id={channel.id}
              className={`channel-workspace-tile${!monitoring ? " channel-off" : ""}${
                resizeChannelId === channel.id ? " resizing" : ""
              }${dragOverChannelId === channel.id ? " drag-over" : ""}`}
              style={{
                gridColumn: `${tile.col + 1} / span ${tile.colSpan}`,
                gridRow: `${tile.row + 1} / span ${tile.rowSpan}`,
                minHeight: tileMinHeight,
              }}
              draggable
              onDragStart={(e) => onTileDragStart(e, channel.id)}
              onDragOver={(e) => onTileDragOver(e, channel.id)}
              onDragLeave={() =>
                setDragOverChannelId((id) => (id === channel.id ? null : id))
              }
              onDrop={(e) => onTileDrop(e, channel.id)}
            >
              <div className="channel-workspace-tile-inner">
                <ChannelPanel
                  channel={channel}
                  layout="workspace"
                  workspaceTier={workspaceTierFromRowSpan(tile.rowSpan)}
                  monitoring={monitoring}
                  expanded
                  primary={primary === channel.id}
                  pttCode={pttCode}
                  keyboardOn={keyboardOn}
                  onToggleMonitor={() => onToggleMonitor(channel.id)}
                  onToggleExpanded={() => onUndock(channel.id)}
                  onMakePrimary={() => onMakePrimary(channel.id)}
                />
                {!monitoring && <div className="channel-off-overlay" aria-hidden />}
              </div>
              <button
                type="button"
                className="channel-workspace-resize-h"
                aria-label="Resize height (snaps to each control section)"
                onPointerDown={(e) => beginResizeHeight(e, channel.id)}
              />
            </div>
          );
        })
      )}
    </section>
  );
}
