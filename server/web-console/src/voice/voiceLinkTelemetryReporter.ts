import { api, type VoiceLinkTelemetryReport } from "../api";

/**
 * Browser-side voice-link telemetry reporter. Mirrors the Android / iOS
 * `VoiceLinkTelemetryReporter` shape so all three clients post to the same
 * endpoint with the same payload schema.
 *
 * Lifecycle:
 *   - `start()` arms a 30 s `setInterval` that drains the current window's
 *     counters into a snapshot, queues it, and fires a POST.
 *   - `stop()` clears the interval (e.g. on logout / SPA teardown).
 *
 * Buffering rules:
 *   - The current window is the in-memory tally being mutated by the
 *     `record*` calls. It is rolled over to a queued snapshot every interval.
 *   - On a failed POST the head snapshot is requeued at the front; if the
 *     queue would exceed {@link MAX_BUFFERED_WINDOWS} the OLDEST queued
 *     window is dropped rather than the newest — operators care about
 *     recent data first.
 *   - Idle windows (zero counters) are sent too. The absence-of-traffic
 *     case is also useful triage information ("unit 42 reported a heartbeat
 *     but no audio for 5 minutes").
 *
 * Concurrency: JS runs single-threaded in the browser, so the counters can be
 * plain numbers without further locking — the `setInterval` callback runs only
 * when no `record*` call is on the stack.
 */

/** Submission cadence — 30 s gives a useful refresh rate on the dashboard
 *  while keeping per-client volume low. ~120 reports/h × ~300 B = ~36 KB/h
 *  per unit. */
const TELEMETRY_INTERVAL_MS = 30_000;

/** How many windows we'll hold in memory if the POST keeps failing. Four
 *  windows ≈ 2 min of buffered history — beyond that, drop the oldest. */
const MAX_BUFFERED_WINDOWS = 4;

/** Wire id for the client type. Matches the server's `clientType` enum so
 *  the admin dashboard can filter "show me only the web unit having
 *  problems". */
const CLIENT_TYPE = "web";

interface CodecCounters {
  framesReceived: number;
  framesDecoded: number;
}

interface WindowCounters {
  framesReceived: number;
  framesDecoded: number;
  decodeFailures: number;
  plcFramesSynthesized: number;
  bufferUnderruns: number;
  maxBufferDepthFrames: number;
  talkSpurtsStarted: number;
  talkSpurtsEnded: number;
  bytesReceived: number;
  /** Uplink bytes — voice frames + recorder sideband sent on the socket. */
  bytesSent: number;
  /** Wall-clock duration the counters cover. Set when the window opens. */
  windowOpenedAtMs: number;
  codecBreakdown: Map<string, CodecCounters>;
}

interface QueuedWindow {
  unitId: string;
  channel: string | null;
  counters: WindowCounters;
  closedAtMs: number;
  /** True when any part of the window ran in a hidden tab — browsers throttle
   *  timers there, starving the jitter buffer, so the window's PLC/underruns
   *  describe throttling rather than the network. The server tags the row and
   *  Link Health keeps it out of the quality badge. */
  tabHidden: boolean;
}

/** `document.hidden`, safely false outside a DOM (unit tests run in Node). */
function tabIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function emptyWindow(now: number): WindowCounters {
  return {
    framesReceived: 0,
    framesDecoded: 0,
    decodeFailures: 0,
    plcFramesSynthesized: 0,
    bufferUnderruns: 0,
    maxBufferDepthFrames: 0,
    talkSpurtsStarted: 0,
    talkSpurtsEnded: 0,
    bytesReceived: 0,
    bytesSent: 0,
    windowOpenedAtMs: now,
    codecBreakdown: new Map(),
  };
}

export class VoiceLinkTelemetryReporter {
  private window: WindowCounters = emptyWindow(Date.now());
  private queued: QueuedWindow[] = [];
  private timer: number | null = null;
  private inFlight = false;
  private unitId: string | null = null;
  private channel: string | null = null;
  /** Sticky per-window: set if the tab was hidden at any point while the
   *  current window was open (visibilitychange listener + open/close checks). */
  private windowSawHidden = tabIsHidden();

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (tabIsHidden()) {
          this.windowSawHidden = true;
        }
      });
    }
  }

  /** Update which unit and channel future reports are billed to. Safe to call
   *  multiple times (channel switch); the new identity applies to the next
   *  window, the current window's tally is closed and queued under the
   *  previous identity so its counters aren't credited to the wrong unit. */
  setIdentity(unitId: string | null, channel: string | null): void {
    if (unitId !== this.unitId || channel !== this.channel) {
      if (this.unitId) {
        // Close out the current window under the existing identity so the
        // counters that were accumulated while on the prior channel don't
        // get credited to the new one.
        this.closeAndQueueWindow();
      }
      this.unitId = unitId;
      this.channel = channel;
    }
  }

  start(): void {
    if (this.timer != null) return;
    // `window.setInterval` returns a `number` in the browser typings; cast
    // is safe because Node typings only matter on the server side.
    this.timer = window.setInterval(() => {
      this.tick();
    }, TELEMETRY_INTERVAL_MS) as unknown as number;
  }

  stop(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  // --- counter recording (call sites in voiceClient.ts) ------------------

  recordFrameReceived(codec: string, bytes: number): void {
    this.window.framesReceived += 1;
    this.window.bytesReceived += Math.max(0, Math.floor(bytes));
    const entry = this.window.codecBreakdown.get(codec) ?? { framesReceived: 0, framesDecoded: 0 };
    entry.framesReceived += 1;
    this.window.codecBreakdown.set(codec, entry);
  }

  /** Uplink accounting — counts every app-level byte this client puts on the
   *  voice socket (vocoded frames, clear PCM, recorder sideband) so the admin
   *  data-usage column reflects both directions. */
  recordBytesSent(bytes: number): void {
    this.window.bytesSent += Math.max(0, Math.floor(bytes));
  }

  recordFrameDecoded(codec: string): void {
    this.window.framesDecoded += 1;
    const entry = this.window.codecBreakdown.get(codec) ?? { framesReceived: 0, framesDecoded: 0 };
    entry.framesDecoded += 1;
    this.window.codecBreakdown.set(codec, entry);
  }

  recordDecodeFailure(_codec: string): void {
    this.window.decodeFailures += 1;
  }

  recordPlcSynthesized(): void {
    this.window.plcFramesSynthesized += 1;
  }

  recordBufferUnderrun(): void {
    this.window.bufferUnderruns += 1;
  }

  recordBufferDepth(frames: number): void {
    if (frames > this.window.maxBufferDepthFrames) {
      this.window.maxBufferDepthFrames = frames;
    }
  }

  recordTalkSpurtStart(): void {
    this.window.talkSpurtsStarted += 1;
  }

  recordTalkSpurtEnd(): void {
    this.window.talkSpurtsEnded += 1;
  }

  // --- internal --------------------------------------------------------

  /** Visible for tests: snapshot the in-progress window without touching it. */
  snapshotForTest(): WindowCounters {
    return this.window;
  }

  /** Visible for tests: queued (not-yet-POSTed) windows. */
  queuedForTest(): readonly QueuedWindow[] {
    return this.queued;
  }

  private tick(): void {
    if (!this.unitId) {
      // No identity yet — rotate the window so counters don't backfill onto
      // the first identity that arrives.
      this.window = emptyWindow(Date.now());
      return;
    }
    this.closeAndQueueWindow();
    void this.flush();
  }

  private closeAndQueueWindow(): void {
    if (!this.unitId) return;
    const closedAt = Date.now();
    this.queued.push({
      unitId: this.unitId,
      channel: this.channel,
      counters: this.window,
      closedAtMs: closedAt,
      tabHidden: this.windowSawHidden || tabIsHidden(),
    });
    this.window = emptyWindow(closedAt);
    this.windowSawHidden = tabIsHidden();
    // Drop the OLDEST queued window when over the cap — operators care about
    // the recent data the dashboard is showing them; an hour-old summary is
    // less actionable than the current one. Pre-cap so a long network outage
    // doesn't unbounded-grow memory.
    while (this.queued.length > MAX_BUFFERED_WINDOWS) {
      this.queued.shift();
    }
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return;
    if (this.queued.length === 0) return;
    this.inFlight = true;
    try {
      while (this.queued.length > 0) {
        const head = this.queued[0]!;
        const body = buildReportBody(head);
        try {
          await api.postVoiceLinkTelemetry(body);
          this.queued.shift();
        } catch {
          // Leave the queue intact — the next tick re-tries the head. The
          // cap above keeps memory bounded.
          break;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

/** Module-level singleton so anywhere in the app can record counters without
 *  threading an instance through every layer. The voice client owns the
 *  lifecycle (start on connect, stop on disconnect). Exported only for the
 *  voice client to import; other call sites should not touch the lifecycle. */
export const voiceLinkTelemetryReporter = new VoiceLinkTelemetryReporter();

// --- pure helpers (exported for tests) -----------------------------------

/** Builds the JSON body the server expects from a queued window. Pulled out
 *  so a unit test can pin the wire shape without standing up a fake DOM. */
export function buildReportBody(w: QueuedWindow): VoiceLinkTelemetryReport {
  const counters = w.counters;
  const codecBreakdown: Record<string, CodecCounters> = {};
  for (const [k, v] of counters.codecBreakdown.entries()) {
    codecBreakdown[k] = { framesReceived: v.framesReceived, framesDecoded: v.framesDecoded };
  }
  return {
    unitId: w.unitId,
    channel: w.channel ?? undefined,
    clientType: CLIENT_TYPE,
    tabHidden: w.tabHidden || undefined,
    counters: {
      framesReceived: counters.framesReceived,
      framesDecoded: counters.framesDecoded,
      decodeFailures: counters.decodeFailures,
      plcFramesSynthesized: counters.plcFramesSynthesized,
      bufferUnderruns: counters.bufferUnderruns,
      maxBufferDepthFrames: counters.maxBufferDepthFrames,
      talkSpurtsStarted: counters.talkSpurtsStarted,
      talkSpurtsEnded: counters.talkSpurtsEnded,
      bytesReceived: counters.bytesReceived,
      bytesSent: counters.bytesSent,
      wallMsObservation: Math.max(0, w.closedAtMs - counters.windowOpenedAtMs),
    },
    codecBreakdown,
    clientTs: new Date(w.closedAtMs).toISOString(),
  };
}
