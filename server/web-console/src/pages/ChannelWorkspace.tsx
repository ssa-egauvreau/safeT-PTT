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
  placeWorkspaceTileAtGrid,
  placeWorkspaceTileBeside,
  setWorkspaceTileColSpan,
  setWorkspaceTileRowSpan,
  snapWorkspaceColSpan,
  snapWorkspaceRowSpan,
  stackWorkspaceTileBelow,
  swapWorkspaceTiles,
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
  if (y > 0.78) {
    return "stack";
  }
  if (x > 0.72) {
    return "right";
  }
  if (x < 0.28) {
    return "left";
  }
  return "reorder";
}

function gridCellFromPointer(
  clientX: number,
  clientY: number,
  root: HTMLElement,
): { col: number; row: number } {
  const rect = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const gap = Number.parseFloat(style.rowGap || style.gap || "8") || 8;
  const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
  const padT = Number.parseFloat(style.paddingTop || "0") || 0;
  const innerW =
    rect.width -
    padL -
    (Number.parseFloat(style.paddingRight || "0") || 0) -
    gap * (WORKSPACE_COLS - 1);
  const colW = innerW / WORKSPACE_COLS;
  const x = clientX - rect.left - padL;
  const y = clientY - rect.top - padT;
  const col = Math.max(
    0,
    Math.min(WORKSPACE_COLS - 1, Math.floor(x / (colW + gap))),
  );
  const row = Math.max(0, Math.floor(y / (WORKSPACE_ROW_PX + gap)));
  return { col, row };
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
  const [moveChannelId, setMoveChannelId] = useState<number | null>(null);
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
        const cell = gridCellFromPointer(e.clientX, e.clientY, rootRef.current);
        placeWorkspaceTileAtGrid(id, cell.col, cell.row);
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

  function applyMoveDrop(sourceId: number, targetId: number, zone: WorkspaceDropZone) {
    if (zone === "stack") {
      stackWorkspaceTileBelow(sourceId, targetId);
      return;
    }
    if (zone === "right") {
      placeWorkspaceTileBeside(sourceId, targetId, "right");
      return;
    }
    if (zone === "left") {
      placeWorkspaceTileBeside(sourceId, targetId, "left");
      return;
    }
    swapWorkspaceTiles(sourceId, targetId);
  }

  function beginMove(e: PointerEvent<HTMLDivElement>, channelId: number) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setMoveChannelId(channelId);

    const onMove = (ev: PointerEvent) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = hit?.closest<HTMLElement>("[data-channel-id]");
      if (tile) {
        const id = Number(tile.dataset.channelId);
        if (Number.isFinite(id)) {
          setDragOverChannelId(id);
          setDropZone(dropZoneFromPointer(ev.clientX, ev.clientY, tile));
        }
      } else {
        clearDragOver();
      }
    };

    const onEnd = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = hit?.closest<HTMLElement>("[data-channel-id]");
      if (tile) {
        const targetId = Number(tile.dataset.channelId);
        if (Number.isFinite(targetId) && targetId !== channelId) {
          const zone = dropZoneFromPointer(ev.clientX, ev.clientY, tile);
          applyMoveDrop(channelId, targetId, zone);
        }
      } else if (rootRef.current && hit && rootRef.current.contains(hit)) {
        const cell = gridCellFromPointer(ev.clientX, ev.clientY, rootRef.current);
        placeWorkspaceTileAtGrid(channelId, cell.col, cell.row);
      }
      setMoveChannelId(null);
      clearDragOver();
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function beginResize(
    e: PointerEvent<HTMLButtonElement>,
    channelId: number,
    axis: "height" | "width" | "both",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const origin = getWorkspaceTile(channelId);
    const startX = e.clientX;
    const startY = e.clientY;
    const colPx = gridColWidthPx();
    setResizeChannelId(channelId);
    setResizePreview({ rowSpan: origin.rowSpan, colSpan: origin.colSpan });
    let liveRowSpan = origin.rowSpan;
    let liveColSpan = origin.colSpan;

    const onMove = (ev: PointerEvent) => {
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
    const onEnd = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
      if (liveRowSpan !== origin.rowSpan) {
        setWorkspaceTileRowSpan(channelId, liveRowSpan);
      }
      if (liveColSpan !== origin.colSpan) {
        setWorkspaceTileColSpan(channelId, liveColSpan);
      }
      setResizeChannelId(null);
      setResizePreview(null);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
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

    applyMoveDrop(sourceId, targetId, resolvedZone);
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
            Press and drag ⋮⋮ to move · bottom edge of a tile to stack · bottom/right edges to resize
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
                  marginTop: -8,
                  zIndex: 12 + stackLayer,
                }
              : isStackLane
                ? { zIndex: 10 }
                : isMain
                  ? { zIndex: 11 }
                  : undefined;
          return (
            <div
              key={channel.id}
              data-channel-id={channel.id}
              className={`channel-workspace-tile${widthClass}${stackLayer > 0 ? " workspace-tile-stacked" : ""}${!monitoring ? " channel-off" : ""}${
                moveChannelId === channel.id ? " moving" : ""
              }${resizeChannelId === channel.id ? " resizing" : ""
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
                onPointerDown={(e) => beginMove(e, channel.id)}
                title="Press and drag to move · bottom edge of another tile to stack"
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
