/** One playback at a time per agency + channel (TTS + 10-33 marker tones). */

import { normalizedChannel } from "../presence.js";

const tails = new Map<string, Promise<void>>();

function lockKey(agencyId: number, channelName: string): string {
  return `${agencyId}:${normalizedChannel(channelName)}`;
}

export async function withChannelPlaybackLock<T>(
  agencyId: number,
  channelName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(agencyId, channelName);
  // Chain this playback after whatever is currently queued for the channel. `prev` is a
  // sanitized tail that never rejects, so a failed playback never blocks the next one.
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // Track completion (success OR failure) as the new tail without surfacing rejections.
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
