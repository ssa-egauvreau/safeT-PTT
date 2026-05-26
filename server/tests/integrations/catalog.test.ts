/**
 * Tests for `server/src/integrations/catalog.ts`.
 *
 * The integration catalog is the single source of truth for every per-agency
 * "knob" exposed on the admin Integrations page. It's enforced as the
 * allow-list for two trust-boundary endpoints in `integrations/adminApi.ts`:
 *
 *   - `PUT  /v1/integrations/:key` rejects with 404 `unknown_integration`
 *     unless `isIntegrationKey(key)` is true. A regression that lets an
 *     arbitrary key through writes attacker-controlled `agency_integrations`
 *     rows that bypass the validation/grouping the UI relies on.
 *   - `getIntegrationDefinition(key)` is consulted *after* the gate to decide
 *     `availability !== "active"` → 400. If a coming-soon definition ever
 *     reverts to writable without the UI being ready, agencies can save
 *     values that have no consuming code path.
 *
 * Additional structural invariants matter for the admin UI:
 *   - Keys are unique. The internal `BY_KEY` map silently shadows duplicates
 *     — the FIRST entry wins, which means a duplicated key with a different
 *     `group` / `kind` would split the UI into two competing fields. A
 *     uniqueness test pins this at definition time.
 *   - Every definition belongs to a documented group ID.
 *   - `url` / `secret` / `text` / `multiline` are the only field kinds.
 *
 * A regression in any of these breaks the admin page silently — the
 * integration just stops appearing or stops saving, with no error in logs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INTEGRATION_DEFINITIONS,
  getIntegrationDefinition,
  isIntegrationKey,
  type IntegrationDefinition,
} from "../../src/integrations/catalog.js";

const VALID_KINDS = new Set<IntegrationDefinition["kind"]>([
  "secret",
  "text",
  "url",
  "multiline",
]);

const VALID_GROUPS = new Set<IntegrationDefinition["group"]>([
  "ai_dispatch",
  "webhooks",
  "lookups",
  "ten8_cad",
  "ten8_new_incident",
]);

const VALID_AVAILABILITY = new Set<IntegrationDefinition["availability"]>([
  "active",
  "coming_soon",
]);

// ---------- isIntegrationKey / getIntegrationDefinition ----------------

test("isIntegrationKey returns true for every key in the catalog", () => {
  for (const def of INTEGRATION_DEFINITIONS) {
    assert.equal(isIntegrationKey(def.key), true, `definition "${def.key}" must be a known key`);
  }
});

test("isIntegrationKey returns false for unknown / empty / case-mangled keys", () => {
  // Case is significant — `agency_integrations.key` is stored verbatim, so
  // the allow-list match has to be exact.
  assert.equal(isIntegrationKey(""), false);
  assert.equal(isIntegrationKey("not_a_real_key"), false);
  assert.equal(isIntegrationKey("ELEVENLABS_API_KEY"), false);
  assert.equal(isIntegrationKey(" elevenlabs_api_key"), false);
  assert.equal(isIntegrationKey("elevenlabs_api_key "), false);
});

test("getIntegrationDefinition returns the matching definition by key", () => {
  const def = getIntegrationDefinition("elevenlabs_api_key");
  assert.ok(def);
  assert.equal(def!.key, "elevenlabs_api_key");
  assert.equal(def!.group, "ai_dispatch");
  assert.equal(def!.kind, "secret");
  assert.equal(def!.availability, "active");
});

test("getIntegrationDefinition returns undefined for an unknown key (admin endpoint guard)", () => {
  // The admin PUT endpoint relies on undefined here to short-circuit to 404
  // *before* dereferencing the result. Throwing or returning a stub would
  // break that contract.
  assert.equal(getIntegrationDefinition("not_a_real_key"), undefined);
  assert.equal(getIntegrationDefinition(""), undefined);
});

// ---------- structural invariants over the whole catalog ----------------

test("INTEGRATION_DEFINITIONS keys are unique (UI cannot survive duplicates)", () => {
  const seen = new Map<string, IntegrationDefinition>();
  for (const def of INTEGRATION_DEFINITIONS) {
    const prev = seen.get(def.key);
    assert.equal(
      prev,
      undefined,
      `duplicate integration key "${def.key}" (first group=${prev?.group} kind=${prev?.kind}, second group=${def.group} kind=${def.kind})`,
    );
    seen.set(def.key, def);
  }
});

test("every definition has a non-empty label and description", () => {
  // The Integrations page renders these as the field label / helper text.
  // Empty values would ship as blank UI rows that admins can't make sense of.
  for (const def of INTEGRATION_DEFINITIONS) {
    assert.ok(def.label.trim().length > 0, `key "${def.key}" must have a non-empty label`);
    assert.ok(
      def.description.trim().length > 0,
      `key "${def.key}" must have a non-empty description`,
    );
  }
});

test("every definition's group / kind / availability is one of the documented enums", () => {
  // These are typed as string literal unions; runtime invariants matter
  // because new JSON / config that produces these definitions could drift.
  for (const def of INTEGRATION_DEFINITIONS) {
    assert.ok(VALID_KINDS.has(def.kind), `key "${def.key}" has unknown kind "${def.kind}"`);
    assert.ok(VALID_GROUPS.has(def.group), `key "${def.key}" has unknown group "${def.group}"`);
    assert.ok(
      VALID_AVAILABILITY.has(def.availability),
      `key "${def.key}" has unknown availability "${def.availability}"`,
    );
  }
});

test("integration keys match the conservative [a-z0-9_] convention (safe for URL params and DB keys)", () => {
  // The admin PUT endpoint takes :key from the URL and passes it to the
  // store keyed lookup. Constraining the alphabet makes URL handling and
  // SQL identifier-style logging unambiguous.
  for (const def of INTEGRATION_DEFINITIONS) {
    assert.match(
      def.key,
      /^[a-z0-9_]+$/,
      `key "${def.key}" must be lowercase letters / digits / underscores only`,
    );
  }
});

// ---------- spot checks on the security-critical entries ---------------

test("ten8_webhook_secret is registered as a SECRET (UI masks the value)", () => {
  // The mask logic in mask.ts keys off `kind === "secret"`. If this field
  // ever flips to "text", the admin page leaks the bearer token to anyone
  // with screen access.
  const def = getIntegrationDefinition("ten8_webhook_secret");
  assert.ok(def);
  assert.equal(def!.kind, "secret");
});

test("plate / VIN / map API keys are SECRETS", () => {
  for (const key of [
    "elevenlabs_api_key",
    "license_plate_lookup_api_key",
    "vin_lookup_api_key",
    "google_maps_geocoding_api_key",
    "ten8_api_key",
    "ten8_api_secret",
    "ten8_new_incident_api_key",
    "ten8_new_incident_api_secret",
  ]) {
    const def = getIntegrationDefinition(key);
    assert.ok(def, `expected catalog entry for "${key}"`);
    assert.equal(def!.kind, "secret", `key "${key}" must be a secret (UI masking depends on it)`);
  }
});

test("outbound webhook URL is registered as kind 'url' (UI validation hint)", () => {
  const def = getIntegrationDefinition("outbound_webhook_url");
  assert.ok(def);
  assert.equal(def!.kind, "url");
});

test("ai_dispatch_system_prompt is multiline (otherwise the admin page renders a single-line input)", () => {
  // This is a multi-paragraph prompt with explicit newlines; a single-line
  // input strips them on save, breaking the prompt formatting silently.
  const def = getIntegrationDefinition("ai_dispatch_system_prompt");
  assert.ok(def);
  assert.equal(def!.kind, "multiline");
});
