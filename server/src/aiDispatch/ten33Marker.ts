import { setChannelTen33 } from "../store.js";
import { playMarkerToneOnChannel } from "./markerTone.js";

/** On-air attribution for 10-33 marker bursts only (does not claim `/v1/air`). */
export const TEN33_MARKER_UNIT_ID = "10-33";

const MARKER_INTERVAL_MS = 12_000;

type LoopKey = string;

const markerLoops = new Map<LoopKey, ReturnType<typeof setInterval>>();

function loopKey(agencyId: number, channelName: string): LoopKey {
  return `${agencyId}:${channelName}`;
}

/** True while a 10-33 marker loop is armed on this channel. */
export function isTen33MarkerActive(agencyId: number, channelName: string): boolean {
  return markerLoops.has(loopKey(agencyId, channelName));
}

export function stopTen33MarkerLoop(agencyId: number, channelName: string): void {
  const key = loopKey(agencyId, channelName);
  const timer = markerLoops.get(key);
  if (timer) {
    clearInterval(timer);
    markerLoops.delete(key);
  }
}

type MarkerLoopOpts = {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  unitId: string;
};

function playMarkerBurst(opts: MarkerLoopOpts): void {
  void playMarkerToneOnChannel(opts).catch((err) => {
    console.warn(`[ai-dispatch] 10-33 marker tone failed channel=${opts.channelName}`, err);
  });
}

/**
 * Repeating custom 10-33 marker audio on the channel.
 * @param immediateBurst — false when AI just spoke the 10-33 callout (avoids talking over TTS).
 */
export function startTen33MarkerLoop(opts: MarkerLoopOpts, immediateBurst = true): void {
  const key = loopKey(opts.agencyId, opts.channelName);
  // Idempotent: if 10-33 is already armed on this channel, leave the running
  // loop as-is. Restarting it would fire a second immediate burst, so a manual
  // button push and the AI both activating would double-play the marker tone.
  if (markerLoops.has(key)) {
    return;
  }
  const tick = () => playMarkerBurst(opts);
  if (immediateBurst) {
    tick();
  }
  markerLoops.set(key, setInterval(tick, MARKER_INTERVAL_MS));
}

/**
 * Sets the safeT 10-33 channel marker (DB + repeating marker tone on the channel).
 */
export async function applyChannelTen33Marker(opts: {
  loopbackPort: number;
  agencyId: number;
  channelName: string;
  active: boolean;
  /** Ignored — marker audio always uses [TEN33_MARKER_UNIT_ID] for attribution. */
  markerUnitId?: string;
  source: "regex" | "ai" | "manual";
  /** When false, only the DB flag is set until startTen33MarkerLoop runs (AI 10-33 callout first). */
  startAudioLoop?: boolean;
  immediateAudioBurst?: boolean;
}): Promise<void> {
  const channel = opts.channelName.trim();
  if (!channel) {
    return;
  }
  await setChannelTen33(opts.agencyId, channel, opts.active);
  if (opts.active) {
    if (opts.startAudioLoop !== false) {
      startTen33MarkerLoop(
        {
          loopbackPort: opts.loopbackPort,
          agencyId: opts.agencyId,
          channelName: channel,
          unitId: TEN33_MARKER_UNIT_ID,
        },
        opts.immediateAudioBurst !== false,
      );
    }
    console.log(`[ai-dispatch] 10-33 ON channel=${channel} source=${opts.source}`);
  } else {
    stopTen33MarkerLoop(opts.agencyId, channel);
    console.log(`[ai-dispatch] 10-34 / clear 10-33 channel=${channel} source=${opts.source}`);
  }
}
