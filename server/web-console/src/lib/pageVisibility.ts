/**
 * Page-visibility helpers for the live-polling hooks. A 12-channel dispatch board
 * runs dozens of timers; when the operator tabs away there's no reason to keep
 * hitting the API for talker/roster/transmission updates they can't see. The
 * poll callbacks short-circuit on `isPageHidden()`, and `onPageVisible` lets a
 * hook fire one immediate refresh the moment the tab comes back so the board
 * isn't stale for a full interval.
 */

export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Subscribe to the page becoming visible again. Returns an unsubscribe fn. */
export function onPageVisible(cb: () => void): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  const handler = () => {
    if (document.visibilityState === "visible") {
      cb();
    }
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
