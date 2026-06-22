// Per-channel AI dispatch engagement mode.
//
//   off        — the dispatcher never listens on this channel.
//   supervised — she only engages when the transmission opens with the wake
//                word "AI" (like "Hey Siri"); otherwise she stays silent.
//   full_auto  — she listens to every qualifying transmission (the legacy ON).
//
// `enabled` (the legacy boolean still stored alongside `mode` for older clients)
// is simply `mode !== "off"`.

export type AiDispatchMode = "off" | "supervised" | "full_auto";

export const AI_DISPATCH_MODES: readonly AiDispatchMode[] = ["off", "supervised", "full_auto"];

/** Coerce arbitrary input (API body, DB value, legacy boolean) into a mode. */
export function normalizeAiDispatchMode(raw: unknown): AiDispatchMode {
  if (raw === true) return "full_auto";
  if (raw === false) return "off";
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "supervised") return "supervised";
  if (s === "full_auto" || s === "full-auto" || s === "auto" || s === "on" || s === "true") {
    return "full_auto";
  }
  return "off";
}

export function aiDispatchModeEnabled(mode: AiDispatchMode): boolean {
  return mode !== "off";
}

/**
 * Supervised wake word ("AI"). STT renders it inconsistently — "AI", "A.I.",
 * "A I", "hey AI" — so match a small, anchored set of leading forms. We stay
 * deliberately strict (no "eye"/"I") so the dispatcher doesn't engage on ordinary
 * speech like "I see a vehicle". Returns the transcript with the wake word
 * stripped when present (so the LLM never mistakes "AI" for a callsign), or null
 * when the transmission did not open with the wake word.
 */
export function stripSupervisedWakeWord(transcript: string): string | null {
  const t = transcript.replace(/^[\s,.]+/, "");
  // optional "hey", then AI / A.I. / A I, required to be a whole leading token.
  const m = t.match(/^(?:hey[\s,]+)?(?:a\.?\s*i\.?|a\s+i)(?=$|[\s,.:!?-])[\s,.:!?'"-]*/i);
  if (!m) return null;
  return t.slice(m[0].length).trim();
}

/** True when the transmission opens with the supervised wake word. */
export function hasSupervisedWakeWord(transcript: string): boolean {
  return stripSupervisedWakeWord(transcript) !== null;
}
