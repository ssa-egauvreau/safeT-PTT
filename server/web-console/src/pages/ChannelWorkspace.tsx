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
  cycleWorkspaceTileSize,
  getWorkspaceTile,
  moveWorkspaceTileToEnd,
  reorderWorkspaceTile,
  useConsoleState,
  workspaceColsForWidth,
  workspaceTierFromRowSpan,
  workspaceTileSize,
  type WorkspaceTileLayout,
  type WorkspaceWidgetSize,
} from "../consoleStore";

type DropEdge = "before" | "after";

const SIZE_LABEL: Record<WorkspaceWidgetSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
};
const NEXT_SIZE_TITLE: Record<WorkspaceWidgetSize, string> = {
  small: "Small widget — tap to make medium",
  medium: "Medium widget — tap to make large",
  large: "Large widget — tap to make small",
};

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

  // Track the live widget-column count (1 on phones, up to 2 otherwise) so a 2-wide widget clamps
  // to a single full-width column on a narrow screen.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      setCols(gridCols(root));
      return;
    }
    const update = () => setCols(gridCols(root));
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

  return (
    <section
      ref={rootRef}
      className={`channel-workspace-rows channel-workspace-grid${dockDragOver ? " drag-over" : ""}`}
      aria-label="Channel workspace"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: "auto",
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
            Drag ⋮⋮ to reorder · tap the size badge to switch widget size (small · medium · large).
          </p>
        </div>
      ) : (
        dockedChannels.map((channel) => {
          const tile = tilesById.get(channel.id) ?? getWorkspaceTile(channel.id);
          const size = workspaceTileSize(tile);
          const colSpan = Math.max(1, Math.min(tile.colSpan, cols));
          const monitoring = open.includes(channel.id);
          const isOver = dragOverChannelId === channel.id && dropEdge;
          return (
            <div
              key={channel.id}
              data-channel-id={channel.id}
              className={`channel-workspace-tile widget-${size}${!monitoring ? " channel-off" : ""}${
                moveChannelId === channel.id ? " moving" : ""
              }${isOver ? ` drag-over drop-${dropEdge}` : ""}`}
              style={{ gridColumn: `span ${colSpan}` }}
            >
              <div
                className="channel-workspace-drag-handle"
                onPointerDown={(e) => beginMove(e, channel.id)}
              >
                <span className="channel-workspace-drag-grip" aria-hidden>
                  ⋮⋮
                </span>
                <button
                  type="button"
                  className="channel-workspace-size-btn"
                  title={NEXT_SIZE_TITLE[size]}
                  aria-label={NEXT_SIZE_TITLE[size]}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => cycleWorkspaceTileSize(channel.id)}
                >
                  {SIZE_LABEL[size]}
                </button>
              </div>
              <div className="channel-workspace-tile-inner">
                <ChannelPanel
                  channel={channel}
                  layout="workspace"
                  workspaceTier={workspaceTierFromRowSpan(tile.rowSpan)}
                  workspaceWide={colSpan >= 2}
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
            </div>
          );
        })
      )}
    </section>
  );
}
