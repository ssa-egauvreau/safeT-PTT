import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MAX_COLS,
  WORKSPACE_MIN_COL_PX,
  WORKSPACE_ROW_PX,
  clampWorkspaceColSpan,
  getWorkspaceTile,
  moveWorkspaceTileToEnd,
  reorderWorkspaceTile,
  setWorkspaceTileColSpan,
  setWorkspaceTileRowSpan,
  snapWorkspaceRowSpan,
  useConsoleState,
  workspaceColsForWidth,
  workspaceTierFromRowSpan,
  type WorkspaceTileLayout,
} from "../consoleStore";

type DropEdge = "before" | "after";

/** Live column count + one track's pixel width from the grid element. */
function gridMetrics(root: HTMLElement | null): { cols: number; colPx: number } {
  if (!root) {
    return { cols: 1, colPx: WORKSPACE_MIN_COL_PX };
  }
  const style = getComputedStyle(root);
  const gap =
    Number.parseFloat(style.columnGap || style.gap || String(WORKSPACE_GRID_GAP_PX)) ||
    WORKSPACE_GRID_GAP_PX;
  const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
  const padR = Number.parseFloat(style.paddingRight || "0") || 0;
  const inner = Math.max(0, root.clientWidth - padL - padR);
  const cols = workspaceColsForWidth(inner, gap);
  const colPx = (inner - gap * (cols - 1)) / cols;
  return { cols, colPx: colPx > 0 ? colPx : WORKSPACE_MIN_COL_PX };
}

/** Reading-order insert index for a rail channel dropped on the workspace. */
function insertIndexFromPointer(
  clientX: number,
  clientY: number,
  root: HTMLElement,
  channelIds: number[],
): number {
  type Entry = { idx: number; midX: number; midY: number; top: number };
  const entries: Entry[] = [];
  channelIds.forEach((id, idx) => {
    const el = root.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
    if (!el) {
      return;
    }
    const r = el.getBoundingClientRect();
    entries.push({ idx, midX: r.left + r.width / 2, midY: r.top + r.height / 2, top: r.top });
  });
  entries.sort((a, b) => a.top - b.top || a.midX - b.midX);
  for (const e of entries) {
    if (clientY < e.midY && clientX < e.midX) {
      return e.idx;
    }
    if (clientY < e.top) {
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
  const [moveChannelId, setMoveChannelId] = useState<number | null>(null);
  const [resizeChannelId, setResizeChannelId] = useState<number | null>(null);
  const [resizePreview, setResizePreview] = useState<WorkspaceTileLayout | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
  const [cols, setCols] = useState(1);

  const { workspaceLayout } = useConsoleState();
  const channelIds = useMemo(() => dockedChannels.map((c) => c.id), [dockedChannels]);

  const tilesById = useMemo(() => {
    const map = new Map<number, WorkspaceTileLayout>();
    for (const channel of dockedChannels) {
      map.set(channel.id, getWorkspaceTile(channel.id));
    }
    return map;
  }, [dockedChannels, workspaceLayout]);

  // Track how many equal tracks currently fit so spans can be clamped (and so the layout reflows to
  // a single column on phones, where every tile then spans the full width).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      setCols(gridMetrics(root).cols);
      return;
    }
    const update = () => setCols(gridMetrics(root).cols);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  function clearDragOver() {
    setDragOverChannelId(null);
    setDropEdge(null);
  }

  const handleRailDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDockDragOver(false);
      clearDragOver();
      const id = Number(e.dataTransfer.getData("text/channel-id"));
      if (!Number.isFinite(id) || id <= 0 || !rootRef.current) {
        return;
      }
      if (channelIds.includes(id)) {
        return; // in-workspace moves use the drag handle (pointer), not the rail DnD
      }
      const insertAt = insertIndexFromPointer(e.clientX, e.clientY, rootRef.current, channelIds);
      onDockFromRail(id, insertAt);
    },
    [channelIds, onDockFromRail],
  );

  function edgeFromPointer(clientX: number, tileEl: HTMLElement): DropEdge {
    const rect = tileEl.getBoundingClientRect();
    return clientX - rect.left < rect.width / 2 ? "before" : "after";
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

    const onMove = (ev: globalThis.PointerEvent) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = hit?.closest<HTMLElement>("[data-channel-id]");
      const id = tile ? Number(tile.dataset.channelId) : NaN;
      if (tile && Number.isFinite(id) && id !== channelId) {
        setDragOverChannelId(id);
        setDropEdge(edgeFromPointer(ev.clientX, tile));
      } else {
        clearDragOver();
      }
    };

    const onEnd = (ev: globalThis.PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = hit?.closest<HTMLElement>("[data-channel-id]");
      const targetId = tile ? Number(tile.dataset.channelId) : NaN;
      if (tile && Number.isFinite(targetId) && targetId !== channelId) {
        reorderWorkspaceTile(channelId, targetId, edgeFromPointer(ev.clientX, tile));
      } else if (rootRef.current && hit && rootRef.current.contains(hit)) {
        moveWorkspaceTileToEnd(channelId);
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
    const { cols: liveCols, colPx } = gridMetrics(rootRef.current);
    const maxCols = Math.min(WORKSPACE_MAX_COLS, Math.max(1, liveCols));
    setResizeChannelId(channelId);
    setResizePreview({ rowSpan: origin.rowSpan, colSpan: Math.min(origin.colSpan, maxCols) });
    let liveRowSpan = origin.rowSpan;
    let liveColSpan = Math.min(origin.colSpan, maxCols);

    const onMove = (ev: globalThis.PointerEvent) => {
      if (axis === "height" || axis === "both") {
        const deltaRow = Math.round((ev.clientY - startY) / WORKSPACE_ROW_PX);
        liveRowSpan = snapWorkspaceRowSpan(origin.rowSpan + deltaRow);
      }
      if (axis === "width" || axis === "both") {
        const deltaCol = Math.round((ev.clientX - startX) / colPx);
        liveColSpan = Math.max(1, Math.min(maxCols, clampWorkspaceColSpan(origin.colSpan + deltaCol)));
      }
      setResizePreview({ rowSpan: liveRowSpan, colSpan: liveColSpan });
    };
    const onEnd = (ev: globalThis.PointerEvent) => {
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
      onDrop={handleRailDrop}
    >
      {dockedChannels.length === 0 ? (
        <div className="channel-workspace-empty">
          <p>Tap a channel in the list to open it here — or drag it in.</p>
          <p className="muted">
            Drag ⋮⋮ to reorder · drag a tile’s right or bottom edge to resize · tiles fill and wrap to
            fit the space.
          </p>
        </div>
      ) : (
        dockedChannels.map((channel) => {
          const tile = tilesById.get(channel.id) ?? getWorkspaceTile(channel.id);
          const resizing = resizeChannelId === channel.id && resizePreview !== null;
          const rowSpan = resizing ? resizePreview.rowSpan : tile.rowSpan;
          const storedColSpan = resizing ? resizePreview.colSpan : tile.colSpan;
          const colSpan = Math.max(1, Math.min(storedColSpan, cols));
          const monitoring = open.includes(channel.id);
          const isOver = dragOverChannelId === channel.id && dropEdge;
          return (
            <div
              key={channel.id}
              data-channel-id={channel.id}
              className={`channel-workspace-tile${colSpan > 1 ? " workspace-tile-wide" : ""}${
                !monitoring ? " channel-off" : ""
              }${moveChannelId === channel.id ? " moving" : ""}${
                resizeChannelId === channel.id ? " resizing" : ""
              }${isOver ? ` drag-over drop-${dropEdge}` : ""}`}
              style={{
                gridColumn: `span ${colSpan}`,
                gridRow: `span ${rowSpan}`,
              }}
            >
              <div
                className="channel-workspace-drag-handle"
                onPointerDown={(e) => beginMove(e, channel.id)}
                title="Drag to reorder"
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
