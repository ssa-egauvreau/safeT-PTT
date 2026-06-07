/** Belt-and-suspenders 10-33 / 10-34 detection (matches 10-8 alert dashboard). */

const RE_10_33 = /\b(10[\s-]?33|ten[\s-]?thirty[\s-]?three)\b/i;
const RE_10_34 = /\b(10[\s-]?34|ten[\s-]?thirty[\s-]?four)\b/i;

export type EmergencyCodeAction = "activate" | "clear";

export function detectEmergencyCodeFromTranscript(text: string): EmergencyCodeAction | null {
  const t = text.trim();
  if (!t) {
    return null;
  }
  if (RE_10_34.test(t)) {
    return "clear";
  }
  if (RE_10_33.test(t)) {
    return "activate";
  }
  return null;
}

/** Replace legacy Zello channel names with the safeT channel the unit is on. */
export function adaptDispatcherResponseForChannel(response: string, channelName: string): string {
  const ch = channelName.trim();
  if (!ch) {
    return response;
  }
  return response.replace(/\bgreen[\s-]?1\b/gi, ch);
}
