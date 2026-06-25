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

/** Default supervised wake phrase when an agency hasn't configured its own. */
export const DEFAULT_WAKE_WORD = "hey ai";

/**
 * On-device wake-word gate hint, reported by a handset's keyword-spotter for a transmission:
 *   clear — confidently heard the wake word
 *   maybe — uncertain
 *   none  — confidently did NOT hear it
 * Only "none" is acted on (route off the paid cloud lane); the server stays authoritative.
 */
export type WakeHint = "clear" | "maybe" | "none";

/** Parse an untrusted client `wake` value into a [WakeHint], or undefined when absent/garbage. */
export function normalizeWakeHint(raw: unknown): WakeHint | undefined {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "clear" || s === "maybe" || s === "none" ? s : undefined;
}

/** Normalize a configured wake word for storage / comparison: trim, lowercase, collapse spaces. */
export function normalizeWakeWord(raw: unknown): string {
  return typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a leading-wake-word matcher for `wakeWord`.
 *
 * The "ai" family (the default, whether configured as "ai" or "hey ai") keeps its deliberately
 * tolerant matcher — STT renders it as "AI", "A.I.", "A I", "hey AI" — while staying strict enough
 * (no bare "eye"/"I") that the dispatcher doesn't engage on ordinary speech like "I see a vehicle".
 * Any other configured phrase matches its tokens literally at the start, with flexible
 * whitespace/punctuation and an optional leading "hey".
 */
function wakeWordRegex(wakeWord: string): RegExp {
  const norm = normalizeWakeWord(wakeWord) || DEFAULT_WAKE_WORD;
  if (norm === "ai" || norm === "hey ai") {
    return /^(?:hey[\s,]+)?(?:a\.?\s*i\.?|a\s+i)(?=$|[\s,.:!?-])[\s,.:!?'"-]*/i;
  }
  const stripped = norm.replace(/^hey\s+/, "");
  const tokens = stripped.split(" ").filter(Boolean).map(escapeRegExp);
  const body = tokens.join("[\\s,.:-]+");
  return new RegExp(`^(?:hey[\\s,]+)?${body}(?=$|[\\s,.:!?-])[\\s,.:!?'"-]*`, "i");
}

/**
 * Supervised wake word. Returns the transcript with the leading wake word stripped when present
 * (so the LLM never mistakes it for a callsign), or null when the transmission did not open with
 * the wake word. `wakeWord` is the agency's configured phrase; omitted = the [DEFAULT_WAKE_WORD].
 */
export function stripSupervisedWakeWord(
  transcript: string,
  wakeWord: string = DEFAULT_WAKE_WORD,
): string | null {
  const t = transcript.replace(/^[\s,.]+/, "");
  const m = t.match(wakeWordRegex(wakeWord));
  if (!m) return null;
  return t.slice(m[0].length).trim();
}

/** True when the transmission opens with the supervised wake word. */
export function hasSupervisedWakeWord(
  transcript: string,
  wakeWord: string = DEFAULT_WAKE_WORD,
): boolean {
  return stripSupervisedWakeWord(transcript, wakeWord) !== null;
}
