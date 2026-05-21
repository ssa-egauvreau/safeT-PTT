import { accountCodeDashForm } from "./speech/numbers.js";
import type { AiDispatchParseResult } from "./parse.js";

/**
 * Override AI dispatcher_response for dispatch/on_scene so voice matches structured fields.
 * From 10-8-alert-dashboard buildDeterministicDispatchAck().
 */
export function buildDeterministicDispatchAck(
  parsed: AiDispatchParseResult,
  requestingUnit?: string | null,
): string | null {
  if (!["dispatch", "on_scene"].includes(parsed.intent)) {
    return null;
  }
  const unit = requestingUnit || parsed.unit;
  if (!unit) {
    return null;
  }
  const csShort = /^27-0[0-3]0$/.test(unit) ? unit : unit.replace(/^27-/, "");
  const code = parsed.code || null;

  let locationPhrase: string | null = null;
  if (parsed.location_code) {
    locationPhrase = accountCodeDashForm(String(parsed.location_code));
  } else if (parsed.location_name) {
    locationPhrase = parsed.location_name;
  }

  if (parsed.intent === "dispatch") {
    if (code && locationPhrase) {
      return `Copy ${csShort}, ${code} at ${locationPhrase}.`;
    }
    if (code) {
      return `Copy ${csShort}, ${code}.`;
    }
    if (locationPhrase) {
      return `Copy ${csShort}, at ${locationPhrase}.`;
    }
    return `Copy ${csShort}.`;
  }

  if (parsed.intent === "on_scene") {
    if (locationPhrase) {
      return `Copy ${csShort}, on scene at ${locationPhrase}.`;
    }
    return `Copy ${csShort}, on scene.`;
  }

  return null;
}
