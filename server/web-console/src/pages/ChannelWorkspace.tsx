import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import { previewWorkspaceOrder, type WorkspaceDropEdge } from "./channelWorkspaceOrder";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MIN_COL_PX,
  cycleWorkspaceTileSize,
  getWorkspaceTile,
  moveWorkspaceTileToEnd,
  reorderWorkspaceTile,
  syncWorkspaceTilesForViewport,
  useConsoleState,
  workspaceColsForWidth,
  workspaceTileFootprintLabel,
  workspaceTileSize,
  type WorkspaceTileLayout,
  type WorkspaceWidgetSize,
} from "../consoleStore";

const SIZE_LABEL: Record<WorkspaceWidgetSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

function nextSizeTitle(size: WorkspaceWidgetSize, tile: WorkspaceTileLayout): string {
  const foot = workspaceTileFootprintLabel(tile);
  switch (size) {
    case "small":
      return `${foot} — compact. Tap for medium (1×2 or 2×2).`;
    case "medium":
      return `${foot} — last message + tones. Tap for large (1×3 or 2×3).`;
    default:
      return `${foot} — full panel + users. Tap for small (1×1).`;
  }
}

/** Live widget-column count from the grid element's width. */
function gridCols(root: HTMLElement | null): number {
  if (!root) {
    return 1;
  }
  const style = getComputedStyle(root);
  const gap =
    Number.parseFloat(style.columnGap || style.gap || String(WORKSPACE_GRID_GAP_PX)) ||
    WORKSPACE_GRID_GAP_PX;
  const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
  const padR = Number.parseFloat(style.paddingRight || "0") || 0;
  const inner = Math.max(0, root.clientWidth - padL - padR);
  return workspaceColsForWidth(inner, gap);
}

function edgeFromPointer(clientX: number, tileEl: HTMLElement): WorkspaceDropEdge {
  const rect = tileEl.getBoundingClientRect();
  return clientX - rect.left < rect.width / 2 ? "before" : "after";
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
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<WorkspaceDropEdge | null>(null);
  const [insertAtEnd, setInsertAtEnd] = useState(false);
  const [cols, setCols] = useState(1);

  const { workspaceLayout } = useConsoleState();
  const channelIds = useMemo(() => dockedChannels.map((c) => c.id), [dockedChannels]);
  const byId = useMemo(() => new Map(dockedChannels.map((c) => [c.id, c])), [dockedChannels]);

  const tilesById = useMemo(() => {
    const map = new Map<number, WorkspaceTileLayout>();
    for (const channel of dockedChannels) {
      map.set(channel.id, getWorkspaceTile(channel.id));
    }
    return map;
  }, [dockedChannels, workspaceLayout]);

  const previewIds = useMemo(
    () =>
      previewWorkspaceOrder(
        channelIds,
        moveChannelId,
        dragOverChannelId,
        dropEdge,
        insertAtEnd,
      ),
    [channelIds, moveChannelId, dragOverChannelId, dropEdge, insertAtEnd],
  );

  const displayChannels = useMemo(
    () =>
      previewIds
        .map((id) => byId.get(id))
        .filter((c): c is UserChannel => c !== undefined),
    [previewIds, byId],
  );

  const placeholderIndex =
    moveChannelId !== null ? previewIds.indexOf(moveChannelId) : -1;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      const c = gridCols(root);
      setCols(c);
      syncWorkspaceTilesForViewport(c);
      return;
    }
    const update = () => {
      const c = gridCols(root);
      setCols(c);
      syncWorkspaceTilesForViewport(c);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  function clearDragOver() {
    setDragOverChannelId(null);
    setDropEdge(null);
    setInsertAtEnd(false);
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
        return;
      }
      const insertAt = insertIndexFromPointer(e.clientX, e.clientY, rootRef.current, channelIds);
      onDockFromRail(id, insertAt);
    },
    [channelIds, onDockFromRail],
  );

  function beginMove(e: PointerEvent<HTMLDivElement>, channelId: number) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setMoveChannelId(channelId);
    clearDragOver();

    const onMove = (ev: globalThis.PointerEvent) => {
      const root = rootRef.current;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = hit?.closest<HTMLElement>("[data-channel-id]");
      const id = tile ? Number(tile.dataset.channelId) : NaN;
      if (tile && Number.isFinite(id) && id !== channelId) {
        setInsertAtEnd(false);
        setDragOverChannelId(id);
        setDropEdge(edgeFromPointer(ev.clientX, tile));
      } else if (root && hit && root.contains(hit)) {
        clearDragOver();
        setInsertAtEnd(true);
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

  function renderTile(channel: UserChannel): ReactNode {
    const tile = tilesById.get(channel.id) ?? getWorkspaceTile(channel.id);
    const size = workspaceTileSize(tile);
    const colSpan = Math.max(1, Math.min(tile.colSpan, cols));
    const workspaceWide = colSpan >= 2;
    const monitoring = open.includes(channel.id);
    const footprint = workspaceTileFootprintLabel(tile);
    const isDragging = moveChannelId === channel.id;
    const isDropTarget =
      !isDragging && dragOverChannelId === channel.id && dropEdge !== null;
    return (
      <div
        key={channel.id}
        data-channel-id={channel.id}
        className={`channel-workspace-tile widget-${size}${!monitoring ? " channel-off" : ""}${
          isDragging ? " moving" : ""
        }${isDropTarget ? ` drag-target drop-${dropEdge}` : ""}`}
        style={{ gridColumn: `span ${colSpan}` }}
        title={`${channel.name} · ${footprint}`}
      >
        <div className="channel-workspace-tile-inner">
          <ChannelPanel
            channel={channel}
            layout="workspace"
            workspaceWidgetSize={size}
            workspaceWide={workspaceWide}
            monitoring={monitoring}
            expanded
            primary={primary === channel.id}
            pttCode={pttCode}
            keyboardOn={keyboardOn}
            onToggleMonitor={() => onToggleMonitor(channel.id)}
            onToggleExpanded={() => onUndock(channel.id)}
            onMakePrimary={() => onMakePrimary(channel.id)}
            workspaceChrome={{
              sizeLabel: SIZE_LABEL[size],
              sizeTitle: nextSizeTitle(size, tile),
              onCycleSize: () => cycleWorkspaceTileSize(channel.id, cols),
              onClose: () => onUndock(channel.id),
              onDragPointerDown: (e) => beginMove(e, channel.id),
              isDragging,
            }}
          />
          {!monitoring && <div className="channel-off-overlay" aria-hidden />}
        </div>
      </div>
    );
  }

  function renderDropPlaceholder(colSpan: number, key: string): ReactNode {
    return (
      <div
        key={key}
        className="channel-workspace-drop-placeholder"
        style={{ gridColumn: `span ${colSpan}` }}
        aria-hidden
      />
    );
  }

  const gridChildren: ReactNode[] = [];
  if (moveChannelId !== null && placeholderIndex >= 0) {
    const movingTile = tilesById.get(moveChannelId);
    const phSpan = movingTile
      ? Math.max(1, Math.min(movingTile.colSpan, cols))
      : 1;
    displayChannels.forEach((channel, index) => {
      if (index === placeholderIndex) {
        gridChildren.push(renderDropPlaceholder(phSpan, "drop-placeholder"));
      }
      gridChildren.push(renderTile(channel));
    });
  } else {
    displayChannels.forEach((channel) => {
      gridChildren.push(renderTile(channel));
    });
  }

  return (
    <section
      ref={rootRef}
      className={`channel-workspace-rows channel-workspace-grid${
        dockDragOver ? " drag-over" : ""
      }${moveChannelId !== null ? " reordering" : ""}`}
      aria-label="Channel workspace"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${WORKSPACE_MIN_COL_PX}px), 1fr))`,
      }}
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
            Drag the channel name bar to reorder (tiles stack in columns) · S / M / L · ✕ close.
          </p>
        </div>
      ) : (
        gridChildren
      )}
    </section>
  );
}
