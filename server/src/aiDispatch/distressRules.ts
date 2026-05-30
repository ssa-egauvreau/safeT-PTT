import type { AiDispatchParseResult } from "./parse.js";
import { detectEmergencyCodeFromTranscript } from "./emergencyCodes.js";
import { formatUnitIdForRadio, resolveUnitFullAddressForRadio } from "./unitLocation.js";

/** Officer distress — auto 10-33 with GPS address (server-side, not LLM-only). */
const DISTRESS_ALWAYS_RE =
  /\bshots?\s+fired\b|\b(?:i'?m|we'?re)\s+in\s+a\s+fight\b|\bofficer\s+down\b|\b(?:need|request(?:ing)?)\s+code\s+3\b|\bcode\s+3\s+assist/i;

const DISTRESS_HELP_RE =
  /\b(?:i\s+)?need\s+help\b|\bhelp\s+me\b|\b(?:send|need)\s+(?:backup|assistance|assist)\b|\b(?:under\s+)?attack\b|\bbeing\s+assaulted\b/i;

/** Plate/CAD lookups that mention "help" but are not officer distress. */
function isNonEmergencyHelpContext(transcript: string): boolean {
  return /\b(?:plate|912|913|968|lookup|look\s+up|call\s+number|incident\s+\d{2,4}-\d|ten8|dmv)\b/i.test(
    transcript,
  );
}

export function detectOfficerDistressFromTranscript(text: string): boolean {
  const tx = text.trim();
  if (!tx) {
    return false;
  }
  if (detectEmergencyCodeFromTranscript(tx) === "clear") {
    return false;
  }
  if (DISTRESS_ALWAYS_RE.test(tx)) {
    return true;
  }
  if (DISTRESS_HELP_RE.test(tx) && !isNonEmergencyHelpContext(tx)) {
    return true;
  }
  return false;
}

/**
 * Force emergency intent when distress language is heard so 10-33 activates even if the LLM mis-classifies.
 */
export function applyDistressDispatchRules(
  parsed: AiDispatchParseResult,
  transcript: string,
): AiDispatchParseResult {
  if (!detectOfficerDistressFromTranscript(transcript)) {
    return parsed;
  }
  const summary =
    parsed.summary?.trim() ||
    `EMERGENCY: Officer distress — ${transcript.trim().slice(0, 160)}`;
  return {
    ...parsed,
    actionable: true,
    intent: "emergency",
    trigger_emergency_tone: true,
    dispatcher_response: null,
    summary,
  };
}

/** On-air: "All units 10-33, {unit} needs assistance at {full GPS address}". */
export async function buildDistressTen33Callout(
  agencyId: number,
  assistingUnit: string | null | undefined,
): Promise<string> {
  const unitSpoken = formatUnitIdForRadio(assistingUnit);
  const unitRaw = assistingUnit?.trim();
  if (!unitRaw) {
    return `All units 10-33, ${unitSpoken} needs assistance, unit unknown on the radio map.`;
  }

  const address = await resolveUnitFullAddressForRadio(agencyId, unitRaw);
  if (!address) {
    return `All units 10-33, ${unitSpoken} needs assistance, no recent GPS or address on the radio map.`;
  }

  return `All units 10-33, ${unitSpoken} needs assistance at ${address}.`;
}
