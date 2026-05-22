import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChannelRailDragFollower } from "../components/ChannelRailDragFollower";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import { previewWorkspaceOrder, type WorkspaceDropEdge } from "./channelWorkspaceOrder";
import {
  findWorkspaceDropTarget,
  insertIndexFromPointer,
  orderAfterDrop,
  rowMajorOrderFromDom,
} from "./channelWorkspaceDrag";
import {
  getRailDragPreview,
  subscribeRailDragPreview,
  setRailDragPreview,
} from "./workspaceRailDrag";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MIN_COL_PX,
  cycleWorkspaceTileSize,
  getWorkspaceTile,
  moveWorkspaceTileToEnd,
  setWorkspaceChannelOrder,
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

/** Pixels the pointer must move before a title-bar press becomes a drag (avoids “click to hide”). */
const WORKSPACE_DRAG_THRESHOLD_PX = 6;

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
  const moveChannelIdRef = useRef<number | null>(null);
  moveChannelIdRef.current = moveChannelId;
  const [dockDragOver, setDockDragOver] = useState(false);
  const [moveChannelId, setMoveChannelId] = useState<number | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<WorkspaceDropEdge | null>(null);
  const [insertAtEnd, setInsertAtEnd] = useState(false);
  const [dragLayoutOrder, setDragLayoutOrder] = useState<number[]>([]);
  const [railDragPointer, setRailDragPointer] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [cols, setCols] = useState(1);
  /** Tile the user last clicked — kept above neighbors so it does not look hidden. */
  const [frontChannelId, setFrontChannelId] = useState<number | null>(null);

  const railDrag = useSyncExternalStore(
    subscribeRailDragPreview,
    getRailDragPreview,
    () => null,
  );

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

  const orderForPreview =
    moveChannelId !== null && dragLayoutOrder.length > 0 ? dragLayoutOrder : channelIds;

  const previewIds = useMemo(
    () =>
      previewWorkspaceOrder(
        orderForPreview,
        moveChannelId,
        dragOverChannelId,
        dropEdge,
        insertAtEnd,
      ),
    [orderForPreview, moveChannelId, dragOverChannelId, dropEdge, insertAtEnd],
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
    const clearRailDrag = () => setRailDragPreview(null);
    window.addEventListener("dragend", clearRailDrag);
    return () => window.removeEventListener("dragend", clearRailDrag);
  }, []);

  useEffect(() => {
    function clearStuckReorder() {
      if (moveChannelIdRef.current === null) {
        return;
      }
      setMoveChannelId(null);
      setDragLayoutOrder([]);
      clearDragOver();
    }
    window.addEventListener("pointerup", clearStuckReorder);
    window.addEventListener("pointercancel", clearStuckReorder);
    return () => {
      window.removeEventListener("pointerup", clearStuckReorder);
      window.removeEventListener("pointercancel", clearStuckReorder);
    };
  }, []);

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

  const acceptRailDrop = railDrag !== null || dockDragOver;

  const handleRailDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDockDragOver(true);
    setRailDragPointer({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRailDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDockDragOver(false);
      setRailDragPointer(null);
      setRailDragPreview(null);
      clearDragOver();
      const raw =
        e.dataTransfer.getData("text/channel-id") || e.dataTransfer.getData("text/plain");
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0 || !rootRef.current) {
        return;
      }
      const insertAt = insertIndexFromPointer(e.clientX, e.clientY, rootRef.current, channelIds);
      onDockFromRail(id, insertAt);
    },
    [channelIds, onDockFromRail],
  );

  function bringTileToFront(channelId: number) {
    setFrontChannelId(channelId);
    setRailDragPreview(null);
  }

  function beginMove(e: PointerEvent<HTMLDivElement>, channelId: number) {
    if (e.button !== 0) {
      return;
    }
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const thresholdSq = WORKSPACE_DRAG_THRESHOLD_PX * WORKSPACE_DRAG_THRESHOLD_PX;

    const onMove = (ev: globalThis.PointerEvent) => {
      if (!dragging) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (dx * dx + dy * dy < thresholdSq) {
          return;
        }
        dragging = true;
        ev.preventDefault();
        handle.setPointerCapture(ev.pointerId);
        setMoveChannelId(channelId);
        clearDragOver();
        const rootAtStart = rootRef.current;
        if (rootAtStart) {
          setDragLayoutOrder(rowMajorOrderFromDom(rootAtStart, channelIds, channelId));
        }
      }
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const visual = rowMajorOrderFromDom(root, channelIds, channelId);
      setDragLayoutOrder(visual);
      const drop = findWorkspaceDropTarget(root, ev.clientX, ev.clientY, visual, channelId);
      if (drop) {
        setInsertAtEnd(false);
        setDragOverChannelId(drop.targetId);
        setDropEdge(drop.edge);
      } else {
        const rootRect = root.getBoundingClientRect();
        const inRoot =
          ev.clientX >= rootRect.left &&
          ev.clientX <= rootRect.right &&
          ev.clientY >= rootRect.top &&
          ev.clientY <= rootRect.bottom;
        clearDragOver();
        if (inRoot) {
          setInsertAtEnd(true);
        }
      }
    };

    const onEnd = (ev: globalThis.PointerEvent) => {
      if (dragging) {
        handle.releasePointerCapture(ev.pointerId);
      }
      if (!dragging) {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        return;
      }
      const root = rootRef.current;
      if (!root) {
        setMoveChannelId(null);
        setDragLayoutOrder([]);
        clearDragOver();
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        return;
      }
      const visual = rowMajorOrderFromDom(root, channelIds, channelId);
      const drop = findWorkspaceDropTarget(root, ev.clientX, ev.clientY, visual, channelId);
      if (drop) {
        setWorkspaceChannelOrder(
          orderAfterDrop(visual, channelId, drop.targetId, drop.edge),
        );
      } else {
        const rootRect = root.getBoundingClientRect();
        const inRoot =
          ev.clientX >= rootRect.left &&
          ev.clientX <= rootRect.right &&
          ev.clientY >= rootRect.top &&
          ev.clientY <= rootRect.bottom;
        if (inRoot) {
          moveWorkspaceTileToEnd(channelId);
        }
      }
      setMoveChannelId(null);
      setDragLayoutOrder([]);
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
    const isFront = frontChannelId === channel.id || primary === channel.id;
    const isDropTarget =
      dragOverChannelId === channel.id && dropEdge !== null;
    return (
      <div
        key={channel.id}
        data-channel-id={channel.id}
        className={`channel-workspace-tile widget-${size}${!monitoring ? " channel-off" : ""}${
          isFront ? " tile-front" : ""
        }${isDragging ? " moving" : ""}${
          isDropTarget
            ? ` drag-target drop-${dropEdge}${dropEdge === "after" ? " drop-stack-under" : ""}`
            : ""
        }`}
        style={{ gridColumn: `span ${colSpan}` }}
        title={`${channel.name} · ${footprint}`}
      >
        <div
          className="channel-workspace-tile-inner"
          onPointerDown={() => bringTileToFront(channel.id)}
        >
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
  } else if (railDrag && dockDragOver) {
    const phSpan = Math.max(1, Math.min(railDrag.colSpan, cols));
    const insertAt =
      rootRef.current && railDragPointer
        ? insertIndexFromPointer(
            railDragPointer.x,
            railDragPointer.y,
            rootRef.current,
            channelIds,
          )
        : channelIds.length;
    displayChannels.forEach((channel, index) => {
      if (index === insertAt) {
        gridChildren.push(renderDropPlaceholder(phSpan, "rail-drop-placeholder"));
      }
      gridChildren.push(renderTile(channel));
    });
    if (insertAt >= displayChannels.length) {
      gridChildren.push(renderDropPlaceholder(phSpan, "rail-drop-placeholder-end"));
    }
  } else {
    displayChannels.forEach((channel) => {
      gridChildren.push(renderTile(channel));
    });
  }

  const railFollower =
    railDrag && railDragPointer && typeof document !== "undefined"
      ? createPortal(
          <ChannelRailDragFollower
            preview={railDrag}
            clientX={railDragPointer.x}
            clientY={railDragPointer.y}
          />,
          document.body,
        )
      : null;

  return (
    <>
    {railFollower}
    <section
      ref={rootRef}
      className={`channel-workspace-rows channel-workspace-grid${
        acceptRailDrop ? " drag-over accepting-rail-drop" : ""
      }${moveChannelId !== null ? " reordering" : ""}`}
      aria-label="Channel workspace"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(${WORKSPACE_MIN_COL_PX}px, 1fr))`,
      }}
      onDragEnter={handleRailDragOver}
      onDragOver={handleRailDragOver}
      onDragLeave={(e) => {
        const root = rootRef.current;
        if (root && e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) {
          return;
        }
        setDockDragOver(false);
        setRailDragPointer(null);
      }}
      onDrop={handleRailDrop}
      onPointerDown={() => {
        if (!dockDragOver) {
          setRailDragPreview(null);
        }
      }}
    >
      {dockedChannels.length === 0 ? (
        <div className="channel-workspace-empty">
          <p>Tap a channel in the list to open it here — or drag it in.</p>
          <p className="muted">
            Drag the name bar to reorder — drop beside or below a channel · S / M / L · ✕.
          </p>
        </div>
      ) : (
        gridChildren
      )}
    </section>
    </>
  );
}
