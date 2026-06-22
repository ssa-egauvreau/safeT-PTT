// Transient, in-memory "what is the AI dispatcher doing right now" state, per
// agency+channel. Pushed to handsets via /radio/inbox so a radio can show a
// Siri-style cue: she heard you and is thinking, then what she said + a short
// action tag. Best-effort and ephemeral — never persisted, lost on restart
// (which is fine; it only describes the live moment).

export type AiActivityPhase = "thinking" | "speaking";

export interface AiActivity {
  phase: AiActivityPhase;
  /** The unit she's responding to (the radio that transmitted). */
  unitId: string;
  /** Her reply text (only while speaking). This is the SPOKEN form (phonetic
   * for plate/VIN readbacks) — clients should prefer `displayText` for screens. */
  text?: string;
  /** Clean, screen-friendly form of the reply with NO phonetics. For a plate/VIN
   * return this is "8ABC123 — 2019 Toyota Camry" instead of the spelled-out TTS.
   * Falls back to `text` on the client when absent. */
  displayText?: string;
  /** Raw queried plate, when this reply was a plate return (for clean display). */
  plate?: string;
  /** Full VIN, when this reply was a plate/VIN return — clients render the whole
   * VIN with the last six bold/highlighted. */
  vin?: string;
  /** Short action tag, e.g. "RADIO CHECK", "LOOKUP: PLATE", "415 @ 32-08". */
  tag?: string;
  /** epoch ms after which this entry is stale and should not be shown. */
  expiresAt: number;
}

/** Optional clean-display extras for {@link setAiSpeaking}. */
export interface AiSpeakingDisplay {
  displayText?: string | null;
  plate?: string | null;
  vin?: string | null;
}

/** Thinking cue lingers this long if nothing replaces it (transcribe -> LLM -> TTS). */
const THINKING_TTL_MS = 12_000;
/** Speaking cap while playback runs (replaced by markAiSpeakingDone when audio ends). */
const SPEAKING_TTL_MS = 30_000;
/** After she stops talking, hold the response on-screen this long, then clear. */
const SPEAKING_TAIL_MS = 3_000;

const byChannel = new Map<string, AiActivity>();

function keyOf(agencyId: number, channel: string): string {
  return `${agencyId} ${channel.trim().toLowerCase()}`;
}

export function setAiThinking(agencyId: number, channel: string, unitId: string): void {
  if (!channel.trim()) return;
  byChannel.set(keyOf(agencyId, channel), {
    phase: "thinking",
    unitId: unitId.trim().toUpperCase(),
    expiresAt: Date.now() + THINKING_TTL_MS,
  });
}

export function setAiSpeaking(
  agencyId: number,
  channel: string,
  unitId: string,
  text: string,
  tag?: string,
  display?: AiSpeakingDisplay,
): void {
  if (!channel.trim()) return;
  byChannel.set(keyOf(agencyId, channel), {
    phase: "speaking",
    unitId: unitId.trim().toUpperCase(),
    text: text.trim().slice(0, 240),
    displayText: display?.displayText?.trim().slice(0, 240) || undefined,
    plate: display?.plate?.trim().slice(0, 16) || undefined,
    vin: display?.vin?.trim().slice(0, 24) || undefined,
    tag: tag?.trim().slice(0, 24) || undefined,
    // Generous cap covering the whole spoken reply; trimmed when playback ends.
    expiresAt: Date.now() + SPEAKING_TTL_MS,
  });
}

/**
 * Call when on-air playback of her reply finishes: hold the response on the
 * radio for a short tail (so the operator can read it), then it clears — i.e.
 * "a few seconds after she's done talking the screen returns to normal".
 */
export function markAiSpeakingDone(agencyId: number, channel: string): void {
  if (!channel.trim()) return;
  const key = keyOf(agencyId, channel);
  const a = byChannel.get(key);
  if (!a || a.phase !== "speaking") return;
  a.expiresAt = Date.now() + SPEAKING_TAIL_MS;
}

export function clearAiActivity(agencyId: number, channel: string): void {
  byChannel.delete(keyOf(agencyId, channel));
}

/** Current activity for a channel, or null when nothing recent (expired). */
export function getAiActivity(agencyId: number, channel: string | null): AiActivity | null {
  if (!channel) return null;
  const key = keyOf(agencyId, channel);
  const a = byChannel.get(key);
  if (!a) return null;
  if (Date.now() > a.expiresAt) {
    byChannel.delete(key);
    return null;
  }
  return a;
}
