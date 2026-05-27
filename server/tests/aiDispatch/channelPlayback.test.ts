/**
 * Tests for `server/src/aiDispatch/channelPlayback.ts`.
 *
 * `withChannelPlaybackLock` is the per-channel mutex that serialises every
 * audio playback the AI dispatcher fans onto a radio channel — TTS replies,
 * the 10-33 marker burst loop, and any future channel-scoped audio. Two
 * playbacks landing concurrently on the same channel would talk over each
 * other on the air, so the lock is what guarantees the field hears clean,
 * sequential dispatcher audio.
 *
 * The most painful failure mode this file guards against is commit
 * `e710d68` — the original implementation built a self-referential promise
 * chain (the gate only resolved after `fn` ran, but `fn` only ran after
 * the gate resolved). The result was an immediate deadlock on the very
 * first playback: the AI dispatcher would process one transmission, speak
 * the reply, and then go permanently silent until the next redeploy. The
 * symptom in production was "AI dispatcher works on first call, then
 * stops"; the root cause was invisible from the engine logs (the call
 * stack just sat in `await run`).
 *
 * The tests below pin the behaviours that would have caught that incident:
 *
 *   1. A sequence of three playbacks on the same channel all complete and
 *      preserve their submission order (locks the "no deadlock" invariant).
 *
 *   2. A rejected playback does NOT poison the channel: the next playback
 *      still runs (locks the `tails.set(run.then(undefined, undefined))`
 *      sanitisation contract — without it a single TTS failure would freeze
 *      the channel until process restart).
 *
 *   3. Playbacks on DIFFERENT channels within the same agency run in
 *      parallel (the lock must be per-channel, not per-agency, or every
 *      busy agency funnels every dispatch through a single mutex).
 *
 *   4. Playbacks on different agencies on the same channel name also run
 *      in parallel (multi-tenant isolation — agency A's lock must not
 *      block agency B even when the channel labels collide).
 *
 *   5. Channel-name normalisation: "Main", "main", and "  MAIN  " all
 *      target the same lock so a typo in capitalisation doesn't let two
 *      "same channel" playbacks fire concurrently.
 *
 *   6. The function returns the inner `fn`'s value (not a wrapped sentinel)
 *      so callers can await results through the lock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { withChannelPlaybackLock } from "../../src/aiDispatch/channelPlayback.js";

// Each test uses a unique agency id so the process-global `tails` Map
// doesn't allow earlier tests to influence later ones. The number space
// here is intentionally well clear of any IDs the rest of the suite might
// pick.
let NEXT_AGENCY = 8_100_000;
function agencyId(): number {
  return NEXT_AGENCY++;
}

/**
 * A deferred promise + resolver pair. Letting tests hold the resolver
 * is how we observe the ORDER playbacks actually run in (rather than
 * relying on timing).
 */
function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("withChannelPlaybackLock: a single playback on a fresh channel runs immediately and returns its value", async () => {
  // The regression that prompted this whole test file (commit e710d68) was
  // a deadlock on the FIRST playback — the gate never resolved because it
  // depended on the playback finishing, which depended on the gate. So the
  // most important assertion in this file is that a single first playback
  // resolves at all.
  const ag = agencyId();
  const out = await withChannelPlaybackLock(ag, "main", async () => 42);
  assert.equal(out, 42, "lock must return fn's resolved value");
});

test("withChannelPlaybackLock: three sequential playbacks on the same channel all complete in order", async () => {
  const ag = agencyId();
  const order: string[] = [];
  const d1 = defer<void>();
  const d2 = defer<void>();
  const d3 = defer<void>();

  const p1 = withChannelPlaybackLock(ag, "main", async () => {
    order.push("start-1");
    await d1.promise;
    order.push("end-1");
  });
  const p2 = withChannelPlaybackLock(ag, "main", async () => {
    order.push("start-2");
    await d2.promise;
    order.push("end-2");
  });
  const p3 = withChannelPlaybackLock(ag, "main", async () => {
    order.push("start-3");
    await d3.promise;
    order.push("end-3");
  });

  // Give the microtask queue a chance to schedule playback 1 (but not 2/3,
  // which are gated on it).
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start-1"], "only the first playback may start before the previous one resolves");

  d1.resolve();
  await p1;
  // Same microtask flush so playback 2 has a chance to enter `fn`.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start-1", "end-1", "start-2"]);

  d2.resolve();
  await p2;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3"]);

  d3.resolve();
  await p3;
  assert.deepEqual(order, [
    "start-1",
    "end-1",
    "start-2",
    "end-2",
    "start-3",
    "end-3",
  ]);
});

test("withChannelPlaybackLock: a rejected playback does NOT freeze the channel for the next caller", async () => {
  // This is the regression-spotting test for the *other* class of bug the
  // current implementation must avoid: a thrown playback leaving the tail
  // promise in a rejected state and silently breaking every subsequent
  // playback on that channel. The implementation explicitly sanitises the
  // tail with `.then(undefined, undefined)` — pin that contract.
  const ag = agencyId();
  const sentinelError = new Error("tts-render-blew-up");

  // Use try/catch instead of rejects.* so the test still fails clearly if
  // the lock swallows the error instead of propagating it.
  let caught: unknown = null;
  try {
    await withChannelPlaybackLock(ag, "main", async () => {
      throw sentinelError;
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, sentinelError, "the first playback's error must surface to its own caller");

  // The next playback on the same channel must still run — if the lock
  // chained off the rejected promise without sanitising, this would
  // throw `tts-render-blew-up` instead of resolving "ok".
  const out = await withChannelPlaybackLock(ag, "main", async () => "ok");
  assert.equal(out, "ok", "a failed playback must not poison the channel for subsequent callers");
});

test("withChannelPlaybackLock: rejected playback still lets a third playback through (two-deep recovery)", async () => {
  // The fix in e710d68 sanitises the tail unconditionally, so even two
  // back-to-back rejections must not stall the channel. This is the
  // regression-protection for an LLM TTS provider that briefly 503s on
  // consecutive calls — the next legitimate playback must still go out.
  const ag = agencyId();

  await assert.rejects(
    withChannelPlaybackLock(ag, "main", async () => {
      throw new Error("first-failure");
    }),
  );
  await assert.rejects(
    withChannelPlaybackLock(ag, "main", async () => {
      throw new Error("second-failure");
    }),
  );
  const out = await withChannelPlaybackLock(ag, "main", async () => "recovered");
  assert.equal(out, "recovered");
});

test("withChannelPlaybackLock: different channels under the same agency run in parallel (per-channel lock)", async () => {
  // If the lock were keyed per-agency instead of per-channel, every busy
  // agency would funnel every dispatcher reply through a single mutex —
  // the field would experience seconds-long gaps between channels. Pin
  // the per-channel scoping by verifying overlapping execution.
  const ag = agencyId();
  const dA = defer<void>();
  const dB = defer<void>();
  const observed: string[] = [];

  const pA = withChannelPlaybackLock(ag, "alpha", async () => {
    observed.push("alpha-start");
    await dA.promise;
    observed.push("alpha-end");
  });
  const pB = withChannelPlaybackLock(ag, "bravo", async () => {
    observed.push("bravo-start");
    await dB.promise;
    observed.push("bravo-end");
  });

  // Both should have entered `fn` before either deferred resolved.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(observed.includes("alpha-start"), "alpha started");
  assert.ok(observed.includes("bravo-start"), "bravo started in parallel");
  assert.equal(observed.length, 2, "both started; neither ended yet");

  // Release in the OPPOSITE order to prove they are truly independent locks.
  dB.resolve();
  await pB;
  dA.resolve();
  await pA;
  assert.deepEqual(
    observed.sort(),
    ["alpha-end", "alpha-start", "bravo-end", "bravo-start"].sort(),
  );
});

test("withChannelPlaybackLock: same channel name across two agencies does NOT share a lock (multi-tenant)", async () => {
  // Two tenants both have a channel literally called "main". Their
  // playbacks must run concurrently — otherwise one tenant's slow TTS
  // delays every other tenant's dispatcher reply. The lock key prefixes
  // by agency id, so this is pinning that contract.
  const a = agencyId();
  const b = agencyId();
  const dA = defer<void>();
  const dB = defer<void>();
  const observed: string[] = [];

  const pA = withChannelPlaybackLock(a, "main", async () => {
    observed.push("a-start");
    await dA.promise;
    observed.push("a-end");
  });
  const pB = withChannelPlaybackLock(b, "main", async () => {
    observed.push("b-start");
    await dB.promise;
    observed.push("b-end");
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(observed.includes("a-start") && observed.includes("b-start"));

  dA.resolve();
  dB.resolve();
  await Promise.all([pA, pB]);
  assert.equal(observed.length, 4);
});

test("withChannelPlaybackLock: normalises channel name (case + whitespace) so 'Main' and 'main' share the lock", async () => {
  // If the lock were case- or whitespace-sensitive a dispatcher panel that
  // sent "Main" could fire concurrently with a transmission heading to
  // "main", talking over each other on the air. The implementation uses
  // `normalizedChannel` (shared with the relay + presence paths); pin that
  // contract so a future refactor that switches to a Map<string, ...> with
  // raw keys breaks this test instead of breaking production audio quality.
  const ag = agencyId();
  const order: string[] = [];
  const d1 = defer<void>();

  const p1 = withChannelPlaybackLock(ag, "Main", async () => {
    order.push("start-1");
    await d1.promise;
    order.push("end-1");
  });
  // Submit with different casing + leading/trailing whitespace — must
  // queue behind p1, not run in parallel.
  const p2 = withChannelPlaybackLock(ag, "  MAIN  ", async () => {
    order.push("start-2");
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start-1"], "second playback must wait — same channel under normalisation");

  d1.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2"]);
});

test("withChannelPlaybackLock: collapses internal whitespace so 'Ops 1' and 'Ops   1' share one lock", async () => {
  // The relay keys channels with `normalizedChannel`, which folds internal
  // whitespace runs. If playback locking did not do the same, two dispatch
  // replies on what users perceive as the same channel could run concurrently
  // and interleave/drop audio on-air.
  const ag = agencyId();
  const order: string[] = [];
  const d1 = defer<void>();

  const p1 = withChannelPlaybackLock(ag, "Ops 1", async () => {
    order.push("start-1");
    await d1.promise;
    order.push("end-1");
  });
  const p2 = withChannelPlaybackLock(ag, "Ops   1", async () => {
    order.push("start-2");
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start-1"], "second playback must wait — internal-whitespace variants are same channel");

  d1.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2"]);
});

test("withChannelPlaybackLock: returns the fn's resolved value (not the tail-sanitised undefined)", async () => {
  // The implementation tracks completion as a separate `undefined`-resolving
  // promise but must hand the caller the actual result. A regression that
  // accidentally returned the tail would silently break every caller that
  // depends on the inner value (e.g. `await withChannelPlaybackLock(...) =>
  // playbackId`).
  const ag = agencyId();
  const value = { kind: "tts", bytes: 1234 };
  const out = await withChannelPlaybackLock(ag, "main", async () => value);
  assert.strictEqual(out, value);
});

test("withChannelPlaybackLock: a synchronous throw inside fn behaves like an async rejection (channel still recovers)", async () => {
  // `prev.then(() => fn())` invokes fn lazily, so a synchronous throw
  // becomes a rejected promise. The next playback must still run —
  // this is the same recovery contract as the async-throw test, but
  // pinned for the case where fn never even yields once.
  const ag = agencyId();
  await assert.rejects(
    withChannelPlaybackLock(ag, "main", () => {
      throw new Error("sync-throw");
    }),
  );
  const out = await withChannelPlaybackLock(ag, "main", async () => "still-running");
  assert.equal(out, "still-running");
});
