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
const CURRENT_LAYOUT_VERSION = 10;
const MAX_STATE_STORAGE_BYTES = 256 * 1024;
const MAX_OPEN_CHANNELS = 16;
const MAX_DOCKED_CHANNELS = 12;
const COMMIT_STORM_LIMIT = 24;
const COMMIT_STORM_WINDOW_MS = 2000;

/**
 * One channel tile on the workspace grid, sized like an iOS home-screen widget. The grid is a set of
 * equal "widget columns" (one or two across, depending on width); a tile is one of three sizes that
 * pack together like puzzle pieces via dense auto-flow:
 *   - small:  1 grid column — name, mute, volume, PTT, user count
 *   - medium: 2 grid columns — small + last TX + compact tone-outs
 *   - large:  3 grid columns — full control surface + connected roster
 */
export interface WorkspaceTileLayout {
  /** Grid columns the tile spans (1 = small, 2 = medium, 3 = large); clamped to the live column count. */
  colSpan: number;
  /** Height in WORKSPACE_ROW_PX units. */
  rowSpan: number;
}

export type WorkspaceWidgetSize = "small" | "medium" | "large";

/** Minimum width of one workspace grid column — several small widgets fit side by side. */
export const WORKSPACE_MIN_COL_PX = 172;
/** Maximum grid columns (auto-fill stops growing past this). */
export const WORKSPACE_MAX_COLS = 12;
/** Medium widget spans this many grid columns; large spans WORKSPACE_LARGE_COL_SPAN. */
export const WORKSPACE_MEDIUM_COL_SPAN = 2;
export const WORKSPACE_LARGE_COL_SPAN = 3;
/** Pixel height per workspace grid row — must fit channel controls without clipping. */
export const WORKSPACE_ROW_PX = 40;
/** Grid gap (px); kept in sync with the CSS so the column-count math matches the browser's layout. */
export const WORKSPACE_GRID_GAP_PX = 8;
/** Short widget height (small / medium): compact controls. */
export const WORKSPACE_SHORT_ROW_SPAN = 7;
/** Tall widget height (large): full control surface. */
export const WORKSPACE_TALL_ROW_SPAN = 14;
/** New tiles dock as a medium widget. */
export const WORKSPACE_DEFAULT_COL_SPAN = WORKSPACE_MEDIUM_COL_SPAN;
export const WORKSPACE_DEFAULT_ROW_SPAN = WORKSPACE_SHORT_ROW_SPAN;
export const WORKSPACE_MIN_ROW_SPAN = 5;
export const WORKSPACE_MAX_ROW_SPAN = 36;
/**
 * Resize snap points (rowSpan). Smallest ≈ title + toolbar + volume + XMIT; each step adds more controls.
 */
export const WORKSPACE_ROW_SNAPS: readonly number[] = [5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 26, 32, 36];

/** The three widget sizes, in cycle order. */
export const WORKSPACE_WIDGET_SIZES: readonly WorkspaceWidgetSize[] = ["small", "medium", "large"];

/** The { colSpan, rowSpan } a given widget size maps to. */
export function workspacePresetForSize(size: WorkspaceWidgetSize): WorkspaceTileLayout {
  switch (size) {
    case "small":
      return { colSpan: 1, rowSpan: WORKSPACE_SHORT_ROW_SPAN };
    case "large":
      return { colSpan: WORKSPACE_LARGE_COL_SPAN, rowSpan: WORKSPACE_TALL_ROW_SPAN };
    default:
      return { colSpan: WORKSPACE_MEDIUM_COL_SPAN, rowSpan: WORKSPACE_SHORT_ROW_SPAN };
  }
}

/** Classify a stored tile into one of the three widget sizes. */
export function workspaceTileSize(tile: WorkspaceTileLayout): WorkspaceWidgetSize {
  if (tile.colSpan <= 1) {
    return "small";
  }
  if (tile.colSpan >= WORKSPACE_LARGE_COL_SPAN || tile.rowSpan >= WORKSPACE_TALL_ROW_SPAN) {
    return "large";
  }
  return "medium";
}

/** How many equal grid columns fit at a container width (used to clamp tile colSpan). */
export function workspaceColsForWidth(width: number, gap = WORKSPACE_GRID_GAP_PX): number {
  if (!Number.isFinite(width) || width <= 0) {
    return 1;
  }
  const cols = Math.floor((width + gap) / (WORKSPACE_MIN_COL_PX + gap));
  return Math.max(1, Math.min(WORKSPACE_MAX_COLS, cols));
}

/** Clamp a tile's column span to the allowed range. */
export function clampWorkspaceColSpan(colSpan: number): number {
  if (!Number.isFinite(colSpan)) {
    return WORKSPACE_DEFAULT_COL_SPAN;
  }
  return Math.max(1, Math.min(WORKSPACE_MAX_COLS, Math.round(colSpan)));
}

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
    const colSpan = Number(t.colSpan);
    const rowSpan = Number(t.rowSpan);
    if (Number.isFinite(colSpan) && Number.isFinite(rowSpan)) {
      out[key] = {
        colSpan: clampWorkspaceColSpan(colSpan),
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

function tileIsValid(tile: WorkspaceTileLayout): boolean {
  return (
    tile.colSpan >= 1 &&
    tile.colSpan <= WORKSPACE_MAX_COLS &&
    tile.rowSpan >= WORKSPACE_MIN_ROW_SPAN &&
    tile.rowSpan <= WORKSPACE_MAX_ROW_SPAN
  );
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
    Object.values(workspaceLayout).some((t) => !tileIsValid(t)) ||
    Object.keys(input.workspaceLayout).length > expanded.length + 2;

  if (needsLayoutReset) {
    workspaceLayout = {};
  }

  // Too many docked channels at once can freeze the tab (black screen) on reload. Cap purely on the
  // counts — NOT on the layout version: a version bump only migrates tile sizing and must not
  // truncate a user's docked / monitored channels.
  let safeOpen = open;
  let safeExpanded = expanded;
  if (safeExpanded.length > 6 || safeOpen.length > 8) {
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
    if (!ta || !tb || ta.colSpan !== tb.colSpan || ta.rowSpan !== tb.rowSpan) {
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

/** A docked tile at its default size. */
function defaultWorkspaceTile(): WorkspaceTileLayout {
  return { colSpan: WORKSPACE_DEFAULT_COL_SPAN, rowSpan: WORKSPACE_DEFAULT_ROW_SPAN };
}

/**
 * Ensures every expanded channel has a valid tile and drops tiles for channels that are no longer
 * docked. There is no coordinate packing: the grid auto-flows tiles in docked order, so this only
 * carries each tile's span (clamped/snapped) forward.
 */
function ensureWorkspaceLayout(
  expanded: number[],
  previous: Record<string, WorkspaceTileLayout>,
): Record<string, WorkspaceTileLayout> {
  const out: Record<string, WorkspaceTileLayout> = {};
  for (const id of expanded) {
    const key = layoutKey(id);
    const prev = previous[key];
    out[key] =
      prev && tileIsValid(prev)
        ? { colSpan: clampWorkspaceColSpan(prev.colSpan), rowSpan: snapWorkspaceRowSpan(prev.rowSpan) }
        : defaultWorkspaceTile();
  }
  return out;
}

/** Carries docked tile spans forward when the docked set or order changes. */
function relayoutWorkspace(
  expanded: number[],
  previous: Record<string, WorkspaceTileLayout>,
): Record<string, WorkspaceTileLayout> {
  return ensureWorkspaceLayout(expanded, previous);
}

/** Normalizes the workspace layout to exactly the docked channels (called on every commit). */
function withPackedWorkspaceLayout(s: ConsoleState): ConsoleState {
  if (s.expanded.length === 0) {
    return { ...s, workspaceLayout: {} };
  }
  return { ...s, workspaceLayout: ensureWorkspaceLayout(s.expanded, s.workspaceLayout) };
}

export function getWorkspaceTile(id: number): WorkspaceTileLayout {
  const stored = state.workspaceLayout[layoutKey(id)];
  if (stored && tileIsValid(stored) && state.expanded.includes(id)) {
    return {
      colSpan: clampWorkspaceColSpan(stored.colSpan),
      rowSpan: snapWorkspaceRowSpan(stored.rowSpan),
    };
  }
  return defaultWorkspaceTile();
}

/** Set a docked tile to one of the three widget sizes. */
export function setWorkspaceTileSize(id: number, size: WorkspaceWidgetSize): void {
  if (!state.expanded.includes(id)) {
    return;
  }
  const key = layoutKey(id);
  const prev = state.workspaceLayout[key] ?? getWorkspaceTile(id);
  const next = workspacePresetForSize(size);
  if (prev.colSpan === next.colSpan && prev.rowSpan === next.rowSpan) {
    return;
  }
  commit({
    ...state,
    workspaceLayout: { ...state.workspaceLayout, [key]: next },
  });
}

/** Advance a docked tile to the next widget size (small → medium → large → small). */
export function cycleWorkspaceTileSize(id: number): void {
  const current = workspaceTileSize(getWorkspaceTile(id));
  const idx = WORKSPACE_WIDGET_SIZES.indexOf(current);
  const next = WORKSPACE_WIDGET_SIZES[(idx + 1) % WORKSPACE_WIDGET_SIZES.length]!;
  setWorkspaceTileSize(id, next);
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
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
  commitWorkspaceIfChanged(expanded, workspaceLayout);
}

/** Move a docked tile to the end of the sequence (drag onto empty workspace area). */
export function moveWorkspaceTileToEnd(sourceId: number): void {
  if (!state.expanded.includes(sourceId)) {
    return;
  }
  const without = state.expanded.filter((id) => id !== sourceId);
  const expanded = [...without, sourceId];
  if (expandedOrderEqual(expanded, state.expanded)) {
    return;
  }
  const workspaceLayout = relayoutWorkspace(expanded, state.workspaceLayout);
  commitWorkspaceIfChanged(expanded, workspaceLayout);
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
