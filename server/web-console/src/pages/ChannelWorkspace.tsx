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
import {
  buildOccupancy,
  gridStyleForTile,
  maxGridRow,
  placementNearPointer,
  pointerToGridCell,
  type GridCell,
  type PlacedPuzzleTile,
} from "./workspacePuzzleGrid";
import {
  getRailDragPreview,
  railDragPreviewFromChannel,
  subscribeRailDragPreview,
  setRailDragPreview,
  workspacePreviewForChannel,
} from "./workspaceRailDrag";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_GRID_ROW_PX,
  cycleWorkspaceTileSize,
  getWorkspaceTile,
  placeWorkspaceTile,
  syncWorkspaceTilesForViewport,
  useConsoleState,
  workspaceGridColsForWidth,
  workspacePresetForSize,
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

const WORKSPACE_DRAG_THRESHOLD_PX = 4;

function nextSizeTitle(size: WorkspaceWidgetSize): string {
  switch (size) {
    case "small":
      return "1×1 cell — compact. Tap for medium (2×2).";
    case "medium":
      return "2×2 cells — last message + tones. Tap for large (2×4).";
    default:
      return "2×4 cells — full panel + users. Tap for small (1×1).";
  }
}

function readGridCols(root: HTMLElement | null): number {
  if (!root) {
    return 2;
  }
  const style = getComputedStyle(root);
  const gap =
    Number.parseFloat(style.columnGap || style.gap || String(WORKSPACE_GRID_GAP_PX)) ||
    WORKSPACE_GRID_GAP_PX;
  const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
  const padR = Number.parseFloat(style.paddingRight || "0") || 0;
  const inner = Math.max(0, root.clientWidth - padL - padR);
  return workspaceGridColsForWidth(inner, gap);
}

function placedTiles(
  channels: UserChannel[],
  layout: Map<number, WorkspaceTileLayout>,
): PlacedPuzzleTile[] {
  return channels.map((c) => {
    const tile = layout.get(c.id)!;
    return { channelId: c.id, ...tile };
  });
}

function resolvePlacement(
  root: HTMLElement,
  gridCols: number,
  footprint: { colSpan: number; rowSpan: number },
  placed: PlacedPuzzleTile[],
  clientX: number,
  clientY: number,
  skipId: number | null,
): GridCell | null {
  const cell = pointerToGridCell(root, clientX, clientY, gridCols);
  const occupied = buildOccupancy(placed, gridCols, skipId);
  return placementNearPointer(cell.col, cell.row, footprint.colSpan, footprint.rowSpan, gridCols, occupied);
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
  onDockFromRail: (id: number, at?: { col: number; row: number }) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [gridCols, setGridCols] = useState(2);
  const [dockDragOver, setDockDragOver] = useState(false);
  const [moveChannelId, setMoveChannelId] = useState<number | null>(null);
  const moveChannelIdRef = useRef<number | null>(null);
  moveChannelIdRef.current = moveChannelId;
  const [previewCell, setPreviewCell] = useState<GridCell | null>(null);
  const [railDragPointer, setRailDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [workspaceDragPointer, setWorkspaceDragPointer] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [frontChannelId, setFrontChannelId] = useState<number | null>(null);

  const railDrag = useSyncExternalStore(
    subscribeRailDragPreview,
    getRailDragPreview,
    () => null,
  );

  const { workspaceLayout } = useConsoleState();

  const tilesById = useMemo(() => {
    const map = new Map<number, WorkspaceTileLayout>();
    for (const channel of dockedChannels) {
      map.set(channel.id, getWorkspaceTile(channel.id));
    }
    return map;
  }, [dockedChannels, workspaceLayout]);

  const sortedChannels = useMemo(() => {
    return [...dockedChannels].sort((a, b) => {
      const ta = tilesById.get(a.id)!;
      const tb = tilesById.get(b.id)!;
      return ta.row - tb.row || ta.col - tb.col || a.name.localeCompare(b.name);
    });
  }, [dockedChannels, tilesById]);

  const gridRowCount = useMemo(() => {
    const placed = placedTiles(sortedChannels, tilesById);
    const moving = moveChannelId ? tilesById.get(moveChannelId) : null;
    let rows = maxGridRow(placed);
    if (previewCell && moving) {
      rows = Math.max(rows, previewCell.row + moving.rowSpan);
    }
    return Math.max(4, rows + 1);
  }, [sortedChannels, tilesById, previewCell, moveChannelId]);

  const reorderDragPreview = useMemo(() => {
    if (moveChannelId === null) {
      return null;
    }
    const channel = dockedChannels.find((c) => c.id === moveChannelId);
    if (!channel) {
      return null;
    }
    const tile = tilesById.get(moveChannelId) ?? getWorkspaceTile(moveChannelId);
    return railDragPreviewFromChannel(channel, tile, gridCols);
  }, [moveChannelId, dockedChannels, tilesById, gridCols]);

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
      setPreviewCell(null);
      setWorkspaceDragPointer(null);
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
      const c = readGridCols(root);
      setGridCols(c);
      syncWorkspaceTilesForViewport(c);
      return;
    }
    const update = () => {
      const c = readGridCols(root);
      setGridCols(c);
      syncWorkspaceTilesForViewport(c);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const acceptRailDrop = railDrag !== null || dockDragOver;

  const handleRailDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDockDragOver(true);
    setRailDragPointer({ x: e.clientX, y: e.clientY });
    const root = rootRef.current;
    if (!root || !railDrag) {
      return;
    }
    const foot = workspacePresetForSize(railDrag.size);
    const placed = placedTiles(sortedChannels, tilesById);
    const at = resolvePlacement(root, gridCols, foot, placed, e.clientX, e.clientY, null);
    setPreviewCell(at);
  }, [railDrag, sortedChannels, tilesById, gridCols]);

  const handleRailDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDockDragOver(false);
      setRailDragPointer(null);
      setRailDragPreview(null);
      setPreviewCell(null);
      const raw =
        e.dataTransfer.getData("text/channel-id") || e.dataTransfer.getData("text/plain");
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0 || !rootRef.current) {
        return;
      }
      const root = rootRef.current;
      const channel = dockedChannels.find((c) => c.id === id);
      const { size } = workspacePreviewForChannel(
        channel ?? { id, name: "", color: null, simulcast: false } as UserChannel,
        !!channel,
      );
      const foot = workspacePresetForSize(size);
      const placed = placedTiles(sortedChannels, tilesById);
      const at =
        resolvePlacement(root, gridCols, foot, placed, e.clientX, e.clientY, null) ??
        previewCell;
      onDockFromRail(id, at ?? undefined);
    },
    [dockedChannels, sortedChannels, tilesById, gridCols, previewCell, onDockFromRail],
  );

  function bringTileToFront(channelId: number) {
    setFrontChannelId(channelId);
    setRailDragPreview(null);
  }

  function beginMove(e: PointerEvent<HTMLDivElement>, channelId: number) {
    if (e.button !== 0) {
      return;
    }
    const target = e.target;
    if (
      target instanceof Element &&
      target.closest(".ch-card-chrome, .channel-workspace-size-btn, .ch-workspace-close, button")
    ) {
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
        setWorkspaceDragPointer({ x: ev.clientX, y: ev.clientY });
      }
      setWorkspaceDragPointer({ x: ev.clientX, y: ev.clientY });
      const root = rootRef.current;
      const tile = tilesById.get(channelId);
      if (!root || !tile) {
        return;
      }
      const others = placedTiles(
        sortedChannels.filter((c) => c.id !== channelId),
        tilesById,
      );
      const at = resolvePlacement(root, gridCols, tile, others, ev.clientX, ev.clientY, channelId);
      setPreviewCell(at);
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
      const tile = tilesById.get(channelId);
      if (root && tile) {
        const others = placedTiles(
          sortedChannels.filter((c) => c.id !== channelId),
          tilesById,
        );
        const at =
          resolvePlacement(root, gridCols, tile, others, ev.clientX, ev.clientY, channelId) ??
          previewCell;
        if (at) {
          placeWorkspaceTile(channelId, at.col, at.row, gridCols);
        }
      }
      setMoveChannelId(null);
      setPreviewCell(null);
      setWorkspaceDragPointer(null);
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
    const workspaceWide = tile.colSpan >= 2;
    const monitoring = open.includes(channel.id);
    const isFront = frontChannelId === channel.id || primary === channel.id;
    const gridPos = gridStyleForTile(tile);

    return (
      <div
        key={channel.id}
        data-channel-id={channel.id}
        className={`channel-workspace-tile widget-${size}${!monitoring ? " channel-off" : ""}${
          isFront ? " tile-front" : ""
        }`}
        style={gridPos}
        title={`${channel.name} · ${workspaceTileFootprintLabel(tile)}`}
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
              sizeTitle: nextSizeTitle(size),
              onCycleSize: () => cycleWorkspaceTileSize(channel.id, gridCols),
              onClose: () => onUndock(channel.id),
              onDragPointerDown: (e) => beginMove(e, channel.id),
              isDragging: false,
            }}
          />
          {!monitoring && <div className="channel-off-overlay" aria-hidden />}
        </div>
      </div>
    );
  }

  function renderPlaceholder(tile: { colSpan: number; rowSpan: number; col: number; row: number }, key: string) {
    return (
      <div
        key={key}
        className="channel-workspace-drop-placeholder"
        style={gridStyleForTile(tile)}
        aria-hidden
      />
    );
  }

  const gridChildren: ReactNode[] = [];
  for (const channel of sortedChannels) {
    if (channel.id === moveChannelId) {
      continue;
    }
    gridChildren.push(renderTile(channel));
  }

  if (previewCell) {
    const ph =
      moveChannelId !== null
        ? tilesById.get(moveChannelId)
        : railDrag
          ? workspacePresetForSize(railDrag.size)
          : null;
    if (ph) {
      gridChildren.push(
        renderPlaceholder(
          { ...ph, col: previewCell.col, row: previewCell.row },
          moveChannelId !== null ? "reorder-placeholder" : "rail-placeholder",
        ),
      );
    }
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

  const reorderFollower =
    reorderDragPreview && workspaceDragPointer && typeof document !== "undefined"
      ? createPortal(
          <ChannelRailDragFollower
            preview={reorderDragPreview}
            clientX={workspaceDragPointer.x}
            clientY={workspaceDragPointer.y}
          />,
          document.body,
        )
      : null;

  return (
    <>
      {railFollower}
      {reorderFollower}
      <section
        ref={rootRef}
        className={`channel-workspace-rows channel-workspace-grid${
          acceptRailDrop ? " drag-over accepting-rail-drop" : ""
        }${moveChannelId !== null ? " reordering" : ""}`}
        aria-label="Channel workspace"
        style={{
          gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${gridRowCount}, var(--ws-row-unit))`,
          ["--ws-cols" as string]: String(gridCols),
          ["--ws-row-unit" as string]: `${WORKSPACE_GRID_ROW_PX}px`,
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
          setPreviewCell(null);
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
              Puzzle grid: S = 1×1 · M = 2×2 · L = 2×4. Drag the colored name bar to move.
            </p>
          </div>
        ) : (
          gridChildren
        )}
      </section>
    </>
  );
}
