/**
 * Pulls the most useful error text out of WebSocket error/close event shapes.
 * `ws` emits Error objects; browser-style WebSocket emits Event-like objects.
 */
export function wsFailureText(eventLike) {
  if (!eventLike) return "";
  if (typeof eventLike === "string") return eventLike;
  if (eventLike instanceof Error) return eventLike.message || String(eventLike);
  if (typeof eventLike === "object") {
    if (typeof eventLike.message === "string" && eventLike.message) return eventLike.message;
    if (typeof eventLike.reason === "string" && eventLike.reason) return eventLike.reason;
    if (eventLike.error instanceof Error && eventLike.error.message) return eventLike.error.message;
    if (
      eventLike.error
      && typeof eventLike.error === "object"
      && typeof eventLike.error.message === "string"
      && eventLike.error.message
    ) {
      return eventLike.error.message;
    }
  }
  try {
    return String(eventLike);
  } catch {
    return "";
  }
}

/**
 * True when a socket failure likely means auth/token rejection (401/403,
 * unauthorized/forbidden/token wording), so reconnect should refresh JWT first.
 */
export function isAuthWsFailure(eventLike) {
  const text = wsFailureText(eventLike).toLowerCase();
  if (!text) return false;
  return (
    /\b401\b/.test(text)
    || /\b403\b/.test(text)
    || text.includes("unauth")
    || text.includes("forbidden")
    || text.includes("token")
    || /\bauth\b/.test(text)
  );
}
