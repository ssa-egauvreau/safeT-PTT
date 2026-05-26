/**
 * Tests for `server/src/aiDispatch/speech/stateSpeech.ts`.
 *
 * `expandUSStatesForSpeech` is run before street-type expansion so abbreviations
 * like "CA" at the end of an address become "California" before ElevenLabs
 * speaks them. The regex is deliberately tight — it only matches an uppercase
 * 2-letter abbreviation that follows a comma — so we don't replace "CA" inside
 * a word or replace lowercase "ca" (which can mean "citizen assist" elsewhere
 * in the speech pipeline).
 *
 * Locking the regex contract here protects two ways the AI dispatcher
 * pronounces things on the air:
 *   - addresses get spoken with the full state name, AND
 *   - the call-type "ca" (citizen assist) check downstream is not poisoned by
 *     a too-eager state expander matching the lowercase token.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  US_STATE_SPOKEN,
  expandUSStatesForSpeech,
} from "../../../src/aiDispatch/speech/stateSpeech.js";

test("expandUSStatesForSpeech: ', CA' → ', California'", () => {
  assert.equal(expandUSStatesForSpeech("Anaheim, CA"), "Anaheim, California");
});

test("expandUSStatesForSpeech: handles multi-word state names like NY → 'New York'", () => {
  assert.equal(expandUSStatesForSpeech("Anaheim, NY"), "Anaheim, New York");
});

test("expandUSStatesForSpeech: lowercase 'ca' is intentionally NOT expanded", () => {
  // Lowercase 'ca' is reserved as the call-type token for "citizen assist".
  // Expanding it to "California" would mis-speak the dispatcher's ack.
  assert.equal(expandUSStatesForSpeech("Anaheim, ca"), "Anaheim, ca");
});

test("expandUSStatesForSpeech: only matches after a comma (not embedded in words)", () => {
  // "AnaheimCA" has no comma — must NOT be touched. A regression that lifts
  // the comma requirement would rewrite arbitrary words containing CA.
  assert.equal(expandUSStatesForSpeech("AnaheimCA"), "AnaheimCA");
});

test("expandUSStatesForSpeech: unknown 2-letter token is left intact", () => {
  // ZZ is not a state — must not be fabricated.
  assert.equal(expandUSStatesForSpeech("Foo, ZZ"), "Foo, ZZ");
});

test("expandUSStatesForSpeech: replaces every occurrence in the string", () => {
  // The regex is /g; ensure repeated state tokens all expand (locks in /g).
  assert.equal(
    expandUSStatesForSpeech("Foo, CA, Bar, NY"),
    "Foo, California, Bar, New York",
  );
});

test("expandUSStatesForSpeech: state token followed by more text still expands (\\b after abbr)", () => {
  // The match needs ", CA\b", so ", CA Bar" should still pull California out.
  assert.equal(
    expandUSStatesForSpeech("Foo, CA Bar"),
    "Foo, California Bar",
  );
});

test("expandUSStatesForSpeech: empty string passes through", () => {
  assert.equal(expandUSStatesForSpeech(""), "");
});

// ---------- data-table invariants ---------------------------------------

test("US_STATE_SPOKEN: covers all 50 states + DC (51 entries)", () => {
  // A regression that drops a state from the table would silently leave that
  // abbreviation unspoken on the air. Lock the count.
  assert.equal(Object.keys(US_STATE_SPOKEN).length, 51);
});

test("US_STATE_SPOKEN: every key is exactly two uppercase letters", () => {
  // The expansion regex matches /[A-Z]{2}/, so any key that isn't 2 upper
  // letters can never be hit. Lock the format.
  for (const k of Object.keys(US_STATE_SPOKEN)) {
    assert.match(k, /^[A-Z]{2}$/, k);
  }
});

test("US_STATE_SPOKEN: every value is a non-empty string", () => {
  for (const [k, v] of Object.entries(US_STATE_SPOKEN)) {
    assert.equal(typeof v, "string", k);
    assert.ok(v.length > 0, `${k} → empty`);
  }
});

test("US_STATE_SPOKEN: a known-tricky sampling matches what's on the radio today", () => {
  // Pin a small representative sample so a rename of one entry is loud.
  assert.equal(US_STATE_SPOKEN.CA, "California");
  assert.equal(US_STATE_SPOKEN.NY, "New York");
  assert.equal(US_STATE_SPOKEN.DC, "District of Columbia");
  assert.equal(US_STATE_SPOKEN.NH, "New Hampshire");
  assert.equal(US_STATE_SPOKEN.WV, "West Virginia");
});
