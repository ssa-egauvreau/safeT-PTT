// Shared, cross-window console state — which channels are open, the keyboard
// PTT binding, and shortcut on/off. The console and each pop-out window run in
// separate JavaScript contexts, so the source of truth lives in localStorage
// and changes propagate between windows via the "storage" event.

import { useSyncExternalStore } from "react";
import {
  DEFAULT_PTT_CODE,
  KEYBOARD_ENABLED_KEY,
  LAST_CHANNEL_KEY,
  OPEN_CHANNELS_KEY,
  PTT_CODE_KEY,
} from "./pages/consoleShared";

const STATE_KEY = "securityradio.console.state";

/** Bump when workspace layout rules change — triggers one-time localStorage migration. */
const CURRENT_LAYOUT_VERSION = 7;
const MAX_STATE_STORAGE_BYTES = 256 * 1024;
const MAX_OPEN_CHANNELS = 16;
const MAX_DOCKED_CHANNELS = 12;
const COMMIT_STORM_LIMIT = 24;
const COMMIT_STORM_WINDOW_MS = 2000;

/** Free-form tile on the channel workspace grid (12 columns). */
export interface WorkspaceTileLayout {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export const WORKSPACE_COLS = 12;
/** Column span for a compact stack tile (right column). */
export const WORKSPACE_STACK_COL_SPAN = 3;
/** Main panel width (left); stack lane uses the rest. */
export const WORKSPACE_MAIN_COL_SPAN = WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN;
/** Default row span for new compact stack panels. */
export const WORKSPACE_STACK_DEFAULT_ROW_SPAN = 6;
/** First column index for the right-hand stack lane. */
export const WORKSPACE_STACK_COL_START = WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN;
/** Column span for a half-width tile. */
export const WORKSPACE_HALF_COL_SPAN = 6;
/** Pixel height per workspace grid row — must fit channel controls without clipping. */
export const WORKSPACE_ROW_PX = 40;
export const WORKSPACE_GRID_GAP_PX = 6;
/** Default tile width before viewport-based sizing (2-wide on a 12-column grid). */
export const WORKSPACE_DEFAULT_COL_SPAN = 6;
/** Breakpoints aligned with channel-dock 3-wide / 4-wide layout. */
export const WORKSPACE_BREAK_3_WIDE = 1180;
export const WORKSPACE_BREAK_4_WIDE = 1580;
export const WORKSPACE_DEFAULT_ROW_SPAN = 14;
export const WORKSPACE_MIN_COL_SPAN = 3;
export const WORKSPACE_MAX_COL_SPAN = 12;
export const WORKSPACE_MIN_ROW_SPAN = 5;
export const WORKSPACE_MAX_ROW_SPAN = 36;
/**
 * Resize snap points (rowSpan). Smallest ≈ title + toolbar + volume + XMIT; each step adds more controls.
 */
export const WORKSPACE_ROW_SNAPS: readonly number[] = [5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 26, 32, 36];
/** Maximum channel panels side-by-side in one row (equal width, full row). */
export const WORKSPACE_MAX_PER_ROW = 4;

/** Snap rowSpan to the nearest tier so tile height matches visible controls. */
export function snapWorkspaceRowSpan(rowSpan: number): number {
  const clamped = Math.max(WORKSPACE_MIN_ROW_SPAN, Math.min(WORKSPACE_MAX_ROW_SPAN, rowSpan));
  let best = WORKSPACE_ROW_SNAPS[0]!;
  let bestDist = Math.abs(clamped - best);
  for (const snap of WORKSPACE_ROW_SNAPS) {
    const dist = Math.abs(clamped - snap);
    if (dist < bestDist) {
      best = snap;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Compactness tier for workspace channel cards (0 = volume + XMIT, higher = more sections).
 * Aligns with WORKSPACE_ROW_SNAPS indices.
 */
export function workspaceTierFromRowSpan(rowSpan: number): number {
  const snapped = snapWorkspaceRowSpan(rowSpan);
  const idx = WORKSPACE_ROW_SNAPS.indexOf(snapped);
  return idx >= 0 ? idx : WORKSPACE_ROW_SNAPS.length - 1;
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
    const col = Number(t.col);
    const row = Number(t.row);
    const colSpan = Number(t.colSpan);
    const rowSpan = Number(t.rowSpan);
    if (
      Number.isFinite(col) &&
      Number.isFinite(row) &&
      Number.isFinite(colSpan) &&
      Number.isFinite(rowSpan)
    ) {
      out[key] = {
        col: Math.max(0, Math.min(WORKSPACE_COLS - 1, col)),
        row: Math.max(0, row),
        colSpan: Math.max(WORKSPACE_MIN_COL_SPAN, Math.min(WORKSPACE_MAX_COL_SPAN, colSpan)),
        rowSpan: snapWorkspaceRowSpan(rowSpan),
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

function tileFitsGrid(tile: WorkspaceTileLayout): boolean {
  return tile.col >= 0 && tile.col + tile.colSpan <= WORKSPACE_COLS && tile.rowSpan >= WORKSPACE_MIN_ROW_SPAN;
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
    Object.values(workspaceLayout).some((t) => !tileFitsGrid(t)) ||
    Object.keys(input.workspaceLayout).length > expanded.length + 2;

  if (needsLayoutReset) {
    workspaceLayout = {};
  }

  // Too many docked channels at once can freeze the tab (black screen) on reload.
  let safeOpen = open;
  let safeExpanded = expanded;
  if (version < CURRENT_LAYOUT_VERSION || safeExpanded.length > 6 || safeOpen.length > 8) {
    safeExpanded = safeExpanded.slice(0, 6);
    safeOpen = safeOpen.slice(0, 8);
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
      ta.col !== tb.col ||
      ta.row !== tb.row ||
      ta.colSpan !== tb.colSpan ||
      ta.rowSpan !== tb.rowSpan
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

/** Column span for the workspace grid from the current window width (3- or 4-wide panels). */
export function workspaceColSpanForViewport(width = typeof window !== "undefined" ? window.innerWidth : 0): number {
  if (width >= WORKSPACE_BREAK_4_WIDE) {
    return 3;
  }
  if (width >= WORKSPACE_BREAK_3_WIDE) {
    return 4;
  }
  return WORKSPACE_DEFAULT_COL_SPAN;
}

/** Preset widths for cycling / default placement (stack → half → main → full). */
export function workspaceColSpanSnaps(_width = typeof window !== "undefined" ? window.innerWidth : 0): number[] {
  return [
    WORKSPACE_STACK_COL_SPAN,
    WORKSPACE_HALF_COL_SPAN,
    WORKSPACE_MAIN_COL_SPAN,
    WORKSPACE_COLS,
  ];
}

/** Clamp manual resize width to the 12-column grid (any span from 3–12). */
export function snapWorkspaceColSpan(colSpan: number, _width?: number): number {
  return Math.max(WORKSPACE_MIN_COL_SPAN, Math.min(WORKSPACE_MAX_COL_SPAN, Math.round(colSpan)));
}

/** Column width on the 12-column workspace grid (four slots across). */
export const WORKSPACE_SLOT_COL_SPAN = Math.floor(WORKSPACE_COLS / WORKSPACE_MAX_PER_ROW);

function columnSlotFromCol(col: number): number {
  return Math.min(
    WORKSPACE_MAX_PER_ROW - 1,
    Math.max(0, Math.floor(col / WORKSPACE_SLOT_COL_SPAN)),
  );
}

function tilesOverlap(a: WorkspaceTileLayout, b: WorkspaceTileLayout): boolean {
  const aColEnd = a.col + a.colSpan;
  const bColEnd = b.col + b.colSpan;
  const aRowEnd = a.row + a.rowSpan;
  const bRowEnd = b.row + b.rowSpan;
  return a.col < bColEnd && b.col < aColEnd && a.row < bRowEnd && b.row < aRowEnd;
}

/** Push tiles down until nothing overlaps (keeps column placement). */
function resolveWorkspaceOverlaps(
  layout: Record<string, WorkspaceTileLayout>,
  expandedIds: number[],
): void {
  const keys = expandedIds.map((id) => layoutKey(id)).filter((k) => layout[k]);
  let changed = true;
  let passes = 0;
  while (changed && passes < 64) {
    passes += 1;
    changed = false;
    keys.sort((a, b) => layout[a]!.row - layout[b]!.row || layout[a]!.col - layout[b]!.col);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ka = keys[i]!;
        const kb = keys[j]!;
        const ta = layout[ka]!;
        const tb = layout[kb]!;
        if (!tilesOverlap(ta, tb)) {
          continue;
        }
        layout[kb] = { ...tb, row: ta.row + ta.rowSpan };
        changed = true;
      }
    }
  }
}

/** The widest tile grows downward so the workspace stays filled when smaller tiles stack beside it. */
function fillPrimaryTileHeight(
  layout: Record<string, WorkspaceTileLayout>,
  expandedIds: number[],
): void {
  const keys = expandedIds.map((id) => layoutKey(id)).filter((k) => layout[k]);
  if (keys.length === 0) {
    return;
  }
  const maxBottom = Math.max(...keys.map((k) => layout[k]!.row + layout[k]!.rowSpan));
  let primaryKey = keys[0]!;
  let maxSpan = 0;
  for (const k of keys) {
    const t = layout[k]!;
    const isMainLane = t.col <= 0 && t.colSpan >= WORKSPACE_MAIN_COL_SPAN;
    const spanScore = isMainLane ? t.colSpan + 100 : t.colSpan;
    if (spanScore > maxSpan) {
      maxSpan = spanScore;
      primaryKey = k;
    }
  }
  const primary = layout[primaryKey]!;
  if (primary.colSpan < WORKSPACE_HALF_COL_SPAN) {
    return;
  }
  const need = maxBottom - primary.row;
  if (need > primary.rowSpan) {
    layout[primaryKey] = { ...primary, rowSpan: snapWorkspaceRowSpan(need) };
  }
}

/**
 * Packs channels: keeps dragged positions, stacks compact tiles in side columns,
 * and stretches the main (wide) tile to fill the workspace height.
 */
export function packWorkspaceLayout(
  expandedIds: number[],
  previous: Record<string, WorkspaceTileLayout>,
  options?: { fillPrimary?: boolean },
): Record<string, WorkspaceTileLayout> {
  const out: Record<string, WorkspaceTileLayout> = {};
  const columnBottom = new Array<number>(WORKSPACE_MAX_PER_ROW).fill(0);
  const placed = new Set<string>();

  for (const id of expandedIds) {
    const key = layoutKey(id);
    const prev = previous[key];
    if (prev && tileFitsGrid(prev)) {
      const tile: WorkspaceTileLayout = {
        col: prev.col,
        row: prev.row,
        colSpan: Math.max(WORKSPACE_MIN_COL_SPAN, Math.min(WORKSPACE_MAX_COL_SPAN, prev.colSpan)),
        rowSpan: snapWorkspaceRowSpan(prev.rowSpan),
      };
      out[key] = tile;
      const slot = columnSlotFromCol(tile.col);
      columnBottom[slot] = Math.max(columnBottom[slot]!, tile.row + tile.rowSpan);
      placed.add(key);
    }
  }

  const unplaced = expandedIds.filter((id) => !placed.has(layoutKey(id)));
  for (let i = 0; i < unplaced.length; i++) {
    const id = unplaced[i]!;
    const key = layoutKey(id);
    let rowSpan = snapWorkspaceRowSpan(previous[key]?.rowSpan ?? WORKSPACE_DEFAULT_ROW_SPAN);
    let slot = 0;
    for (let s = 1; s < WORKSPACE_MAX_PER_ROW; s++) {
      if (columnBottom[s]! < columnBottom[slot]!) {
        slot = s;
      }
    }
    const row = columnBottom[slot]!;
    const isFirstNew = placed.size === 0 && i === 0;
    const onlyOne = expandedIds.length === 1 && unplaced.length === 1;
    let colSpan: number;
    let col: number;
    let placeSlot = slot;
    if (onlyOne) {
      colSpan = WORKSPACE_COLS;
      col = 0;
      placeSlot = 0;
    } else if (isFirstNew) {
      colSpan = WORKSPACE_MAIN_COL_SPAN;
      col = 0;
      placeSlot = 0;
    } else {
      colSpan = WORKSPACE_STACK_COL_SPAN;
      col = WORKSPACE_STACK_COL_START;
      placeSlot = WORKSPACE_MAX_PER_ROW - 1;
      rowSpan = snapWorkspaceRowSpan(
        previous[key]?.rowSpan ?? WORKSPACE_STACK_DEFAULT_ROW_SPAN,
      );
    }
    out[key] = { col, row, colSpan, rowSpan };
    columnBottom[placeSlot] = row + rowSpan;
    placed.add(key);
  }

  resolveWorkspaceOverlaps(out, expandedIds);
  if (options?.fillPrimary !== false) {
    fillPrimaryTileHeight(out, expandedIds);
  }
  return out;
}

/** Drop a compact tile directly under another (same column). */
export function stackWorkspaceTileBelow(sourceId: number, targetId: number): void {
  if (sourceId === targetId || !state.expanded.includes(sourceId) || !state.expanded.includes(targetId)) {
    return;
  }
  const layout = { ...state.workspaceLayout };
  const packed = packWorkspaceLayout(state.expanded, layout);
  const srcKey = layoutKey(sourceId);
  const tgtKey = layoutKey(targetId);
  const src = packed[srcKey];
  const tgt = packed[tgtKey];
  if (!src || !tgt) {
    return;
  }
  layout[srcKey] = {
    ...src,
    col: tgt.col >= WORKSPACE_STACK_COL_START ? WORKSPACE_STACK_COL_START : tgt.col,
    colSpan: WORKSPACE_STACK_COL_SPAN,
    row: tgt.row + tgt.rowSpan,
    rowSpan: Math.min(src.rowSpan, WORKSPACE_STACK_DEFAULT_ROW_SPAN + 2),
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, layout, { fillPrimary: false });
  commit({ ...state, workspaceLayout });
}

/** Drop a tile in the column to the left or right of a target. */
export function placeWorkspaceTileBeside(
  sourceId: number,
  targetId: number,
  side: "left" | "right",
): void {
  if (sourceId === targetId || !state.expanded.includes(sourceId) || !state.expanded.includes(targetId)) {
    return;
  }
  const layout = { ...state.workspaceLayout };
  const packed = packWorkspaceLayout(state.expanded, layout);
  const srcKey = layoutKey(sourceId);
  const tgtKey = layoutKey(targetId);
  const src = packed[srcKey];
  let tgt = packed[tgtKey];
  if (!src || !tgt) {
    return;
  }

  if (side === "right") {
    if (tgt.colSpan > WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN) {
      layout[tgtKey] = {
        ...tgt,
        colSpan: WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN,
      };
      tgt = layout[tgtKey]!;
    }
    layout[srcKey] = {
      ...src,
      col: Math.min(tgt.col + tgt.colSpan, WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN),
      row: tgt.row,
      colSpan: WORKSPACE_STACK_COL_SPAN,
    };
  } else {
    layout[srcKey] = {
      ...src,
      col: Math.max(0, tgt.col - WORKSPACE_STACK_COL_SPAN),
      row: tgt.row,
      colSpan: WORKSPACE_STACK_COL_SPAN,
    };
    if (layout[srcKey]!.col + WORKSPACE_STACK_COL_SPAN > tgt.col) {
      layout[tgtKey] = {
        ...tgt,
        col: WORKSPACE_STACK_COL_SPAN,
        colSpan: Math.min(tgt.colSpan, WORKSPACE_COLS - WORKSPACE_STACK_COL_SPAN),
      };
    }
  }

  const workspaceLayout = packWorkspaceLayout(state.expanded, layout, { fillPrimary: false });
  commit({ ...state, workspaceLayout });
}

/** Swap grid position (and size) of two docked tiles. */
export function swapWorkspaceTiles(sourceId: number, targetId: number): void {
  if (
    sourceId === targetId ||
    !state.expanded.includes(sourceId) ||
    !state.expanded.includes(targetId)
  ) {
    return;
  }
  const packed = packWorkspaceLayout(state.expanded, state.workspaceLayout, {
    fillPrimary: false,
  });
  const srcKey = layoutKey(sourceId);
  const tgtKey = layoutKey(targetId);
  const src = state.workspaceLayout[srcKey] ?? packed[srcKey];
  const tgt = state.workspaceLayout[tgtKey] ?? packed[tgtKey];
  if (!src || !tgt) {
    return;
  }
  const layout = {
    ...state.workspaceLayout,
    [srcKey]: { ...tgt },
    [tgtKey]: { ...src },
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, layout, { fillPrimary: false });
  commit({ ...state, workspaceLayout });
}

/** Place a tile at a grid cell (keeps its current size unless it no longer fits). */
export function placeWorkspaceTileAtGrid(sourceId: number, col: number, row: number): void {
  if (!state.expanded.includes(sourceId)) {
    return;
  }
  const key = layoutKey(sourceId);
  const prev =
    state.workspaceLayout[key] ??
    packWorkspaceLayout(state.expanded, state.workspaceLayout, { fillPrimary: false })[key];
  if (!prev) {
    return;
  }
  const nextCol = Math.max(0, Math.min(col, WORKSPACE_COLS - prev.colSpan));
  const nextRow = Math.max(0, row);
  if (prev.col === nextCol && prev.row === nextRow) {
    return;
  }
  const layout = {
    ...state.workspaceLayout,
    [key]: { ...prev, col: nextCol, row: nextRow },
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, layout, { fillPrimary: false });
  commit({ ...state, workspaceLayout });
}

/** Cycle tile width: compact stack → half → full width. */
export function cycleWorkspaceTileWidth(id: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const key = layoutKey(id);
  const packed = packWorkspaceLayout(state.expanded, state.workspaceLayout);
  const tile = packed[key];
  if (!tile) {
    return;
  }
  const layout = { ...state.workspaceLayout };
  const spans = [
    WORKSPACE_STACK_COL_SPAN,
    WORKSPACE_HALF_COL_SPAN,
    WORKSPACE_MAIN_COL_SPAN,
    WORKSPACE_COLS,
  ];
  const idx = spans.indexOf(tile.colSpan);
  const nextSpan = spans[((idx >= 0 ? idx : 0) + 1) % spans.length]!;
  layout[key] = {
    ...tile,
    col: nextSpan >= WORKSPACE_STACK_COL_START ? WORKSPACE_STACK_COL_START : 0,
    colSpan: nextSpan,
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, layout);
  commit({ ...state, workspaceLayout });
}

/** @deprecated Alias — use packWorkspaceLayout */
export function relayoutWorkspace(
  expandedIds: number[],
  previous: Record<string, WorkspaceTileLayout>,
): Record<string, WorkspaceTileLayout> {
  return packWorkspaceLayout(expandedIds, previous);
}

/** Recompute grid positions from saved row spans (fixes stale col/row after layout changes). */
function withPackedWorkspaceLayout(s: ConsoleState): ConsoleState {
  if (s.expanded.length === 0) {
    return { ...s, workspaceLayout: {} };
  }
  return {
    ...s,
    workspaceLayout: packWorkspaceLayout(s.expanded, s.workspaceLayout, { fillPrimary: false }),
  };
}

export function getWorkspaceTile(id: number): WorkspaceTileLayout {
  const key = layoutKey(id);
  const stored = state.workspaceLayout[key];
  if (stored && tileFitsGrid(stored) && state.expanded.includes(id)) {
    return {
      col: stored.col,
      row: stored.row,
      colSpan: stored.colSpan,
      rowSpan: snapWorkspaceRowSpan(stored.rowSpan),
    };
  }
  const packed = packWorkspaceLayout(state.expanded, state.workspaceLayout);
  if (packed[key]) {
    return packed[key]!;
  }
  if (state.expanded.indexOf(id) < 0) {
    return {
      col: 0,
      row: 0,
      colSpan: WORKSPACE_COLS,
      rowSpan: WORKSPACE_DEFAULT_ROW_SPAN,
    };
  }
  return {
    col: 0,
    row: 0,
    colSpan: WORKSPACE_SLOT_COL_SPAN,
    rowSpan: WORKSPACE_DEFAULT_ROW_SPAN,
  };
}

export function setWorkspaceTileRowSpan(id: number, rowSpan: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const key = layoutKey(id);
  const prev =
    state.workspaceLayout[key] ??
    packWorkspaceLayout(state.expanded, state.workspaceLayout)[key];
  if (!prev) {
    return;
  }
  const nextSpan = snapWorkspaceRowSpan(rowSpan);
  if (prev.rowSpan === nextSpan) {
    return;
  }
  const merged = {
    ...state.workspaceLayout,
    [key]: {
      ...prev,
      rowSpan: nextSpan,
    },
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, merged, { fillPrimary: false });
  if (workspaceLayoutEqual(workspaceLayout, state.workspaceLayout)) {
    return;
  }
  commit({ ...state, workspaceLayout });
}

export function setWorkspaceTileColSpan(id: number, colSpan: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const key = layoutKey(id);
  const prev =
    state.workspaceLayout[key] ??
    packWorkspaceLayout(state.expanded, state.workspaceLayout)[key];
  if (!prev) {
    return;
  }
  const viewport = typeof window !== "undefined" ? window.innerWidth : 0;
  const nextColSpan = snapWorkspaceColSpan(colSpan, viewport);
  const nextCol = Math.max(0, Math.min(prev.col, WORKSPACE_COLS - nextColSpan));
  if (prev.colSpan === nextColSpan && prev.col === nextCol) {
    return;
  }
  const merged = {
    ...state.workspaceLayout,
    [key]: {
      ...prev,
      col: nextCol,
      colSpan: nextColSpan,
    },
  };
  const workspaceLayout = packWorkspaceLayout(state.expanded, merged, { fillPrimary: false });
  if (workspaceLayoutEqual(workspaceLayout, state.workspaceLayout)) {
    return;
  }
  commit({ ...state, workspaceLayout });
}

/** Dock a channel on the workspace; optional insert index (left-to-right order). */
export function dockChannel(id: number, insertAt?: number): void {
  let expanded = [...state.expanded];
  if (!expanded.includes(id)) {
    const at =
      typeof insertAt === "number" && insertAt >= 0
        ? Math.min(insertAt, expanded.length)
        : expanded.length;
    expanded.splice(at, 0, id);
  }
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Reorder docked channel list without resetting tile positions on the grid. */
export function reorderDockedChannels(orderedIds: number[]): void {
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
  const workspaceLayout = packWorkspaceLayout(expanded, state.workspaceLayout, { fillPrimary: false });
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Remove a channel from the workspace (returns to the left rail only). */
export function undockChannel(id: number): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const expanded = state.expanded.filter((x) => x !== id);
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
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
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
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
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
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
