// Shared, cross-window console state — which channels are open, the keyboard
// PTT binding, and shortcut on/off. The console and each pop-out window run in
// separate JavaScript contexts, so the source of truth lives in localStorage
// and changes propagate between windows via the "storage" event.

import { useSyncExternalStore } from "react";
import { packTilesInOrder } from "./pages/workspacePuzzleGrid";
import {
  DEFAULT_PTT_CODE,
  KEYBOARD_ENABLED_KEY,
  LAST_CHANNEL_KEY,
  OPEN_CHANNELS_KEY,
  PTT_CODE_KEY,
} from "./pages/consoleShared";

const STATE_KEY = "securityradio.console.state";

/** Bump when workspace layout rules change — triggers one-time localStorage migration. */
const CURRENT_LAYOUT_VERSION = 18;
const MAX_STATE_STORAGE_BYTES = 256 * 1024;
const MAX_OPEN_CHANNELS = 16;
const MAX_DOCKED_CHANNELS = 12;
/**
 * Effective caps applied on every commit to keep Mission Control stable — too many tiles at once
 * can freeze the tab (black screen) on reload. Kept below the looser dedup ceilings above. Raise
 * cautiously and re-test reload performance with the higher counts.
 */
export const MAX_SAFE_DOCKED_CHANNELS = 8;
const MAX_SAFE_OPEN_CHANNELS = 10;
const COMMIT_STORM_LIMIT = 24;
const COMMIT_STORM_WINDOW_MS = 2000;

/**
 * One channel tile on the workspace puzzle grid (fixed cell units):
 *   - small:  2×2
 *   - medium: 4×4 (width clamps on narrow screens)
 *   - large:  4×7 (width clamps on narrow screens)
 */
export interface WorkspaceTileLayout {
  colSpan: number;
  rowSpan: number;
  /** Top-left column (0-based) on the grid. */
  col: number;
  /** Top-left row (0-based) on the grid. */
  row: number;
}

export type WorkspaceWidgetSize = "small" | "medium" | "large";

/** Puzzle grid: minimum columns (phone) and maximum (wide desktop). */
export const WORKSPACE_GRID_MIN_COLS = 2;
export const WORKSPACE_GRID_MAX_COLS = 16;
/** Target cell width used to pick column count from container width. */
export const WORKSPACE_GRID_CELL_PX = 88;
/** Grid gap (px); kept in sync with layout math. */
export const WORKSPACE_GRID_GAP_PX = 8;
/** Height of one grid row unit (px) — one “box” tall in the widget grid. */
export const WORKSPACE_GRID_ROW_PX = 68;
/** @deprecated Use WORKSPACE_GRID_CELL_PX — kept for older imports. */
export const WORKSPACE_MIN_COL_PX = WORKSPACE_GRID_CELL_PX;
/** @deprecated Use WORKSPACE_GRID_MAX_COLS. */
export const WORKSPACE_MAX_COLS = WORKSPACE_GRID_MAX_COLS;
/** @deprecated Use WORKSPACE_GRID_ROW_PX. */
export const WORKSPACE_GRID_ROW_MIN_PX = WORKSPACE_GRID_ROW_PX;

export const WORKSPACE_SMALL_COLS = 2;
export const WORKSPACE_SMALL_ROWS = 2;
export const WORKSPACE_MEDIUM_COLS = 4;
export const WORKSPACE_MEDIUM_ROWS = 4;
export const WORKSPACE_LARGE_COLS = 4;
export const WORKSPACE_LARGE_ROWS = 7;

/** New tiles dock as large (4×8) when opened from the rail or dropped on the workspace. */
export const WORKSPACE_DEFAULT_WIDGET_SIZE: WorkspaceWidgetSize = "large";
export const WORKSPACE_WIDGET_SIZES: readonly WorkspaceWidgetSize[] = ["small", "medium", "large"];

/** Footprint for S / M / L (grid cell units). */
export function workspacePresetForSize(size: WorkspaceWidgetSize): Pick<WorkspaceTileLayout, "colSpan" | "rowSpan"> {
  switch (size) {
    case "small":
      return { colSpan: WORKSPACE_SMALL_COLS, rowSpan: WORKSPACE_SMALL_ROWS };
    case "large":
      return { colSpan: WORKSPACE_LARGE_COLS, rowSpan: WORKSPACE_LARGE_ROWS };
    default:
      return { colSpan: WORKSPACE_MEDIUM_COLS, rowSpan: WORKSPACE_MEDIUM_ROWS };
  }
}

export function workspaceTileSize(tile: Pick<WorkspaceTileLayout, "colSpan" | "rowSpan">): WorkspaceWidgetSize {
  if (tile.rowSpan >= WORKSPACE_LARGE_ROWS - 1) {
    return "large";
  }
  if (tile.rowSpan >= WORKSPACE_MEDIUM_ROWS) {
    return "medium";
  }
  return "small";
}

/** Footprint for a size on the current column count (large clamps to grid width). */
export function workspaceFootprintForSize(
  size: WorkspaceWidgetSize,
  gridCols: number,
): Pick<WorkspaceTileLayout, "colSpan" | "rowSpan"> {
  const preset = workspacePresetForSize(size);
  return {
    colSpan: Math.min(preset.colSpan, Math.max(WORKSPACE_GRID_MIN_COLS, gridCols)),
    rowSpan: preset.rowSpan,
  };
}

export function workspaceTileFootprintLabel(tile: Pick<WorkspaceTileLayout, "colSpan" | "rowSpan">): string {
  return `${tile.colSpan}×${tile.rowSpan}`;
}

/**
 * How many puzzle columns fit at this inner width (2 on phone → 16 max).
 * Above the phone size the count snaps to multiples of 4 — the width of an
 * M/L tile — so rows tile the full width (2, 3, or 4 panels across) with no
 * dead columns on the right; cells stretch to absorb the remainder instead.
 */
export function workspaceGridColsForWidth(width: number, gap = WORKSPACE_GRID_GAP_PX): number {
  if (!Number.isFinite(width) || width <= 0) {
    return WORKSPACE_GRID_MIN_COLS;
  }
  const raw = Math.floor((width + gap) / (WORKSPACE_GRID_CELL_PX + gap));
  if (raw < WORKSPACE_MEDIUM_COLS) {
    return WORKSPACE_GRID_MIN_COLS;
  }
  const snapped = Math.floor(raw / WORKSPACE_MEDIUM_COLS) * WORKSPACE_MEDIUM_COLS;
  return Math.min(WORKSPACE_GRID_MAX_COLS, snapped);
}

/** @deprecated Use workspaceGridColsForWidth. */
export function workspaceColsForWidth(width: number, gap = WORKSPACE_GRID_GAP_PX): number {
  return workspaceGridColsForWidth(width, gap);
}

/**
 * Column count last measured by a mounted ChannelWorkspace. Packing helpers
 * default to this so click-to-dock / undock re-pack for the grid that is
 * actually on screen (falls back to the max when no workspace is mounted).
 */
let viewportGridCols: number | null = null;

export function setWorkspaceViewportCols(cols: number): void {
  if (Number.isFinite(cols) && cols >= WORKSPACE_GRID_MIN_COLS) {
    viewportGridCols = Math.min(WORKSPACE_GRID_MAX_COLS, Math.round(cols));
  }
}

function packGridCols(): number {
  return viewportGridCols ?? WORKSPACE_GRID_MAX_COLS;
}

export interface ConsoleState {
  /** Channel ids with live voice connected ("on" / monitoring). */
  open: number[];
  /** Channel ids whose full control surface is expanded (independent of on/off). */
  expanded: number[];
  /** The channel the keyboard PTT key controls, or null. Always a monitoring channel. */
  primary: number | null;
  /** KeyboardEvent.code bound to push-to-talk. */
  pttCode: string;
  /** Whether console keyboard shortcuts are active. */
  keyboardOn: boolean;
  /** Docked channel positions on the workspace grid (channel id → tile). */
  workspaceLayout: Record<string, WorkspaceTileLayout>;
  /** Bumped when layout rules change; old saved data is reset automatically. */
  layoutVersion?: number;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];
}

function withValidPrimary(open: number[], primary: unknown): number | null {
  if (typeof primary === "number" && open.includes(primary)) {
    return primary;
  }
  return open.length > 0 ? open[open.length - 1]! : null;
}

function parseWorkspaceLayout(raw: unknown): Record<string, WorkspaceTileLayout> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, WorkspaceTileLayout> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      continue;
    }
    const t = val as Record<string, unknown>;
    const colSpan = Number(t.colSpan);
    const rowSpan = Number(t.rowSpan);
    const col = Number(t.col);
    const row = Number(t.row);
    if (Number.isFinite(colSpan) && Number.isFinite(rowSpan)) {
      const size = workspaceTileSize({ colSpan, rowSpan });
      const preset = workspacePresetForSize(size);
      out[key] = {
        ...preset,
        col: Number.isFinite(col) ? Math.max(0, Math.round(col)) : 0,
        row: Number.isFinite(row) ? Math.max(0, Math.round(row)) : 0,
      };
    }
  }
  return out;
}

function parse(raw: string | null): ConsoleState | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const open = numbers(value.open);
    return {
      open,
      // Pre-redesign state has no "expanded" — keep continuity by expanding the
      // channels that were already open (shown as full panels) on first load.
      expanded: Array.isArray(value.expanded) ? numbers(value.expanded) : [...open],
      primary: withValidPrimary(open, value.primary),
      pttCode: typeof value.pttCode === "string" && value.pttCode ? value.pttCode : DEFAULT_PTT_CODE,
      keyboardOn: typeof value.keyboardOn === "boolean" ? value.keyboardOn : true,
      workspaceLayout: parseWorkspaceLayout(value.workspaceLayout),
      layoutVersion:
        typeof value.layoutVersion === "number" && Number.isFinite(value.layoutVersion)
          ? value.layoutVersion
          : 0,
    };
  } catch {
    return null;
  }
}

/** Builds the initial state from the pre-pop-out localStorage keys. */
function migrate(): ConsoleState {
  let open: number[] = [];
  try {
    open = numbers(JSON.parse(localStorage.getItem(OPEN_CHANNELS_KEY) ?? "null"));
  } catch {
    /* fall through to the legacy single-channel key */
  }
  if (open.length === 0) {
    const last = Number(localStorage.getItem(LAST_CHANNEL_KEY));
    if (Number.isFinite(last) && last > 0) {
      open = [last];
    }
  }
  return {
    open,
    expanded: [...open],
    primary: open.length > 0 ? open[0]! : null,
    pttCode: localStorage.getItem(PTT_CODE_KEY) || DEFAULT_PTT_CODE,
    keyboardOn: localStorage.getItem(KEYBOARD_ENABLED_KEY) !== "0",
    workspaceLayout: {},
    layoutVersion: CURRENT_LAYOUT_VERSION,
  };
}

function dedupeIds(ids: number[], max: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function workspaceLayoutForExpanded(
  expanded: number[],
  layout: Record<string, WorkspaceTileLayout>,
): Record<string, WorkspaceTileLayout> {
  const out: Record<string, WorkspaceTileLayout> = {};
  for (const id of expanded) {
    const tile = layout[layoutKey(id)];
    if (tile) {
      out[layoutKey(id)] = tile;
    }
  }
  return out;
}

/** Footprint matches canonical S / M / L (not viewport-clamped width). */
function tileFootprintIsValid(tile: WorkspaceTileLayout): boolean {
  const size = workspaceTileSize(tile);
  const preset = workspacePresetForSize(size);
  return tile.colSpan === preset.colSpan && tile.rowSpan === preset.rowSpan;
}

/** Tile origin fits on a grid with this many columns (width may clamp in the UI). */
function tileFitsGridCols(tile: WorkspaceTileLayout, gridCols: number): boolean {
  const w = Math.min(tile.colSpan, gridCols);
  return (
    Number.isFinite(tile.col) &&
    Number.isFinite(tile.row) &&
    tile.col >= 0 &&
    tile.row >= 0 &&
    tile.col + w <= gridCols
  );
}

function tileIsValid(tile: WorkspaceTileLayout, gridCols: number): boolean {
  return tileFootprintIsValid(tile) && tileFitsGridCols(tile, gridCols);
}

function layoutFootprints(
  expanded: number[],
  layout: Record<string, WorkspaceTileLayout>,
): Map<number, { colSpan: number; rowSpan: number }> {
  const map = new Map<number, { colSpan: number; rowSpan: number }>();
  for (const id of expanded) {
    const prev = layout[layoutKey(id)];
    const size = prev ? workspaceTileSize(prev) : WORKSPACE_DEFAULT_WIDGET_SIZE;
    map.set(id, workspacePresetForSize(size));
  }
  return map;
}

function packLayout(
  expanded: number[],
  layout: Record<string, WorkspaceTileLayout>,
  gridCols: number,
): Record<string, WorkspaceTileLayout> {
  const packed = packTilesInOrder(expanded, layoutFootprints(expanded, layout), gridCols);
  const out: Record<string, WorkspaceTileLayout> = {};
  for (const id of expanded) {
    const tile = packed.get(id);
    if (tile) {
      out[layoutKey(id)] = tile;
    }
  }
  return out;
}

/**
 * Fixes saved Mission Control data from older builds (stale grid slots, extra keys, duplicates).
 * Incognito works because it skips this baggage; normal Chrome loads it from localStorage.
 */
function normalizeConsoleState(input: ConsoleState): ConsoleState {
  const open = dedupeIds(input.open, MAX_OPEN_CHANNELS);
  const expanded = dedupeIds(input.expanded, MAX_DOCKED_CHANNELS);
  let workspaceLayout = workspaceLayoutForExpanded(expanded, input.workspaceLayout);
  const version = input.layoutVersion ?? 0;
  const needsLayoutReset =
    version < CURRENT_LAYOUT_VERSION ||
    Object.values(workspaceLayout).some((t) => !tileIsValid(t, WORKSPACE_GRID_MAX_COLS)) ||
    Object.keys(input.workspaceLayout).length > expanded.length + 2;

  if (needsLayoutReset) {
    workspaceLayout = {};
  }

  // Too many docked channels at once can freeze the tab (black screen) on reload. Cap purely on the
  // counts — NOT on the layout version: a version bump only migrates tile sizing and must not
  // truncate a user's docked / monitored channels.
  let safeOpen = open;
  let safeExpanded = expanded;
  if (safeExpanded.length > MAX_SAFE_DOCKED_CHANNELS || safeOpen.length > MAX_SAFE_OPEN_CHANNELS) {
    safeExpanded = safeExpanded.slice(0, MAX_SAFE_DOCKED_CHANNELS);
    safeOpen = safeOpen.slice(0, MAX_SAFE_OPEN_CHANNELS);
    workspaceLayout = workspaceLayoutForExpanded(safeExpanded, workspaceLayout);
  }

  return {
    open: safeOpen,
    expanded: safeExpanded,
    primary: withValidPrimary(open, input.primary),
    pttCode: input.pttCode || DEFAULT_PTT_CODE,
    keyboardOn: input.keyboardOn,
    workspaceLayout,
    layoutVersion: CURRENT_LAYOUT_VERSION,
  };
}

function stateSnapshotEqual(a: ConsoleState, b: ConsoleState): boolean {
  return (
    expandedOrderEqual(a.open, b.open) &&
    expandedOrderEqual(a.expanded, b.expanded) &&
    a.primary === b.primary &&
    a.pttCode === b.pttCode &&
    a.keyboardOn === b.keyboardOn &&
    (a.layoutVersion ?? 0) === (b.layoutVersion ?? 0) &&
    workspaceLayoutEqual(a.workspaceLayout, b.workspaceLayout)
  );
}

function defaultConsoleState(): ConsoleState {
  return withPackedWorkspaceLayout({
    open: [],
    expanded: [],
    primary: null,
    pttCode: DEFAULT_PTT_CODE,
    keyboardOn: true,
    workspaceLayout: {},
    layoutVersion: CURRENT_LAYOUT_VERSION,
  });
}

/** Runs before reading state — `?console_reset=1` on the URL clears broken saved data. */
function applyConsoleResetFromUrl(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("console_reset") !== "1") {
      return;
    }
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(OPEN_CHANNELS_KEY);
    localStorage.removeItem(LAST_CHANNEL_KEY);
    params.delete("console_reset");
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  } catch {
    /* ignore */
  }
}

function readStoredStateRaw(): string | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw && raw.length > MAX_STATE_STORAGE_BYTES) {
      console.warn("[Mission Control] Saved console state was too large and has been cleared.");
      localStorage.removeItem(STATE_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function loadInitialState(): ConsoleState {
  applyConsoleResetFromUrl();
  try {
    const parsed = parse(readStoredStateRaw()) ?? migrate();
    return withPackedWorkspaceLayout(normalizeConsoleState(parsed));
  } catch (err) {
    console.error("[Mission Control] Could not load saved console state:", err);
    try {
      localStorage.removeItem(STATE_KEY);
    } catch {
      /* ignore */
    }
    return defaultConsoleState();
  }
}

/** Write migrated state to disk once — does not notify React (avoids startup render loops). */
function persistInitialStateSync(snapshot: ConsoleState): void {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const stored = parse(raw);
    if (stored && stateSnapshotEqual(snapshot, withPackedWorkspaceLayout(normalizeConsoleState(stored)))) {
      return;
    }
    localStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
    clearLegacyConsoleKeys();
  } catch {
    /* ignore */
  }
}

let state: ConsoleState = loadInitialState();
const listeners = new Set<() => void>();
let commitsInWindow = 0;
let commitWindowStart = 0;

if (typeof window !== "undefined") {
  persistInitialStateSync(state);
}

function clearLegacyConsoleKeys(): void {
  try {
    localStorage.removeItem(OPEN_CHANNELS_KEY);
    localStorage.removeItem(LAST_CHANNEL_KEY);
  } catch {
    /* ignore */
  }
}

function commit(next: ConsoleState): void {
  let normalized = withPackedWorkspaceLayout(normalizeConsoleState(next));
  if (stateSnapshotEqual(state, normalized)) {
    return;
  }

  const now = Date.now();
  if (now - commitWindowStart > COMMIT_STORM_WINDOW_MS) {
    commitsInWindow = 0;
    commitWindowStart = now;
  }
  commitsInWindow += 1;
  if (commitsInWindow > COMMIT_STORM_LIMIT) {
    console.warn(
      "[Mission Control] Too many layout saves — resetting channel workspace to stop a tab sync loop.",
    );
    normalized = withPackedWorkspaceLayout(
      normalizeConsoleState({
        ...normalized,
        workspaceLayout: {},
      }),
    );
    commitsInWindow = 0;
  }

  state = normalized;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    clearLegacyConsoleKeys();
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  // Another window (a pop-out, or the console) changed the shared state.
  window.addEventListener("storage", (event) => {
    if (event.key !== STATE_KEY || event.newValue == null) {
      return;
    }
    const parsed = parse(event.newValue);
    if (!parsed) {
      return;
    }
    const next = withPackedWorkspaceLayout(normalizeConsoleState(parsed));
    if (stateSnapshotEqual(state, next)) {
      return;
    }
    state = next;
    listeners.forEach((listener) => listener());
  });
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Subscribes a component to the shared console state. */
export function useConsoleState(): ConsoleState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Turns a channel's live voice on or off. Turning on makes it the keyboard-PTT primary. */
export function setChannelMonitoring(id: number, on: boolean): void {
  if (on) {
    const open = state.open.includes(id) ? state.open : [...state.open, id];
    commit({ ...state, open, primary: id });
  } else {
    if (!state.open.includes(id)) {
      return;
    }
    const open = state.open.filter((x) => x !== id);
    const primary = state.primary === id ? (open[open.length - 1] ?? null) : state.primary;
    commit({ ...state, open, primary });
  }
}

function layoutKey(id: number): string {
  return String(id);
}

function expandedOrderEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function workspaceLayoutEqual(
  a: Record<string, WorkspaceTileLayout>,
  b: Record<string, WorkspaceTileLayout>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    const ta = a[key];
    const tb = b[key];
    if (
      !ta ||
      !tb ||
      ta.colSpan !== tb.colSpan ||
      ta.rowSpan !== tb.rowSpan ||
      ta.col !== tb.col ||
      ta.row !== tb.row
    ) {
      return false;
    }
  }
  return true;
}

function commitWorkspaceIfChanged(expanded: number[], workspaceLayout: Record<string, WorkspaceTileLayout>): void {
  if (
    expandedOrderEqual(expanded, state.expanded) &&
    workspaceLayoutEqual(workspaceLayout, state.workspaceLayout)
  ) {
    return;
  }
  commit({ ...state, expanded, workspaceLayout });
}

/**
 * Clears saved channel workspace / on-air layout (keeps login). Use when the page works in
 * incognito but glitches in normal Chrome — almost always stale localStorage.
 */
export function resetMissionControlSavedData(): void {
  commitsInWindow = 0;
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(OPEN_CHANNELS_KEY);
    localStorage.removeItem(LAST_CHANNEL_KEY);
  } catch {
    /* ignore */
  }
  state = defaultConsoleState();
  listeners.forEach((listener) => listener());
}

/** Normalizes the workspace layout to exactly the docked channels (called on every commit). */
function withPackedWorkspaceLayout(s: ConsoleState): ConsoleState {
  if (s.expanded.length === 0) {
    return { ...s, workspaceLayout: {} };
  }
  const cols = packGridCols();
  const carried: Record<string, WorkspaceTileLayout> = {};
  let needsPack = false;
  for (const id of s.expanded) {
    const key = layoutKey(id);
    const prev = s.workspaceLayout[key];
    if (prev && tileIsValid(prev, cols)) {
      carried[key] = prev;
    } else {
      needsPack = true;
    }
  }
  const workspaceLayout = needsPack
    ? packLayout(s.expanded, { ...s.workspaceLayout, ...carried }, cols)
    : workspaceLayoutForExpanded(s.expanded, carried);
  return { ...s, workspaceLayout };
}

export function getWorkspaceTile(id: number): WorkspaceTileLayout {
  const stored = state.workspaceLayout[layoutKey(id)];
  if (stored && tileIsValid(stored, WORKSPACE_GRID_MAX_COLS) && state.expanded.includes(id)) {
    return stored;
  }
  const preset = workspacePresetForSize(WORKSPACE_DEFAULT_WIDGET_SIZE);
  return { ...preset, col: 0, row: 0 };
}

/** Set a docked tile to S / M / L and re-pack if it no longer fits at the same cell. */
export function setWorkspaceTileSize(id: number, size: WorkspaceWidgetSize, gridCols: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  placeWorkspaceTile(id, state.workspaceLayout[layoutKey(id)]?.col ?? 0, state.workspaceLayout[layoutKey(id)]?.row ?? 0, gridCols, size);
}

/** Advance a docked tile to the next widget size (small → medium → large → small). */
export function cycleWorkspaceTileSize(id: number, gridCols: number): void {
  const current = workspaceTileSize(getWorkspaceTile(id));
  const idx = WORKSPACE_WIDGET_SIZES.indexOf(current);
  const next = WORKSPACE_WIDGET_SIZES[(idx + 1) % WORKSPACE_WIDGET_SIZES.length]!;
  setWorkspaceTileSize(id, next, gridCols);
}

/** Re-pack when column count changes or footprints are invalid. */
export function syncWorkspaceTilesForViewport(gridCols: number): void {
  if (state.expanded.length === 0) {
    return;
  }
  const cols = Math.max(WORKSPACE_GRID_MIN_COLS, Math.min(WORKSPACE_GRID_MAX_COLS, gridCols));
  const invalid = state.expanded.some((id) => {
    const t = state.workspaceLayout[layoutKey(id)];
    return !t || !tileFootprintIsValid(t) || !tileFitsGridCols(t, cols);
  });
  if (!invalid) {
    return;
  }
  const workspaceLayout = packLayout(state.expanded, state.workspaceLayout, cols);
  commit({ ...state, workspaceLayout });
}

/** Persist layout from react-grid-layout after drag or compact. */
export function applyWorkspaceRglLayout(
  items: Array<{ i: string; x: number; y: number; w: number; h: number }>,
  gridCols: number,
): void {
  const cols = Math.max(WORKSPACE_GRID_MIN_COLS, Math.min(WORKSPACE_GRID_MAX_COLS, gridCols));
  const next: Record<string, WorkspaceTileLayout> = {};
  for (const item of items) {
    const id = Number(item.i);
    if (!Number.isFinite(id) || !state.expanded.includes(id)) {
      continue;
    }
    const raw = {
      col: item.x,
      row: item.y,
      colSpan: item.w,
      rowSpan: item.h,
    };
    const size = workspaceTileSize(raw);
    const foot = workspaceFootprintForSize(size, cols);
    const col = Math.max(0, Math.min(item.x, cols - foot.colSpan));
    next[layoutKey(id)] = {
      col,
      row: Math.max(0, item.y),
      colSpan: foot.colSpan,
      rowSpan: foot.rowSpan,
    };
  }
  for (const id of state.expanded) {
    if (!next[layoutKey(id)]) {
      const foot = workspaceFootprintForSize(WORKSPACE_DEFAULT_WIDGET_SIZE, cols);
      next[layoutKey(id)] = { ...foot, col: 0, row: 0 };
    }
  }
  if (workspaceLayoutEqual(next, state.workspaceLayout)) {
    return;
  }
  commit({ ...state, workspaceLayout: next });
}

/** Place a channel at a grid cell (e.g. rail drop); react-grid-layout compacts on next render. */
export function placeWorkspaceTile(
  id: number,
  col: number,
  row: number,
  gridCols: number,
  size?: WorkspaceWidgetSize,
): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const cols = Math.max(WORKSPACE_GRID_MIN_COLS, Math.min(WORKSPACE_GRID_MAX_COLS, gridCols));
  const key = layoutKey(id);
  const prev = state.workspaceLayout[key] ?? getWorkspaceTile(id);
  const foot = workspaceFootprintForSize(size ?? workspaceTileSize(prev), cols);
  const next: WorkspaceTileLayout = {
    ...foot,
    col: Math.max(0, Math.min(col, cols - foot.colSpan)),
    row: Math.max(0, row),
  };
  if (
    prev.col === next.col &&
    prev.row === next.row &&
    prev.colSpan === next.colSpan &&
    prev.rowSpan === next.rowSpan
  ) {
    return;
  }
  commit({
    ...state,
    workspaceLayout: { ...state.workspaceLayout, [key]: next },
  });
}

/** Reorder the docked sequence so the dragged tile lands before/after the target (drag-to-move). */
export function reorderWorkspaceTile(
  sourceId: number,
  targetId: number,
  place: "before" | "after",
): void {
  if (
    sourceId === targetId ||
    !state.expanded.includes(sourceId) ||
    !state.expanded.includes(targetId)
  ) {
    return;
  }
  const without = state.expanded.filter((id) => id !== sourceId);
  const targetIdx = without.indexOf(targetId);
  if (targetIdx < 0) {
    return;
  }
  const insertAt = place === "after" ? targetIdx + 1 : targetIdx;
  const expanded = [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
  if (expandedOrderEqual(expanded, state.expanded)) {
    return;
  }
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, packGridCols());
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Re-pack docked channels in list order (used when reordering). */
export function setWorkspaceChannelOrder(
  expanded: number[],
  gridCols = packGridCols(),
): void {
  const safe = expanded.filter((id) => state.expanded.includes(id));
  if (safe.length !== state.expanded.length) {
    return;
  }
  if (expandedOrderEqual(safe, state.expanded)) {
    return;
  }
  const workspaceLayout = packLayout(safe, state.workspaceLayout, gridCols);
  commitWorkspaceIfChanged(safe, workspaceLayout);
}

/** Dock a channel on the workspace at a puzzle grid cell (optional). */
export function dockChannel(
  id: number,
  at?: { col: number; row: number },
  gridCols = packGridCols(),
): void {
  const cols = Math.max(WORKSPACE_GRID_MIN_COLS, Math.min(WORKSPACE_GRID_MAX_COLS, gridCols));
  const expanded = [...state.expanded];
  if (!expanded.includes(id)) {
    expanded.push(id);
  }
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, cols);
  commitWorkspaceIfChanged(expanded, workspaceLayout);
  if (at) {
    placeWorkspaceTile(id, at.col, at.row, cols, WORKSPACE_DEFAULT_WIDGET_SIZE);
  }
}

/** Reorder docked channel list and re-pack the puzzle grid. */
export function reorderDockedChannels(orderedIds: number[], gridCols = packGridCols()): void {
  const expanded: number[] = [];
  for (const id of orderedIds) {
    if (state.expanded.includes(id) && !expanded.includes(id)) {
      expanded.push(id);
    }
  }
  for (const id of state.expanded) {
    if (!expanded.includes(id)) {
      expanded.push(id);
    }
  }
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, gridCols);
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Remove a channel from the workspace (returns to the left rail only). */
export function undockChannel(id: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const expanded = state.expanded.filter((x) => x !== id);
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, packGridCols());
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Toggle workspace dock (full panel on the right). */
export function toggleChannelExpanded(id: number): void {
  if (state.expanded.includes(id)) {
    undockChannel(id);
  } else {
    dockChannel(id);
  }
}

/** Keyboard/quick action: turn the channel on, dock it, and make it primary. */
export function focusChannel(id: number): void {
  const open = state.open.includes(id) ? state.open : [...state.open, id];
  let expanded = state.expanded;
  if (!expanded.includes(id)) {
    expanded = [...expanded, id];
  }
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, packGridCols());
  if (
    open.length === state.open.length &&
    open.every((cid, i) => cid === state.open[i]) &&
    expandedOrderEqual(expanded, state.expanded) &&
    workspaceLayoutEqual(workspaceLayout, state.workspaceLayout) &&
    state.primary === id
  ) {
    return;
  }
  commit({ ...state, open, expanded, workspaceLayout, primary: id });
}

export function setPrimaryChannel(id: number): void {
  if (!state.open.includes(id) || state.primary === id) {
    return;
  }
  commit({ ...state, primary: id });
}

/**
 * Drops channels the account can no longer see from the open/expanded sets. Call
 * only with a freshly fetched channel list — never speculatively, or it would
 * wipe the monitoring set.
 */
export function reconcileChannels(availableIds: number[]): void {
  const allowed = new Set(availableIds);
  const open = state.open.filter((id) => allowed.has(id));
  const expanded = state.expanded.filter((id) => allowed.has(id));
  const workspaceLayout = packLayout(expanded, state.workspaceLayout, packGridCols());
  if (
    open.length === state.open.length &&
    expanded.length === state.expanded.length &&
    workspaceLayoutEqual(workspaceLayout, state.workspaceLayout)
  ) {
    return;
  }
  commit({ ...state, open, expanded, workspaceLayout, primary: withValidPrimary(open, state.primary) });
}

export function setPttCode(code: string): void {
  commit({ ...state, pttCode: code });
}

export function setKeyboardOn(on: boolean): void {
  commit({ ...state, keyboardOn: on });
}
