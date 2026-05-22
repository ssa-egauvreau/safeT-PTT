import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MAX_PER_ROW,
  WORKSPACE_MAX_ROW_SPAN,
  WORKSPACE_MIN_ROW_SPAN,
  WORKSPACE_ROW_PX,
  dockChannel,
  getWorkspaceTile,
  reorderDockedChannels,
  setWorkspaceTileRowSpan,
  snapWorkspaceRowSpan,
  workspaceTierFromRowSpan,
} from "../consoleStore";

function chunkChannels<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function tilePixelHeight(rowSpan: number): number {
  return rowSpan * WORKSPACE_ROW_PX + (rowSpan - 1) * WORKSPACE_GRID_GAP_PX;
}

function insertIndexFromPointer(clientX: number, root: HTMLElement, channelIds: number[]): number {
  const tiles = [...root.querySelectorAll<HTMLElement>("[data-channel-id]")];
  if (tiles.length === 0) {
    return 0;
  }
  for (let i = 0; i < tiles.length; i++) {
    const id = Number(tiles[i]!.dataset.channelId);
    const idx = channelIds.indexOf(id);
    if (idx < 0) {
      continue;
    }
    const rect = tiles[i]!.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return idx;
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
  const rows = useMemo(() => chunkChannels(dockedChannels, WORKSPACE_MAX_PER_ROW), [dockedChannels]);

  const maxRowSpan = dockedChannels.reduce((m, ch) => {
    return Math.max(m, getWorkspaceTile(ch.id).rowSpan);
  }, WORKSPACE_MIN_ROW_SPAN);

  useEffect(() => {
    if (channelIds.length === 0) {
      return;
    }
    reorderDockedChannels(channelIds);
  }, [channelIds.join(",")]);

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
      const insertAt = insertIndexFromPointer(e.clientX, rootRef.current, channelIds);
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

  const rowMinHeight = tilePixelHeight(maxRowSpan);

  return (
    <section
      ref={rootRef}
      className={`channel-workspace-rows${dockDragOver ? " drag-over" : ""}`}
      aria-label="Channel workspace"
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
            Up to four per row, equal width · drag left or right to reorder · drag bottom edge to resize
            (snaps to show more or fewer controls)
          </p>
        </div>
      ) : (
        rows.map((rowChannels) => (
          <div
            key={rowChannels.map((c) => c.id).join("-")}
            className="channel-workspace-row"
            style={{ minHeight: rowMinHeight }}
          >
            {rowChannels.map((channel) => {
              const tile = getWorkspaceTile(channel.id);
              const monitoring = open.includes(channel.id);
              return (
                <div
                  key={channel.id}
                  data-channel-id={channel.id}
                  className={`channel-workspace-tile${!monitoring ? " channel-off" : ""}${
                    resizeChannelId === channel.id ? " resizing" : ""
                  }${dragOverChannelId === channel.id ? " drag-over" : ""}`}
                  style={{ minHeight: tilePixelHeight(tile.rowSpan) }}
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
            })}
          </div>
        ))
      )}
    </section>
  );
}
