import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";
import type { LayoutItem } from "react-grid-layout/legacy";
import { WidgetBoard } from "../components/WidgetBoard";
import { ChannelRailDragFollower } from "../components/ChannelRailDragFollower";
import type { UserChannel } from "../api";
import { ChannelPanel } from "./ChannelPanel";
import { pointerToGridCell, rglLayoutFromStore } from "./workspaceGridLayout";
import {
  getRailDragPreview,
  subscribeRailDragPreview,
  setRailDragPreview,
} from "./workspaceRailDrag";
import {
  WORKSPACE_GRID_ROW_PX,
  applyWorkspaceRglLayout,
  cycleWorkspaceTileSize,
  getWorkspaceTile,
  syncWorkspaceTilesForViewport,
  useConsoleState,
  workspaceFootprintForSize,
  workspaceGridColsForWidth,
  workspaceTileFootprintLabel,
  workspaceTileSize,
  type WorkspaceWidgetSize,
} from "../consoleStore";

const SIZE_LABEL: Record<WorkspaceWidgetSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

function nextSizeTitle(size: WorkspaceWidgetSize, gridCols: number): string {
  const foot = workspaceFootprintForSize(size, gridCols);
  const dim = `${foot.colSpan}×${foot.rowSpan}`;
  switch (size) {
    case "small":
      return `${dim} — compact. Tap for medium.`;
    case "medium":
      return `${dim} — Tap for large.`;
    default:
      return `${dim} — full panel. Tap for small.`;
  }
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gridCols, setGridCols] = useState(2);
  const [dockDragOver, setDockDragOver] = useState(false);
  const [railDragPointer, setRailDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [frontChannelId, setFrontChannelId] = useState<number | null>(null);

  const railDrag = useSyncExternalStore(
    subscribeRailDragPreview,
    getRailDragPreview,
    () => null,
  );

  const { workspaceLayout } = useConsoleState();
  const expandedIds = useMemo(() => dockedChannels.map((c) => c.id), [dockedChannels]);
  const byId = useMemo(() => new Map(dockedChannels.map((c) => [c.id, c])), [dockedChannels]);

  const rglLayout = useMemo(
    () => rglLayoutFromStore(expandedIds, workspaceLayout, gridCols),
    [expandedIds, workspaceLayout, gridCols],
  );

  const gridColsRef = useRef(0);

  const updateGridCols = useCallback(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const style = getComputedStyle(el);
    const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
    const padR = Number.parseFloat(style.paddingRight || "0") || 0;
    const inner = Math.max(0, el.clientWidth - padL - padR);
    const c = workspaceGridColsForWidth(inner);
    setGridCols(c);
    if (gridColsRef.current > 0 && gridColsRef.current !== c) {
      syncWorkspaceTilesForViewport(c);
    }
    gridColsRef.current = c;
  }, []);

  useEffect(() => {
    updateGridCols();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(updateGridCols);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateGridCols]);

  useEffect(() => {
    const clearRailDrag = () => setRailDragPreview(null);
    window.addEventListener("dragend", clearRailDrag);
    return () => window.removeEventListener("dragend", clearRailDrag);
  }, []);

  const persistLayout = useCallback(
    (layout: readonly LayoutItem[]) => {
      applyWorkspaceRglLayout([...layout], gridCols);
    },
    [gridCols],
  );

  const handleRailDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDockDragOver(true);
      setRailDragPointer({ x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleRailDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDockDragOver(false);
      setRailDragPointer(null);
      setRailDragPreview(null);
      const raw =
        e.dataTransfer.getData("text/channel-id") || e.dataTransfer.getData("text/plain");
      const id = Number(raw);
      const wrap = wrapRef.current;
      if (!Number.isFinite(id) || id <= 0 || !wrap) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const foot = workspaceFootprintForSize("large", gridCols);
      const cell = pointerToGridCell(
        wrap.clientWidth,
        e.clientX,
        e.clientY,
        rect.left,
        rect.top,
        gridCols,
      );
      onDockFromRail(id, {
        col: Math.max(0, Math.min(cell.col, gridCols - foot.colSpan)),
        row: cell.row,
      });
    },
    [dockedChannels, gridCols, onDockFromRail],
  );

  const railFollower =
    railDrag && railDragPointer && wrapRef.current && typeof document !== "undefined"
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
      <div
        ref={wrapRef}
        className={`channel-workspace-rgl-wrap${dockDragOver || railDrag ? " drag-over" : ""}`}
        onDragEnter={handleRailDragOver}
        onDragOver={handleRailDragOver}
        onDragLeave={(e) => {
          const wrap = wrapRef.current;
          if (wrap && e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) {
            return;
          }
          setDockDragOver(false);
          setRailDragPointer(null);
        }}
        onDrop={handleRailDrop}
      >
        <WidgetBoard
          className="channel-workspace-widget-board"
          cols={gridCols}
          rowHeight={WORKSPACE_GRID_ROW_PX}
          layout={rglLayout}
          onLayoutChange={persistLayout}
          dragHandleSelector=".ch-card-title-row"
          dropHighlight={dockDragOver || !!railDrag}
          emptyState={
            <>
              <p>Tap a channel in the list to open it here — or drag it in.</p>
              <p className="muted">
                S = 2×2 · M = 4×4 · L = 4×8. Drag the colored name bar to move.
              </p>
            </>
          }
          renderItem={(idStr) => {
            const channelId = Number(idStr);
            const channel = byId.get(channelId);
            if (!channel) {
              return null;
            }
            const tile = getWorkspaceTile(channelId);
            const size = workspaceTileSize(tile);
            const workspaceWide = tile.colSpan >= 2;
            const monitoring = open.includes(channelId);
            const isFront = frontChannelId === channelId || primary === channelId;

            return (
              <div
                data-channel-id={channelId}
                className={`channel-workspace-tile widget-${size}${!monitoring ? " channel-off" : ""}${
                  isFront ? " tile-front" : ""
                }`}
                title={`${channel.name} · ${workspaceTileFootprintLabel(tile)}`}
                onPointerDown={() => setFrontChannelId(channelId)}
              >
                <div className="channel-workspace-tile-inner">
                  <ChannelPanel
                    channel={channel}
                    layout="workspace"
                    workspaceWidgetSize={size}
                    workspaceWide={workspaceWide}
                    monitoring={monitoring}
                    expanded
                    primary={primary === channelId}
                    pttCode={pttCode}
                    keyboardOn={keyboardOn}
                    onToggleMonitor={() => onToggleMonitor(channelId)}
                    onToggleExpanded={() => onUndock(channelId)}
                    onMakePrimary={() => onMakePrimary(channelId)}
                    workspaceChrome={{
                      sizeLabel: SIZE_LABEL[size],
                      sizeTitle: nextSizeTitle(size, gridCols),
                      onCycleSize: () => cycleWorkspaceTileSize(channelId, gridCols),
                      onClose: () => onUndock(channelId),
                      isDragging: false,
                    }}
                  />
                  {!monitoring && <div className="channel-off-overlay" aria-hidden />}
                </div>
              </div>
            );
          }}
        />
      </div>
    </>
  );
}
