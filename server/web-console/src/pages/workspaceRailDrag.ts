import type { UserChannel } from "../api";
import { ghostWidthPx } from "./workspacePuzzleGrid";
import {
  WORKSPACE_DEFAULT_WIDGET_SIZE,
  WORKSPACE_GRID_GAP_PX,
  WORKSPACE_MIN_COL_PX,
  getWorkspaceTile,
  workspacePresetForSize,
  workspaceTileSize,
  type WorkspaceWidgetSize,
} from "../consoleStore";

export type RailDragPreview = {
  channelId: number;
  channelName: string;
  color: string | null;
  simulcast: boolean;
  size: WorkspaceWidgetSize;
  colSpan: number;
};

let active: RailDragPreview | null = null;
const listeners = new Set<() => void>();

export function getRailDragPreview(): RailDragPreview | null {
  return active;
}

export function subscribeRailDragPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRailDragPreview(preview: RailDragPreview | null): void {
  active = preview;
  listeners.forEach((l) => l());
}

/** Widget size + width when dragging from the rail (uses saved size if already docked). */
export function workspacePreviewForChannel(
  channel: UserChannel,
  docked: boolean,
): { size: WorkspaceWidgetSize; colSpan: number } {
  if (docked) {
    const tile = getWorkspaceTile(channel.id);
    return { size: workspaceTileSize(tile), colSpan: tile.colSpan };
  }
  const preset = workspacePresetForSize(WORKSPACE_DEFAULT_WIDGET_SIZE);
  return { size: WORKSPACE_DEFAULT_WIDGET_SIZE, colSpan: preset.colSpan };
}

export function workspaceGhostWidthPx(
  colSpan: number,
  gridCols = 4,
  containerInnerWidth?: number,
  gap = WORKSPACE_GRID_GAP_PX,
): number {
  const span = Math.max(1, colSpan);
  if (containerInnerWidth && containerInnerWidth > 0) {
    return ghostWidthPx(span, gridCols, containerInnerWidth, gap);
  }
  return span * WORKSPACE_MIN_COL_PX + (span - 1) * gap;
}

/** Cursor follower payload for a docked workspace tile (S / M / L). */
export function railDragPreviewFromChannel(
  channel: UserChannel,
  tile: { colSpan: number; rowSpan: number },
  availableCols: number,
): RailDragPreview {
  const size = workspaceTileSize(tile);
  return {
    channelId: channel.id,
    channelName: channel.name,
    color: channel.color,
    simulcast: !!channel.simulcast,
    size,
    colSpan: Math.max(1, Math.min(tile.colSpan, availableCols)),
  };
}

const SIZE_LABEL: Record<WorkspaceWidgetSize, string> = {
  small: "S",
  medium: "M",
  large: "L",
};

/**
 * DOM node for HTML5 setDragImage — sized like the workspace widget (S / M / L).
 * Caller removes the node on dragend.
 */
export function createRailDragGhostElement(
  channel: UserChannel,
  size: WorkspaceWidgetSize,
  colSpan: number,
): HTMLElement {
  const root = document.createElement("div");
  root.className = `channel-workspace-drag-ghost widget-${size}`;
  root.style.position = "fixed";
  root.style.left = "-9999px";
  root.style.top = "0";
  root.style.width = `${workspaceGhostWidthPx(colSpan)}px`;

  const head = document.createElement("div");
  head.className = "channel-workspace-drag-ghost-head";
  if (channel.color) {
    head.style.background = channel.color;
    head.style.color = "#fff";
  }
  head.textContent = channel.name;
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "channel-workspace-drag-ghost-body";
  body.innerHTML =
    size === "small"
      ? `<span class="channel-workspace-drag-ghost-chip">Vol</span><span class="channel-workspace-drag-ghost-chip">PTT</span>`
      : size === "medium"
        ? `<span class="channel-workspace-drag-ghost-chip">Vol</span><span class="channel-workspace-drag-ghost-chip">Last TX</span><span class="channel-workspace-drag-ghost-chip">Tones</span>`
        : `<span class="channel-workspace-drag-ghost-chip">Full controls</span><span class="channel-workspace-drag-ghost-chip">Users</span>`;
  root.appendChild(body);

  const badge = document.createElement("span");
  badge.className = "channel-workspace-drag-ghost-size";
  badge.textContent = SIZE_LABEL[size];
  root.appendChild(badge);

  return root;
}
