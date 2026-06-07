// Staggers voice-channel connects so reloading Mission Control with many docked
// channels doesn't fire every connect() at once. Each VoiceChannelClient.connect()
// synchronously creates an AudioContext + WebSocket and kicks off a burst of API
// polls; doing N of those in a single frame on reload can freeze the tab (black
// screen). The scheduler runs queued connects one at a time with a small gap, so
// the cost is spread across a few hundred ms instead of landing all at once.
//
// Only the initial mount connect is routed through here. Reconnect-on-close is left
// direct — those fire individually, not in a burst, and shouldn't be delayed.

/** Minimum spacing between two consecutive scheduled connects. */
const STAGGER_GAP_MS = 150;

let queue: Array<() => void> = [];
let timer: number | null = null;
let lastRunAt = 0;

function pump(): void {
  if (timer !== null || queue.length === 0) {
    return;
  }
  const wait = Math.max(0, STAGGER_GAP_MS - (Date.now() - lastRunAt));
  timer = window.setTimeout(() => {
    timer = null;
    const task = queue.shift();
    if (task) {
      lastRunAt = Date.now();
      try {
        task();
      } catch {
        /* a single bad connect shouldn't stall the rest of the queue */
      }
    }
    pump();
  }, wait);
}

/**
 * Queue a connect task. The first task runs on the next tick; each subsequent one
 * waits at least STAGGER_GAP_MS after the previous ran. Returns a cancel function —
 * call it on unmount/teardown to drop the task if it hasn't run yet.
 */
export function scheduleConnect(task: () => void): () => void {
  queue.push(task);
  pump();
  return () => {
    queue = queue.filter((t) => t !== task);
  };
}
