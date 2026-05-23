/**
 * Tests for `server/src/integrations/mask.ts`.
 *
 * `maskSecret` is the function that decides what the admin Integrations
 * page shows for a configured value. If a regression here returns the
 * full secret instead of the masked form, raw API keys leak into the
 * web console UI (and into anything that scrapes / logs the rendered
 * page). The opposite regression (return null when there IS a value)
 * makes the page look unconfigured and tempts an admin to paste the
 * key in again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { maskSecret } from "../../src/integrations/mask.js";

test("maskSecret: empty / whitespace input → null (treated as unset)", () => {
  assert.equal(maskSecret("", "secret"), null);
  assert.equal(maskSecret("   ", "secret"), null);
  assert.equal(maskSecret("", "text"), null);
});

test("maskSecret: a secret longer than 4 chars shows only the last 4", () => {
  assert.equal(maskSecret("sk_test_abcd1234", "secret"), "••••1234");
});

test("maskSecret: a secret of 4 or fewer chars masks everything", () => {
  // Don't leak the entire short value as a "last 4".
  assert.equal(maskSecret("abcd", "secret"), "••••");
  assert.equal(maskSecret("ab", "secret"), "••••");
});

test("maskSecret: secret kind never returns the original cleartext", () => {
  const cleartext = "sk_test_abcdef0123456789";
  const masked = maskSecret(cleartext, "secret");
  assert.notEqual(masked, cleartext);
  assert.ok(masked && !masked.includes("sk_test_abcdef0"));
});

test("maskSecret: multiline kind reports character count, not contents", () => {
  const prompt = "A".repeat(2500);
  const masked = maskSecret(prompt, "multiline");
  assert.ok(masked);
  assert.match(masked!, /2,500 characters configured/);
  assert.ok(!masked!.includes("A"), "multiline mask must never echo content");
});

test("maskSecret: url kind truncates only when the URL is long", () => {
  const short = "https://example.com";
  assert.equal(maskSecret(short, "url"), short);

  const long =
    "https://hooks.example.com/services/T012345/B987654/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
  const masked = maskSecret(long, "url");
  assert.ok(masked);
  assert.match(masked!, /…/, "long url must be elided with an ellipsis");
  assert.ok(masked!.length < long.length);
});

test("maskSecret: text kind returns the (trimmed) value verbatim — it's not sensitive", () => {
  assert.equal(maskSecret("  hello  ", "text"), "hello");
});
