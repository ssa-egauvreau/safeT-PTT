/**
 * Tests for `server/src/aiDispatch/speech/precachePhrases.ts`.
 *
 * Why this matters
 * ----------------
 * `precachePhrases.ts` is the contract that decides which AI-dispatch
 * acknowledgments are paid for + synthesised ONCE at startup vs paid for +
 * synthesised on every single radio ack on the hot path. The two exported
 * helpers are joined at the hip:
 *
 *   - `normalizeForTtsPrecache(text)` is used by BOTH the write side
 *     (`precachePhrase` populates the cache under this key) AND the read
 *     side (`getTtsPrecacheHit` looks up under this key). A regression in
 *     the normaliser silently dead-locks the cache: writes use one key,
 *     reads use another, and every single TTS request falls through to a
 *     live ElevenLabs call.
 *
 *   - `buildPrecachePhraseList()` is the entire universe of phrases that
 *     ever get warmed. Anything dropped from this list becomes a guaranteed
 *     cold-cache call on the air. The current list is intentionally aligned
 *     with what `buildDeterministicDispatchAck` produces (`Copy 040.`,
 *     `Copy 27-010, 415.`, …) and with the `913` / `10-2` / `10-X` shapes
 *     the engine emits.
 *
 * Regressions guarded against
 * ---------------------------
 *  1. Normaliser drifts so that the cache write key no longer equals the
 *     cache read key for the same phrase (silent 100% miss rate).
 *  2. Normaliser stops stripping a trailing `.` / `!` / `?` so live ack
 *     strings like `"Copy 040, 10-8."` no longer find the warmed
 *     `"Copy 040, 10-8"` entry.
 *  3. Normaliser stops case-folding so `"Copy"` (capital C from
 *     `buildDeterministicDispatchAck`) misses the lower-cased cache key.
 *  4. Normaliser stops collapsing internal whitespace so a phrase that
 *     ever ships with a stray double-space prints as a cold call.
 *  5. The phrase list silently shrinks (someone tightens a loop or removes
 *     a unit). Cold cache on a high-traffic radio unit's most common ack
 *     is invisible until the ElevenLabs bill comes in.
 *  6. The phrase list silently grows in a way that collides on the
 *     normalised key (two different strings normalising to the same key
 *     means one of them is never actually cached as written).
 *  7. The list stops being deduped — used to define the work queue in
 *     `runPrecacheJob`, so a duplicate is a wasted paid TTS call at boot.
 *  8. The command-staff (27-0X0) standby phrases get dropped — those are
 *     the highest-stakes acks on the channel and a cold-call latency hit
 *     is exactly when it matters most.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrecachePhraseList,
  normalizeForTtsPrecache,
} from "../../../src/aiDispatch/speech/precachePhrases.js";

// ===== normalizeForTtsPrecache ===========================================

test("normalizeForTtsPrecache: lower-cases so capital-C 'Copy' hits the warmed key", () => {
  // `buildDeterministicDispatchAck` and the canned phrases both produce
  // strings starting with a capital letter ("Copy 040, 415."). The cache
  // is keyed lower-case so the lookup must lower-case too.
  assert.equal(normalizeForTtsPrecache("Copy"), "copy");
  assert.equal(normalizeForTtsPrecache("COPY"), "copy");
  assert.equal(normalizeForTtsPrecache("cOpY"), "copy");
});

test("normalizeForTtsPrecache: trims leading and trailing whitespace", () => {
  assert.equal(normalizeForTtsPrecache("  Copy  "), "copy");
  assert.equal(normalizeForTtsPrecache("\tCopy\n"), "copy");
});

test("normalizeForTtsPrecache: collapses internal whitespace to a single space", () => {
  // A phrase that ever ships with a stray double space must NOT keep its
  // double space in the cache key — that would put writes and reads into
  // different buckets the moment any caller cleaned up their input.
  assert.equal(normalizeForTtsPrecache("Copy   040"), "copy 040");
  assert.equal(normalizeForTtsPrecache("Copy\t040"), "copy 040");
  assert.equal(normalizeForTtsPrecache("Copy\n\n040"), "copy 040");
  assert.equal(normalizeForTtsPrecache("  Copy    040,   10-8  "), "copy 040, 10-8");
});

test("normalizeForTtsPrecache: strips trailing `.` / `!` / `?` (single and repeated)", () => {
  // `buildDeterministicDispatchAck` ends its strings with a period
  // (`"Copy 040, 415."`). The warmed phrase list intentionally stores
  // these without trailing punctuation so the normaliser is what bridges
  // the two sides. If the strip regex regresses, every live ack misses.
  assert.equal(normalizeForTtsPrecache("Copy 040, 415."), "copy 040, 415");
  assert.equal(normalizeForTtsPrecache("Copy!"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy?"), "copy");
  assert.equal(normalizeForTtsPrecache("Copy 040, 10-8..."), "copy 040, 10-8");
  assert.equal(normalizeForTtsPrecache("Copy 040, 10-8?!?"), "copy 040, 10-8");
  // Punctuation in the MIDDLE must survive — "Copy 040, 10-8" depends on
  // the comma and hyphen.
  assert.equal(normalizeForTtsPrecache("Copy 040, 10-8"), "copy 040, 10-8");
});

test("normalizeForTtsPrecache: trailing-punctuation strip does not eat punctuation that's followed by trailing whitespace", () => {
  // The full pipeline is: trim → collapse whitespace → strip trailing
  // punctuation → lower-case. So a trailing-period-then-space input
  // first becomes "Copy 040.", then "copy 040" after the strip.
  assert.equal(normalizeForTtsPrecache("Copy 040.   "), "copy 040");
});

test("normalizeForTtsPrecache: empty / whitespace-only input becomes empty string (does not throw)", () => {
  // The route may hand us undefined/null/etc — the helper coerces via
  // String() and must not blow up the TTS hot path on a degenerate input.
  assert.equal(normalizeForTtsPrecache(""), "");
  assert.equal(normalizeForTtsPrecache("   "), "");
  assert.equal(normalizeForTtsPrecache("\t\n"), "");
});

test("normalizeForTtsPrecache: coerces non-string input through String() without throwing", () => {
  // `getTtsPrecacheHit` takes a `string`, but the engine flows values from
  // `parsed.dispatcher_response` and similar fields that have historically
  // been `unknown` at runtime. Defending against non-string input here
  // means a single malformed parse can never panic the TTS path.
  assert.equal(normalizeForTtsPrecache(42 as unknown as string), "42");
  assert.equal(normalizeForTtsPrecache(null as unknown as string), "null");
  assert.equal(normalizeForTtsPrecache(undefined as unknown as string), "undefined");
  assert.equal(
    normalizeForTtsPrecache({ toString: () => "Copy 040" } as unknown as string),
    "copy 040",
  );
});

test("normalizeForTtsPrecache: is idempotent — re-normalising a key returns the same key", () => {
  // Important invariant: f(f(x)) === f(x). Without this, a cache populated
  // by one code path that pre-normalised would silently miss reads from a
  // path that handed in raw text.
  for (const raw of [
    "Copy 040.",
    "  Copy  040,  10-8  ",
    "AFFIRM 27-010, 10-2!",
    "Roger?",
    "  ",
    "Plain",
  ]) {
    const once = normalizeForTtsPrecache(raw);
    const twice = normalizeForTtsPrecache(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(raw)}`);
  }
});

// ===== buildPrecachePhraseList ===========================================

test("buildPrecachePhraseList: returns a non-empty, deduped array of non-empty strings", () => {
  const phrases = buildPrecachePhraseList();
  assert.ok(Array.isArray(phrases));
  assert.ok(phrases.length > 0, "phrase list must not be empty");
  // No empty / whitespace entries — they would be paid for at boot and never hit.
  for (const p of phrases) {
    assert.equal(typeof p, "string");
    assert.ok(p.trim().length > 0, `empty/whitespace phrase: ${JSON.stringify(p)}`);
  }
  // Deduped (the producer uses a Set, but a regression that converted it
  // back to a plain array could silently duplicate entries; that's a paid
  // TTS call wasted at boot per duplicate).
  assert.equal(
    new Set(phrases).size,
    phrases.length,
    "phrase list contains duplicates — pre-cache job would re-synthesise the same line",
  );
});

test("buildPrecachePhraseList: includes every generic boilerplate ack", () => {
  // These are the universal short acks the AI dispatcher reaches for
  // hundreds of times a shift. Each one cold = pointless paid TTS call.
  const phrases = new Set(buildPrecachePhraseList());
  for (const expected of [
    "Copy",
    "10-4",
    "Standby",
    "Negative",
    "Affirm",
    "That's affirm",
    "Received",
    "I copy",
    "Roger",
    "Copy. Standby.",
  ]) {
    assert.ok(
      phrases.has(expected),
      `generic ack missing from precache list: ${JSON.stringify(expected)}`,
    );
  }
});

test("buildPrecachePhraseList: includes the canonical line-unit acks for every documented RADIO_UNIT", () => {
  // RADIO_UNITS is the patrol-callsign set the precache list pins. A
  // regression that drops a unit silently makes EVERY ack to that unit a
  // cold call. Locking the exact set here means changing it is a
  // deliberate review (matches the on-air callsign convention).
  const RADIO_UNITS = ["151", "231", "334", "351", "352", "401", "402", "403"];
  const phrases = new Set(buildPrecachePhraseList());

  for (const u of RADIO_UNITS) {
    assert.ok(phrases.has(`Copy ${u}`), `missing "Copy ${u}"`);
    // 913 = "10-9 your last" radio ack pattern.
    assert.ok(phrases.has(`${u}, 913`), `missing "${u}, 913"`);
    // 10-2 affirm shapes.
    assert.ok(phrases.has(`Affirm ${u}, 10-2`), `missing "Affirm ${u}, 10-2"`);
    // Per-unit status changes the dispatcher hears constantly.
    for (const tencode of ["10-8", "10-7", "10-23", "10-97", "10-98", "10-19", "code 4"]) {
      assert.ok(
        phrases.has(`Copy ${u}, ${tencode}`),
        `missing per-unit status ack: "Copy ${u}, ${tencode}"`,
      );
    }
    // Per-unit standby.
    assert.ok(
      phrases.has(`${u}, copy. Standby.`),
      `missing per-unit standby: "${u}, copy. Standby."`,
    );
  }
});

test("buildPrecachePhraseList: includes the command-staff (27-0X0) standby phrases", () => {
  // 27-000 / 27-010 / 27-020 / 27-030 are command staff. Per
  // dispatchAck.ts, command-staff callsigns deliberately KEEP the 27-
  // prefix on the air (a regression already covered by dispatchAck.test).
  // The precache list must mirror that — otherwise the highest-priority
  // ack on the channel is the one that ships cold every time.
  const COMMAND_UNITS = ["27-000", "27-010", "27-020", "27-030"];
  const phrases = new Set(buildPrecachePhraseList());
  for (const u of COMMAND_UNITS) {
    assert.ok(
      phrases.has(`${u}, copy. Standby.`),
      `missing command-staff standby: "${u}, copy. Standby."`,
    );
  }
});

test("buildPrecachePhraseList: includes the unit-agnostic 'Affirm, you're 10-2' shape", () => {
  // Defensive: this string is repeated identically in the loop for each
  // unit (Set dedupes them down to one). If the loop body ever stops
  // emitting this exact wording the agnostic ack disappears from cache.
  const phrases = new Set(buildPrecachePhraseList());
  assert.ok(phrases.has("Affirm, you're 10-2"));
});

test("buildPrecachePhraseList: every phrase is unique under normalizeForTtsPrecache (no silent collisions)", () => {
  // The cache is keyed by `normalizeForTtsPrecache(phrase)`. If two
  // different phrases ever normalise to the same key, whichever one ran
  // second during boot would overwrite the first — the "lost" phrase
  // would silently miss the cache forever.
  const phrases = buildPrecachePhraseList();
  const normalisedToFirst = new Map<string, string>();
  for (const p of phrases) {
    const key = normalizeForTtsPrecache(p);
    const prior = normalisedToFirst.get(key);
    if (prior !== undefined) {
      assert.fail(
        `phrases collide under normalizeForTtsPrecache key=${JSON.stringify(key)}: ` +
          `${JSON.stringify(prior)} vs ${JSON.stringify(p)}`,
      );
    }
    normalisedToFirst.set(key, p);
  }
});

test("buildPrecachePhraseList: trailing-period live ack lookups (`Copy 151, 10-8.`) hit the cached form (`Copy 151, 10-8`)", () => {
  // Integration of the two helpers — this is the actual contract that
  // matters on the hot path. `buildDeterministicDispatchAck` returns
  // strings WITH a trailing period; the cache stores phrases WITHOUT one;
  // the normaliser is the bridge. Pin the end-to-end behaviour for at
  // least the highest-traffic acks so a future refactor of either side
  // can't quietly break the cache-hit rate.
  //
  // We use "151" rather than "040" because RADIO_UNITS in precachePhrases
  // is the SSA patrol callsign set ("151", "231", "334", "351", "352",
  // "401", "402", "403"). The bare-callsign warm set keys off that list.
  const cached = new Set(buildPrecachePhraseList().map((p) => normalizeForTtsPrecache(p)));

  // A line-unit 10-8 ack the way the engine actually speaks it.
  assert.ok(
    cached.has(normalizeForTtsPrecache("Copy 151, 10-8.")),
    "live trailing-period ack 'Copy 151, 10-8.' must hit a warmed entry",
  );
  // Bare-callsign Copy (no status code).
  assert.ok(
    cached.has(normalizeForTtsPrecache("Copy 151.")),
    "live trailing-period ack 'Copy 151.' must hit a warmed entry",
  );
  // The bare "Copy" / "Roger" boilerplate must also match through trailing punctuation.
  assert.ok(
    cached.has(normalizeForTtsPrecache("Copy.")),
    "bare 'Copy.' must hit the warmed 'Copy' entry",
  );
  assert.ok(
    cached.has(normalizeForTtsPrecache("Roger!")),
    "bare 'Roger!' must hit the warmed 'Roger' entry",
  );

  // 913 ack for a documented patrol unit.
  assert.ok(
    cached.has(normalizeForTtsPrecache("151, 913.")),
    "trailing-period '151, 913.' must hit the warmed '151, 913' entry",
  );
});

test("buildPrecachePhraseList: command-staff trailing-period standby (`27-010, copy. Standby.`) hits the cached form", () => {
  // Same integration check for the command-staff branch — these are the
  // highest-priority acks on the air and the regression we care about
  // most: even an extra period from a future ack builder must not bypass
  // the cache for command staff.
  const cached = new Set(buildPrecachePhraseList().map((p) => normalizeForTtsPrecache(p)));
  // Note: the cached form is `"27-010, copy. Standby."` which normalises
  // to `"27-010, copy. standby"` (only the FINAL trailing period is
  // stripped). The live ack with the same exact wording therefore
  // produces the same key.
  assert.ok(
    cached.has(normalizeForTtsPrecache("27-010, copy. Standby.")),
    "live command-staff standby ack must hit the warmed entry",
  );
});

test("buildPrecachePhraseList: list size is bounded enough to stay within ElevenLabs free-tier budget", () => {
  // Defensive: a regression that exploded the list (e.g. a Cartesian
  // product across units + codes added later) would torch the boot
  // bandwidth + spend on every agency. A few hundred phrases is the
  // historical shape — pin a generous ceiling so a runaway addition is
  // caught in CI, not on the bill.
  const phrases = buildPrecachePhraseList();
  assert.ok(
    phrases.length < 500,
    `phrase list grew to ${phrases.length} — confirm this is intentional ` +
      `(every entry is a paid ElevenLabs call at agency boot)`,
  );
  // And the lower bound — locks in that the documented per-unit and
  // generic blocks are all there. Below this means a meaningful subset
  // disappeared.
  assert.ok(
    phrases.length >= 80,
    `phrase list shrank to ${phrases.length} — a per-unit block was likely dropped`,
  );
});
