import type { LayoutItem } from "react-grid-layout/legacy";
import type { WorkspaceTileLayout, WorkspaceWidgetSize } from "../consoleStore";
import {
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_GRID_ROW_PX,
  workspacePresetForSize,
  workspaceTileSize,
} from "../consoleStore";

export const RGL_MARGIN: [number, number] = [WORKSPACE_GRID_GAP_PX, WORKSPACE_GRID_GAP_PX];
export const RGL_CONTAINER_PADDING: [number, number] = [12, 12];

export function layoutKey(id: number): string {
  return String(id);
}

/** react-grid-layout item for one channel tile. */
export function rglItemFromTile(
  channelId: number,
  tile: WorkspaceTileLayout,
  gridCols: number,
): LayoutItem {
  const w = Math.min(tile.colSpan, gridCols);
  return {
    i: layoutKey(channelId),
    x: Math.max(0, Math.min(tile.col, Math.max(0, gridCols - w))),
    y: Math.max(0, tile.row),
    w,
    h: tile.rowSpan,
    minW: 1,
    minH: 1,
    maxW: gridCols,
    maxH: 4,
    static: false,
  };
}

export function tileFromRglItem(item: LayoutItem): WorkspaceTileLayout {
  return {
    col: item.x,
    row: item.y,
    colSpan: item.w,
    rowSpan: item.h,
  };
}

export function rglLayoutFromStore(
  expanded: number[],
  workspaceLayout: Record<string, WorkspaceTileLayout>,
  gridCols: number,
): LayoutItem[] {
  return expanded.map((id) => {
    const key = layoutKey(id);
    const stored = workspaceLayout[key];
    const size = stored ? workspaceTileSize(stored) : ("medium" as WorkspaceWidgetSize);
    const preset = workspacePresetForSize(size);
    const tile: WorkspaceTileLayout = stored
      ? { ...stored, colSpan: Math.min(stored.colSpan, gridCols), rowSpan: stored.rowSpan }
      : { ...preset, col: 0, row: 0 };
    return rglItemFromTile(id, tile, gridCols);
  });
}

/** Pointer position → top-left grid cell (for rail HTML5 drop). */
export function pointerToGridCell(
  containerWidth: number,
  clientX: number,
  clientY: number,
  containerLeft: number,
  containerTop: number,
  gridCols: number,
  rowHeight = WORKSPACE_GRID_ROW_PX,
): { col: number; row: number } {
  const pad = RGL_CONTAINER_PADDING[0];
  const gap = RGL_MARGIN[0];
  const innerW = Math.max(1, containerWidth - pad * 2);
  const cellW = (innerW - (gridCols - 1) * gap) / gridCols;
  const rowH = rowHeight + gap;
  const x = clientX - containerLeft - pad;
  const y = clientY - containerTop - pad;
  const col = Math.max(0, Math.min(gridCols - 1, Math.floor(x / (cellW + gap))));
  const row = Math.max(0, Math.floor(y / rowH));
  return { col, row };
}

export function ghostWidthPx(colSpan: number, gridCols: number, containerInnerWidth: number): number {
  const cols = Math.max(1, gridCols);
  const gap = RGL_MARGIN[0];
  const cellW = (containerInnerWidth - (cols - 1) * gap) / cols;
  return colSpan * cellW + (colSpan - 1) * gap;
}
