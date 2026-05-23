import type { WorkspaceDropEdge } from "./channelWorkspaceOrder";

/** Tiles whose tops are within this distance share a row (row-dense reading order). */
const ROW_CLUSTER_PX = 52;
/** Vertical padding when deciding which row the pointer is in. */
const ROW_BAND_PAD_Y = 44;
/** Horizontal padding for empty space beside a row. */
const ROW_BAND_PAD_X = 10;

type TileRect = {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
};

/** Gap below a tile where dropping means “stack under this channel”. */
const UNDER_GAP_PX = 88;

function readTileRects(root: HTMLElement, order: number[], excludeId: number | null): TileRect[] {
  const out: TileRect[] = [];
  for (const id of order) {
    if (id === excludeId) {
      continue;
    }
    const el = root.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
    if (!el) {
      continue;
    }
    const r = el.getBoundingClientRect();
    out.push({
      id,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      cx: r.left + r.width / 2,
    });
  }
  return out;
}

function rowBounds(row: TileRect[]): { top: number; bottom: number; left: number; right: number } {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const t of row) {
    top = Math.min(top, t.top);
    bottom = Math.max(bottom, t.bottom);
    left = Math.min(left, t.left);
    right = Math.max(right, t.right);
  }
  return { top, bottom, left, right };
}

/** Group tiles into horizontal rows (top-to-bottom), each sorted left-to-right. */
function clusterRows(tiles: TileRect[]): TileRect[][] {
  if (tiles.length === 0) {
    return [];
  }
  const sorted = [...tiles].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: TileRect[][] = [];
  for (const tile of sorted) {
    let placed = false;
    for (const row of rows) {
      const ref = row[0]!;
      const sameRow =
        Math.abs(tile.top - ref.top) <= ROW_CLUSTER_PX ||
        (tile.top < ref.bottom && tile.bottom > ref.top);
      if (sameRow) {
        row.push(tile);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([tile]);
    }
  }
  for (const row of rows) {
    row.sort((a, b) => a.left - b.left);
  }
  rows.sort((a, b) => a[0]!.top - b[0]!.top);
  return rows;
}

/** Reading order for row-dense grid: left-to-right within each row, then the next row. */
export function rowMajorOrderFromDom(
  root: HTMLElement,
  order: number[],
  excludeId: number | null = null,
): number[] {
  const tiles = readTileRects(root, order, excludeId);
  return clusterRows(tiles).flatMap((row) => row.map((t) => t.id));
}

/** @deprecated Use rowMajorOrderFromDom — kept for imports during transition. */
export const columnMajorOrderFromDom = rowMajorOrderFromDom;

/** Pick the row band that best matches the pointer Y. */
function pickRowIndex(rows: TileRect[][], clientY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const { top, bottom } = rowBounds(rows[i]!);
    if (clientY >= top - ROW_BAND_PAD_Y && clientY <= bottom + ROW_BAND_PAD_Y) {
      return i;
    }
  }
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const { top, bottom } = rowBounds(rows[i]!);
    const cy = (top + bottom) / 2;
    const dist = Math.abs(clientY - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Drop target for row-dense layout: respects empty space to the right/left of a row,
 * gaps between tiles, and vertical gaps between rows (not only the first column).
 */
export function findWorkspaceDropTarget(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  order: number[],
  excludeId: number | null,
): { targetId: number; edge: WorkspaceDropEdge } | null {
  const tiles = readTileRects(root, order, excludeId);
  if (tiles.length === 0) {
    return null;
  }

  const rows = clusterRows(tiles);

  for (let i = 0; i < rows.length - 1; i++) {
    const curr = rowBounds(rows[i]!);
    const nextTop = rowBounds(rows[i + 1]!).top;
    if (clientY > curr.bottom && clientY < nextTop) {
      const mid = (curr.bottom + nextTop) / 2;
      if (clientY < mid) {
        const last = rows[i]![rows[i]!.length - 1]!;
        return { targetId: last.id, edge: "under" };
      }
      const first = rows[i + 1]![0]!;
      return { targetId: first.id, edge: "before" };
    }
  }

  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;
  const firstBounds = rowBounds(firstRow);
  const lastBounds = rowBounds(lastRow);

  if (clientY < firstBounds.top - ROW_BAND_PAD_Y) {
    return { targetId: firstRow[0]!.id, edge: "before" };
  }
  if (clientY > lastBounds.bottom + ROW_BAND_PAD_Y) {
    return { targetId: lastRow[lastRow.length - 1]!.id, edge: "after" };
  }

  const rowIdx = pickRowIndex(rows, clientY);
  const row = rows[rowIdx]!;
  const band = rowBounds(row);

  for (let i = 0; i < row.length; i++) {
    const tile = row[i]!;
    const next = row[i + 1];

    if (
      clientX >= tile.left &&
      clientX <= tile.right &&
      clientY >= tile.top &&
      clientY <= tile.bottom
    ) {
      const midX = tile.left + (tile.right - tile.left) / 2;
      return { targetId: tile.id, edge: clientX < midX ? "before" : "after" };
    }

    if (next && clientX > tile.right && clientX < next.left) {
      const midX = (tile.right + next.left) / 2;
      return clientX < midX
        ? { targetId: tile.id, edge: "after" }
        : { targetId: next.id, edge: "before" };
    }

    const underBottom = next
      ? Math.min(tile.bottom + UNDER_GAP_PX, next.top)
      : tile.bottom + UNDER_GAP_PX;
    if (
      clientY > tile.bottom &&
      clientY <= underBottom &&
      clientX >= tile.left - ROW_BAND_PAD_X &&
      clientX <= tile.right + ROW_BAND_PAD_X
    ) {
      return { targetId: tile.id, edge: "under" };
    }
  }

  const first = row[0]!;
  const last = row[row.length - 1]!;

  if (
    clientY >= band.top - ROW_BAND_PAD_Y &&
    clientY <= band.bottom + ROW_BAND_PAD_Y &&
    clientX < band.left - ROW_BAND_PAD_X
  ) {
    return { targetId: first.id, edge: "before" };
  }

  if (
    clientY >= band.top - ROW_BAND_PAD_Y &&
    clientY <= band.bottom + ROW_BAND_PAD_Y &&
    clientX > band.right + ROW_BAND_PAD_X
  ) {
    return { targetId: last.id, edge: "after" };
  }

  let nearest = row[0]!;
  let nearestDist = Infinity;
  for (const tile of row) {
    const dx = clientX < tile.cx ? tile.left - clientX : clientX - tile.right;
    const dy =
      clientY < tile.top ? tile.top - clientY : clientY > tile.bottom ? clientY - tile.bottom : 0;
    const dist = dx * dx + dy * dy;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = tile;
    }
  }
  return {
    targetId: nearest.id,
    edge: clientX < nearest.cx ? "before" : "after",
  };
}

/**
 * Row-major insert index from pointer — works in empty gaps beside/between channels,
 * not only when hovering directly on a tile.
 */
export function computeInsertIndexFromPointer(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  channelIds: number[],
  excludeId: number | null = null,
): number {
  const visual = rowMajorOrderFromDom(root, channelIds, excludeId);
  const drop = findWorkspaceDropTarget(root, clientX, clientY, visual, excludeId);
  if (drop) {
    const idx = visual.indexOf(drop.targetId);
    if (idx >= 0) {
      return drop.edge === "before" ? idx : idx + 1;
    }
  }

  const tiles = readTileRects(root, channelIds, excludeId);
  if (tiles.length === 0) {
    return 0;
  }

  const rows = clusterRows(tiles);
  const rowIdx = pickRowIndex(rows, clientY);
  let insertAt = 0;
  for (let i = 0; i < rowIdx; i++) {
    insertAt += rows[i]!.length;
  }

  const row = rows[rowIdx]!;
  const band = rowBounds(row);

  if (clientX > band.right + ROW_BAND_PAD_X) {
    return insertAt + row.length;
  }

  for (const tile of row) {
    if (clientX > tile.right + ROW_BAND_PAD_X / 2) {
      insertAt += 1;
    } else {
      break;
    }
  }

  return Math.max(0, Math.min(insertAt, visual.length));
}

/** Insert index when dropping a rail channel onto the workspace (row-major). */
export function insertIndexFromPointer(
  clientX: number,
  clientY: number,
  root: HTMLElement,
  channelIds: number[],
): number {
  return computeInsertIndexFromPointer(root, clientX, clientY, channelIds, null);
}

/** Build dock order after moving a channel to the pointer insert index. */
export function orderFromInsertIndex(
  channelIds: number[],
  sourceId: number,
  insertAt: number,
): number[] {
  const without = channelIds.filter((id) => id !== sourceId);
  const at = Math.max(0, Math.min(insertAt, without.length));
  return [...without.slice(0, at), sourceId, ...without.slice(at)];
}

/** Apply row-major order after preview insert (for commit on drop). */
export function orderAfterDrop(
  visualOrder: number[],
  sourceId: number,
  targetId: number,
  edge: WorkspaceDropEdge,
): number[] {
  const without = visualOrder.filter((id) => id !== sourceId);
  let insertAt = without.indexOf(targetId);
  if (insertAt < 0) {
    return [...without, sourceId];
  }
  if (edge === "after" || edge === "under") {
    insertAt += 1;
  }
  return [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
}
