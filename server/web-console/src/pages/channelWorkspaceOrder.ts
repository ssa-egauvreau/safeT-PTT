/** Drop edge when reordering a tile before/ after / directly under another. */
export type WorkspaceDropEdge = "before" | "after" | "under";

/** Preview dock order while dragging (does not commit until drop). */
export function previewWorkspaceOrder(
  order: number[],
  sourceId: number | null,
  targetId: number | null,
  edge: WorkspaceDropEdge | null,
  insertAtEnd: boolean,
): number[] {
  if (sourceId === null) {
    return order;
  }
  const from = order.indexOf(sourceId);
  if (from < 0) {
    return order;
  }
  if (targetId === null && !insertAtEnd) {
    return order;
  }
  const without = order.filter((id) => id !== sourceId);
  if (insertAtEnd || targetId === sourceId || targetId === null) {
    return [...without, sourceId];
  }
  let insertAt = without.indexOf(targetId);
  if (insertAt < 0) {
    return order;
  }
  if (edge === "after" || edge === "under") {
    insertAt += 1;
  }
  return [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
}

/** Preview order while dragging when the placeholder is at a computed insert index. */
export function previewWorkspaceOrderAtIndex(
  order: number[],
  sourceId: number,
  insertAt: number,
): number[] {
  const from = order.indexOf(sourceId);
  if (from < 0) {
    return order;
  }
  const without = order.filter((id) => id !== sourceId);
  const at = Math.max(0, Math.min(insertAt, without.length));
  return [...without.slice(0, at), sourceId, ...without.slice(at)];
}
