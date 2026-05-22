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

/** Free-form tile on the channel workspace grid (12 columns). */
export interface WorkspaceTileLayout {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export const WORKSPACE_COLS = 12;
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
  };
}

let state: ConsoleState = withPackedWorkspaceLayout(parse(localStorage.getItem(STATE_KEY)) ?? migrate());
const listeners = new Set<() => void>();

function commit(next: ConsoleState): void {
  state = next;
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — keep the in-memory state */
  }
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  // Another window (a pop-out, or the console) changed the shared state.
  window.addEventListener("storage", (event) => {
    if (event.key === STATE_KEY) {
      const next = parse(event.newValue);
      if (next) {
        state = withPackedWorkspaceLayout(next);
        listeners.forEach((listener) => listener());
      }
    }
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

/** One-time repair after layout algorithm changes — safe to call on Mission Control mount. */
export function repairWorkspaceLayout(): void {
  if (state.expanded.length === 0) {
    if (Object.keys(state.workspaceLayout).length === 0) {
      return;
    }
    commit({ ...state, workspaceLayout: {} });
    return;
  }
  const packed = packWorkspaceLayout(state.expanded, state.workspaceLayout);
  if (workspaceLayoutEqual(packed, state.workspaceLayout)) {
    return;
  }
  commit({ ...state, workspaceLayout: packed });
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

/** Allowed width snaps for manual resize at the current viewport. */
export function workspaceColSpanSnaps(width = typeof window !== "undefined" ? window.innerWidth : 0): number[] {
  if (width >= WORKSPACE_BREAK_4_WIDE) {
    return [3, 4, 6];
  }
  if (width >= WORKSPACE_BREAK_3_WIDE) {
    return [3, 4, 6];
  }
  return [4, 6, 12];
}

function snapWorkspaceColSpan(colSpan: number, width: number): number {
  const snaps = workspaceColSpanSnaps(width);
  let best = snaps[0]!;
  let bestDist = Math.abs(colSpan - best);
  for (const s of snaps) {
    const d = Math.abs(colSpan - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return Math.max(WORKSPACE_MIN_COL_SPAN, Math.min(WORKSPACE_MAX_COL_SPAN, best));
}

/** Column width on the 12-column workspace grid (four slots across). */
export const WORKSPACE_SLOT_COL_SPAN = Math.floor(WORKSPACE_COLS / WORKSPACE_MAX_PER_ROW);

/**
 * Packs channels into up to four columns; short tiles leave room for another channel below.
 */
export function packWorkspaceLayout(
  expandedIds: number[],
  previous: Record<string, WorkspaceTileLayout>,
): Record<string, WorkspaceTileLayout> {
  const out: Record<string, WorkspaceTileLayout> = {};
  const columnBottom = new Array<number>(WORKSPACE_MAX_PER_ROW).fill(0);
  for (const id of expandedIds) {
    const key = layoutKey(id);
    const prev = previous[key];
    const rowSpan = snapWorkspaceRowSpan(prev?.rowSpan ?? WORKSPACE_DEFAULT_ROW_SPAN);
    let slot = 0;
    for (let s = 1; s < WORKSPACE_MAX_PER_ROW; s++) {
      if (columnBottom[s]! < columnBottom[slot]!) {
        slot = s;
      }
    }
    const row = columnBottom[slot]!;
    out[key] = {
      col: slot * WORKSPACE_SLOT_COL_SPAN,
      row,
      colSpan: WORKSPACE_SLOT_COL_SPAN,
      rowSpan,
    };
    columnBottom[slot] = row + rowSpan;
  }
  return out;
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
    workspaceLayout: packWorkspaceLayout(s.expanded, s.workspaceLayout),
  };
}

export function getWorkspaceTile(id: number): WorkspaceTileLayout {
  const key = layoutKey(id);
  const tile = state.workspaceLayout[key];
  if (tile) {
    return tile;
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
  const workspaceLayout = packWorkspaceLayout(state.expanded, merged);
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

/** Reorder docked channels (e.g. drag left/right); widths reflow to fill each row. */
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
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
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
