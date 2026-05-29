/**
 * Cross-platform voice timing — keep in sync with `docs/voice-timing.md`.
 */
export const VOICE_AIR_TTL_MS = 900;
export const TALK_SPURT_GAP_MS = 300;
export const TALK_SPURT_GAP_SEC = TALK_SPURT_GAP_MS / 1000;
export const RX_GAP_MS = TALK_SPURT_GAP_MS;
export const TALK_ACTIVITY_POLL_MS = 1200;
export const TALK_ACTIVITY_FAST_POLL_MS = 400;
export const AIR_POLL_WHILE_PTT_MS = 250;

export const RELEASE_AIR_CONTROL = { type: "release_air" } as const;

export function releaseAirControlJson(): string {
  return JSON.stringify(RELEASE_AIR_CONTROL);
}
