/** Puzzle-grid packing for Mission Control (no store import — avoids cycles). */

export const PUZZLE_GRID_MIN_COLS = 2;
export const PUZZLE_GRID_MAX_COLS = 10;
export const PUZZLE_GRID_GAP_PX = 8;
export const PUZZLE_GRID_ROW_PX = 72;

export const PUZZLE_SMALL = { colSpan: 1, rowSpan: 1 } as const;
export const PUZZLE_MEDIUM = { colSpan: 2, rowSpan: 2 } as const;
export const PUZZLE_LARGE = { colSpan: 2, rowSpan: 4 } as const;

export type PuzzleTile = {
  colSpan: number;
  rowSpan: number;
  col: number;
  row: number;
};

export type GridCell = { col: number; row: number };

export type PlacedPuzzleTile = PuzzleTile & { channelId: number };

function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

export function buildOccupancy(
  tiles: PlacedPuzzleTile[],
  gridCols: number,
  skipChannelId: number | null = null,
): Set<string> {
  const occupied = new Set<string>();
  for (const tile of tiles) {
    if (tile.channelId === skipChannelId) {
      continue;
    }
    for (let dc = 0; dc < tile.colSpan; dc++) {
      for (let dr = 0; dr < tile.rowSpan; dr++) {
        const c = tile.col + dc;
        const r = tile.row + dr;
        if (c >= 0 && c < gridCols && r >= 0) {
          occupied.add(cellKey(c, r));
        }
      }
    }
  }
  return occupied;
}

export function canPlaceAt(
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
  gridCols: number,
  occupied: Set<string>,
): boolean {
  if (col < 0 || row < 0 || col + colSpan > gridCols) {
    return false;
  }
  for (let dc = 0; dc < colSpan; dc++) {
    for (let dr = 0; dr < rowSpan; dr++) {
      if (occupied.has(cellKey(col + dc, row + dr))) {
        return false;
      }
    }
  }
  return true;
}

export function firstOpenPlacement(
  colSpan: number,
  rowSpan: number,
  gridCols: number,
  occupied: Set<string>,
  startRow = 0,
  startCol = 0,
): GridCell | null {
  const maxScanRow = 80;
  for (let row = startRow; row < maxScanRow; row++) {
    const colStart = row === startRow ? startCol : 0;
    for (let col = colStart; col <= gridCols - colSpan; col++) {
      if (canPlaceAt(col, row, colSpan, rowSpan, gridCols, occupied)) {
        return { col, row };
      }
    }
  }
  return null;
}

export function placementNearPointer(
  preferCol: number,
  preferRow: number,
  colSpan: number,
  rowSpan: number,
  gridCols: number,
  occupied: Set<string>,
): GridCell | null {
  const pc = Math.max(0, Math.min(preferCol, gridCols - colSpan));
  const pr = Math.max(0, preferRow);
  if (canPlaceAt(pc, pr, colSpan, rowSpan, gridCols, occupied)) {
    return { col: pc, row: pr };
  }
  const maxRadius = 24;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let row = pr - radius; row <= pr + radius; row++) {
      if (row < 0) {
        continue;
      }
      for (let col = pc - radius; col <= pc + radius; col++) {
        if (Math.abs(col - pc) !== radius && Math.abs(row - pr) !== radius) {
          continue;
        }
        if (col < 0 || col + colSpan > gridCols) {
          continue;
        }
        if (canPlaceAt(col, row, colSpan, rowSpan, gridCols, occupied)) {
          return { col, row };
        }
      }
    }
  }
  return firstOpenPlacement(colSpan, rowSpan, gridCols, occupied);
}

export function pointerToGridCell(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  gridCols: number,
): GridCell {
  const rect = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const gap =
    Number.parseFloat(style.columnGap || style.gap || String(PUZZLE_GRID_GAP_PX)) ||
    PUZZLE_GRID_GAP_PX;
  const padL = Number.parseFloat(style.paddingLeft || "0") || 0;
  const padT = Number.parseFloat(style.paddingTop || "0") || 0;
  const innerW = Math.max(1, rect.width - padL - Number.parseFloat(style.paddingRight || "0"));
  const cellW = (innerW - (gridCols - 1) * gap) / gridCols;
  const rowUnit = Number.parseFloat(style.getPropertyValue("--ws-row-unit")) || PUZZLE_GRID_ROW_PX;
  const rowH = rowUnit + gap;

  const x = clientX - rect.left - padL;
  const y = clientY - rect.top - padT;
  const col = Math.max(0, Math.min(gridCols - 1, Math.floor(x / (cellW + gap))));
  const row = Math.max(0, Math.floor(y / rowH));
  return { col, row };
}

export function gridStyleForTile(tile: PuzzleTile): { gridColumn: string; gridRow: string } {
  return {
    gridColumn: `${tile.col + 1} / span ${tile.colSpan}`,
    gridRow: `${tile.row + 1} / span ${tile.rowSpan}`,
  };
}

export function maxGridRow(tiles: PlacedPuzzleTile[]): number {
  let max = 0;
  for (const t of tiles) {
    max = Math.max(max, t.row + t.rowSpan);
  }
  return max;
}

export function packTilesInOrder(
  expanded: number[],
  footprints: Map<number, { colSpan: number; rowSpan: number }>,
  gridCols: number,
): Map<number, PuzzleTile> {
  const cols = Math.max(PUZZLE_GRID_MIN_COLS, Math.min(PUZZLE_GRID_MAX_COLS, gridCols));
  const occupied = new Set<string>();
  const out = new Map<number, PuzzleTile>();

  for (const id of expanded) {
    const foot = footprints.get(id) ?? PUZZLE_MEDIUM;
    const place = firstOpenPlacement(foot.colSpan, foot.rowSpan, cols, occupied);
    if (!place) {
      continue;
    }
    const next: PuzzleTile = { ...foot, col: place.col, row: place.row };
    out.set(id, next);
    for (let dc = 0; dc < next.colSpan; dc++) {
      for (let dr = 0; dr < next.rowSpan; dr++) {
        occupied.add(cellKey(place.col + dc, place.row + dr));
      }
    }
  }
  return out;
}

export function ghostWidthPx(
  colSpan: number,
  gridCols: number,
  containerInnerWidth: number,
  gap = PUZZLE_GRID_GAP_PX,
): number {
  const cols = Math.max(1, gridCols);
  const cellW = (containerInnerWidth - (cols - 1) * gap) / cols;
  return colSpan * cellW + (colSpan - 1) * gap;
}
