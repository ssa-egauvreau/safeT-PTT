import { useCallback, useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import {
  WORKSPACE_COLS,
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MAIN_COL_SPAN,
  WORKSPACE_ROW_PX,
  WORKSPACE_STACK_COL_START,
  getWorkspaceTile,
  placeWorkspaceTileBeside,
  reorderDockedChannels,
  setWorkspaceTileColSpan,
  setWorkspaceTileRowSpan,
  snapWorkspaceColSpan,
  snapWorkspaceRowSpan,
  stackWorkspaceTileBelow,
  useConsoleState,
  workspaceTierFromRowSpan,
  type WorkspaceTileLayout,
} from "../consoleStore";

export type WorkspaceDropZone = "stack" | "left" | "right" | "reorder";

function dropZoneFromPointer(
  clientX: number,
  clientY: number,
  tileEl: HTMLElement,
): WorkspaceDropZone {
  const rect = tileEl.getBoundingClientRect();
  const y = (clientY - rect.top) / rect.height;
  const x = (clientX - rect.left) / rect.width;
  if (y > 0.62) {
    return "stack";
  }
  if (x > 0.68) {
    return "right";
  }
  if (x < 0.32) {
    return "left";
  }
  return "reorder";
}

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

function stackLayerInColumn(
  channelId: number,
  tile: WorkspaceTileLayout,
  tilesById: Map<number, WorkspaceTileLayout>,
): number {
  let layer = 0;
  for (const [id, other] of tilesById) {
    if (id === channelId) {
      continue;
    }
    if (other.col === tile.col && other.row < tile.row) {
      layer += 1;
    }
  }
  return layer;
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
  const [resizePreview, setResizePreview] = useState<{
    rowSpan: number;
    colSpan: number;
  } | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  const [dropZone, setDropZone] = useState<WorkspaceDropZone | null>(null);

  const { workspaceLayout } = useConsoleState();

  const channelIds = useMemo(() => dockedChannels.map((c) => c.id), [dockedChannels]);

  const tilesById = useMemo(() => {
    const map = new Map<number, WorkspaceTileLayout>();
    for (const channel of dockedChannels) {
      map.set(channel.id, getWorkspaceTile(channel.id));
    }
    return map;
  }, [dockedChannels, workspaceLayout]);

  const handleWorkspaceDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDockDragOver(false);
      clearDragOver();
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

  function gridColWidthPx(): number {
    const root = rootRef.current;
    if (!root) {
      return 40;
    }
    const style = getComputedStyle(root);
    const gap = Number.parseFloat(style.columnGap || "6") || 6;
    const pad =
      (Number.parseFloat(style.paddingLeft || "0") || 0) +
      (Number.parseFloat(style.paddingRight || "0") || 0);
    return (root.clientWidth - pad - gap * (WORKSPACE_COLS - 1)) / WORKSPACE_COLS;
  }

  function beginResize(
    e: PointerEvent<HTMLButtonElement>,
    channelId: number,
    axis: "height" | "width" | "both",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const origin = getWorkspaceTile(channelId);
    const startX = e.clientX;
    const startY = e.clientY;
    const colPx = gridColWidthPx();
    setResizeChannelId(channelId);
    setResizePreview({ rowSpan: origin.rowSpan, colSpan: origin.colSpan });
    let liveRowSpan = origin.rowSpan;
    let liveColSpan = origin.colSpan;

    const onMove = (ev: globalThis.PointerEvent) => {
      if (axis === "height" || axis === "both") {
        const deltaRow = Math.round((ev.clientY - startY) / WORKSPACE_ROW_PX);
        liveRowSpan = snapWorkspaceRowSpan(origin.rowSpan + deltaRow);
      }
      if (axis === "width" || axis === "both") {
        const deltaCol = Math.round((ev.clientX - startX) / colPx);
        liveColSpan = snapWorkspaceColSpan(origin.colSpan + deltaCol);
      }
      setResizePreview({ rowSpan: liveRowSpan, colSpan: liveColSpan });
    };
    const onUp = () => {
      if (liveRowSpan !== origin.rowSpan) {
        setWorkspaceTileRowSpan(channelId, liveRowSpan);
      }
      if (liveColSpan !== origin.colSpan) {
        setWorkspaceTileColSpan(channelId, liveColSpan);
      }
      setResizeChannelId(null);
      setResizePreview(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onTileDragStart(e: DragEvent<HTMLElement>, channelId: number) {
    e.dataTransfer.setData("text/channel-id", String(channelId));
    e.dataTransfer.effectAllowed = "move";
  }

  function onTileDragOver(e: DragEvent<HTMLDivElement>, channelId: number) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDragOverChannelId(channelId);
    const tile = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-channel-id]");
    if (tile) {
      setDropZone(dropZoneFromPointer(e.clientX, e.clientY, tile));
    }
  }

  function clearDragOver() {
    setDragOverChannelId(null);
    setDropZone(null);
  }

  function onTileDrop(e: DragEvent<HTMLDivElement>, targetId: number) {
    e.preventDefault();
    e.stopPropagation();
    const zone = dropZone;
    clearDragOver();
    const raw = e.dataTransfer.getData("text/channel-id");
    const sourceId = Number(raw);
    if (!Number.isFinite(sourceId) || sourceId === targetId) {
      return;
    }
    const tile = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-channel-id]");
    const resolvedZone =
      zone ?? (tile ? dropZoneFromPointer(e.clientX, e.clientY, tile) : "reorder");

    if (resolvedZone === "stack") {
      stackWorkspaceTileBelow(sourceId, targetId);
      return;
    }
    if (resolvedZone === "right") {
      placeWorkspaceTileBeside(sourceId, targetId, "right");
      return;
    }
    if (resolvedZone === "left") {
      placeWorkspaceTileBeside(sourceId, targetId, "left");
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
            Drag ⋮⋮ to move · drop on bottom of a tile to stack · drag bottom or right edge to resize ·
            drag corner for both
          </p>
        </div>
      ) : (
        dockedChannels.map((channel) => {
          const tile = tilesById.get(channel.id) ?? getWorkspaceTile(channel.id);
          const resizing = resizeChannelId === channel.id && resizePreview !== null;
          const rowSpan = resizing ? resizePreview.rowSpan : tile.rowSpan;
          const colSpan = resizing ? resizePreview.colSpan : tile.colSpan;
          const monitoring = open.includes(channel.id);
          const tileMinHeight =
            rowSpan * WORKSPACE_ROW_PX + Math.max(0, rowSpan - 1) * WORKSPACE_GRID_GAP_PX;
          const isMain = colSpan >= WORKSPACE_MAIN_COL_SPAN || colSpan >= 12;
          const isStackLane = tile.col >= WORKSPACE_STACK_COL_START;
          const stackLayer = isStackLane ? stackLayerInColumn(channel.id, tile, tilesById) : 0;
          const widthClass = isMain
            ? " workspace-tile-main"
            : colSpan >= 6
              ? " workspace-tile-half"
              : " workspace-tile-compact";
          const dropClass =
            dragOverChannelId === channel.id && dropZone
              ? ` drop-${dropZone}`
              : "";
          const stackStyle =
            stackLayer > 0
              ? {
                  marginTop: -14,
                  zIndex: 12 + stackLayer,
                }
              : isStackLane
                ? { zIndex: 11 }
                : isMain
                  ? { zIndex: 8 }
                  : undefined;
          return (
            <div
              key={channel.id}
              data-channel-id={channel.id}
              className={`channel-workspace-tile${widthClass}${stackLayer > 0 ? " workspace-tile-stacked" : ""}${!monitoring ? " channel-off" : ""}${
                resizeChannelId === channel.id ? " resizing" : ""
              }${dragOverChannelId === channel.id ? " drag-over" : ""}${dropClass}`}
              style={{
                gridColumn: `${tile.col + 1} / span ${colSpan}`,
                gridRow: `${tile.row + 1} / span ${rowSpan}`,
                minHeight: tileMinHeight,
                ...stackStyle,
              }}
              onDragOver={(e) => onTileDragOver(e, channel.id)}
              onDragLeave={() => {
                if (dragOverChannelId === channel.id) {
                  clearDragOver();
                }
              }}
              onDrop={(e) => onTileDrop(e, channel.id)}
            >
              <div
                className="channel-workspace-drag-handle"
                draggable
                onDragStart={(e) => onTileDragStart(e, channel.id)}
                title="Drag to move · drop on tile edges to stack"
              >
                <span className="channel-workspace-drag-grip" aria-hidden>
                  ⋮⋮
                </span>
              </div>
              <div className="channel-workspace-tile-inner">
                <ChannelPanel
                  channel={channel}
                  layout="workspace"
                  workspaceTier={workspaceTierFromRowSpan(rowSpan)}
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
                className="channel-workspace-resize-w"
                aria-label="Resize width"
                onPointerDown={(e) => beginResize(e, channel.id, "width")}
              />
              <button
                type="button"
                className="channel-workspace-resize-h"
                aria-label="Resize height"
                onPointerDown={(e) => beginResize(e, channel.id, "height")}
              />
              <button
                type="button"
                className="channel-workspace-resize-corner"
                aria-label="Resize width and height"
                onPointerDown={(e) => beginResize(e, channel.id, "both")}
              />
            </div>
          );
        })
      )}
    </section>
  );
}
