import type { IntegrationFieldKind } from "./catalog.js";

/** Last four characters for display, or empty when unset. */
export function maskSecret(value: string, kind: IntegrationFieldKind): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (kind === "secret") {
    if (trimmed.length <= 4) {
      return "••••";
    }
    return `••••${trimmed.slice(-4)}`;
  }
  if (kind === "multiline") {
    return `${trimmed.length.toLocaleString()} characters configured`;
  }
  if (kind === "url" && trimmed.length > 48) {
    return `${trimmed.slice(0, 24)}…${trimmed.slice(-12)}`;
  }
  return trimmed;
}
