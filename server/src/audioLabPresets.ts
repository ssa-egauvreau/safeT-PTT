/**
 * Pure helpers for the per-agency Audio Lab presets feature
 * (`GET/PUT/DELETE /v1/admin/audio-lab-presets`).
 *
 * Kept dependency-free so the validation and summary logic can be unit
 * tested without spinning up Express or Postgres.
 */

/** Reserved preset name held back for a future "factory reset" alias. */
export const RESERVED_PRESET_NAMES: ReadonlySet<string> = new Set(["default"]);

/** Max characters allowed in a preset name (matches the route validation). */
export const PRESET_NAME_MAX = 64;

/** Permitted character class for a preset name. */
const PRESET_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

/**
 * Validates a preset name against the operator-facing constraints.
 *
 * Rules:
 *  - 1 – {@link PRESET_NAME_MAX} characters (post-trim).
 *  - Alphanumeric, space, dash, underscore only — no slashes / quotes / dots
 *    so the same string can safely round-trip through a URL path segment
 *    and a JSON body without any extra encoding ceremony.
 *  - Case-insensitively rejects {@link RESERVED_PRESET_NAMES} so the reserved
 *    slot can be wired up later without breaking an agency that already
 *    saved a preset under that name today.
 */
export function isValidPresetName(name: unknown): name is string {
  if (typeof name !== "string") {
    return false;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > PRESET_NAME_MAX) {
    return false;
  }
  if (!PRESET_NAME_PATTERN.test(trimmed)) {
    return false;
  }
  if (RESERVED_PRESET_NAMES.has(trimmed.toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * One-line, operator-readable summary of an AudioLabConfig. Returned by the
 * list endpoint so the dropdown can show "AGC, presence bell, roger beep"
 * next to each name without forcing the client to fetch the full body.
 *
 * The function is intentionally tolerant of partial / unknown shapes — it
 * inspects only the fields it understands and degrades to "custom config"
 * when nothing recognisable is enabled.
 */
export function summarizePreset(config: unknown): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "empty config";
  }
  const cfg = config as Record<string, unknown>;
  const pre = (cfg.preImbe ?? {}) as Record<string, unknown>;
  const post = (cfg.postDecode ?? {}) as Record<string, unknown>;

  const tags: string[] = [];
  if (pre.bypassMicProcessing) {
    tags.push("bypass");
  } else if (pre.agcEnabled) {
    tags.push("AGC");
  }
  if (pre.windGateEnabled || pre.windHpfEnabled) {
    tags.push("wind reduction");
  }
  if (post.hpfEnabled || post.lpfEnabled || post.lowShelfEnabled || post.highShelfEnabled) {
    tags.push("EQ");
  }
  if (post.presenceEnabled) {
    tags.push("presence bell");
  }
  if (post.compressorEnabled) {
    tags.push("compressor");
  }
  const sat = Number(post.saturationAmount ?? 0);
  if (Number.isFinite(sat) && sat > 0) {
    tags.push("saturation");
  }
  if (post.rogerBeepEnabled) {
    tags.push("roger beep");
  }
  if (post.squelchTailEnabled) {
    tags.push("squelch tail");
  }
  const dmr = Number(post.dmrCharacter ?? 0);
  if (Number.isFinite(dmr) && dmr > 0) {
    tags.push(`DMR ${Math.round(dmr)}`);
  }
  if (tags.length === 0) {
    return "no shaping";
  }
  return tags.join(", ");
}
