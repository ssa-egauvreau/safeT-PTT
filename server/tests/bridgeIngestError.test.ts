/**
 * Regression tests for `describeBridgeIngestError` in `server/src/bridgeWorker.ts`.
 *
 * When a stream bridge can't pass audio, the admin Bridges page used to show a
 * bare "Not running" with no cause — the ffmpeg error was logged server-side
 * and thrown away. This helper turns the ffmpeg stderr (or other ingest
 * failure text) into the operator-readable reason the console now renders, so
 * an admin staring at a dead bridge can tell a refused stream from a bad
 * password from an unreachable host without opening server logs.
 *
 * The contract pinned here:
 *   1. A 403 / "forbidden" is called out as a refused connection AND mentions
 *      the Broadcastify concurrent-listener limit — the single most common
 *      cause of an authenticated feed that still won't bridge, and the one the
 *      generic message historically buried.
 *   2. 401 → credentials, 404 → feed URL, 429 → rate limit, DNS/refused/timeout
 *      → unreachable, TLS → suggest the http:// URL. Each points the admin at a
 *      different, non-overlapping fix.
 *   3. An unrecognized error is surfaced verbatim (first line, length-capped)
 *      rather than dropped — the admin still learns something.
 *   4. Empty / whitespace input yields null so the caller records no reason
 *      (ffmpeg emits blank progress lines we must not latch onto).
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { describeBridgeIngestError, describeBridgeSpawnError } from "../src/bridgeWorker.js";

test("a 403 is a refused connection and names the concurrent-listener limit", (_t: TestContext) => {
  const fromStatus = describeBridgeIngestError("Server returned 403 Forbidden (access denied)");
  assert.ok(fromStatus);
  assert.match(fromStatus!, /refused/i);
  assert.match(fromStatus!, /simultaneous|Broadcastify/i);

  // The word "Forbidden" alone (some builds omit the numeric status) still maps.
  const fromWord = describeBridgeIngestError("HTTP error Forbidden");
  assert.match(fromWord!, /refused/i);
});

test("401 points at the stream credentials, not at credits or the URL", (_t: TestContext) => {
  const detail = describeBridgeIngestError("Server returned 401 Unauthorized");
  assert.match(detail!, /username|password/i);
  assert.doesNotMatch(detail!, /404|not found/i);
});

test("404 points at the feed URL", (_t: TestContext) => {
  assert.match(describeBridgeIngestError("Server returned 404 Not Found")!, /404|feed|url/i);
});

test("429 is reported as rate limiting", (_t: TestContext) => {
  assert.match(describeBridgeIngestError("Server returned 429 Too Many Requests")!, /rate/i);
});

test("DNS / refused / timeout map to an unreachable-host reason", (_t: TestContext) => {
  assert.match(describeBridgeIngestError("Failed to resolve hostname audio.example.com")!, /resolve|host/i);
  assert.match(describeBridgeIngestError("Connection refused")!, /reach|refused|timed out/i);
  assert.match(describeBridgeIngestError("Connection timed out")!, /reach|refused|timed out/i);
});

test("a TLS failure suggests trying the http:// URL", (_t: TestContext) => {
  const detail = describeBridgeIngestError("error:1416F086:SSL routines: tlsv1 alert");
  assert.match(detail!, /http:\/\//i);
});

test("an unrecognized error is surfaced verbatim, length-capped to one line", (_t: TestContext) => {
  const long = "Some unusual ffmpeg failure ".repeat(20); // > 160 chars, single line
  const detail = describeBridgeIngestError(`${long}\nsecond line`);
  assert.ok(detail);
  assert.match(detail!, /Ingest error:/);
  // Only the first line, capped — the "second line" must not leak in.
  assert.doesNotMatch(detail!, /second line/);
  assert.ok(detail!.length <= "Ingest error: ".length + 160);
});

test("blank input yields null so no reason is recorded", (_t: TestContext) => {
  assert.equal(describeBridgeIngestError(""), null);
  assert.equal(describeBridgeIngestError("   \n  "), null);
});

/**
 * `describeBridgeSpawnError` covers the *spawn* failure path (the ffmpeg child
 * couldn't start) — distinct from the stderr path above. The bug it fixes: a
 * resource-starved spawn (ENOMEM/EAGAIN) used to be reported as "ffmpeg is not
 * available", which is flatly wrong when other bridges on the same server are
 * running ffmpeg fine. Only a true ENOENT means the binary is missing.
 */
test("ENOENT is the only code reported as a missing ffmpeg binary", (_t: TestContext) => {
  assert.match(describeBridgeSpawnError("ENOENT", "spawn ffmpeg ENOENT"), /not installed/i);
});

test("ENOMEM / EAGAIN are reported as a resource shortage, not a missing binary", (_t: TestContext) => {
  for (const code of ["ENOMEM", "EAGAIN"]) {
    const detail = describeBridgeSpawnError(code, `spawn ffmpeg ${code}`);
    assert.match(detail, /resource|memory|cpu/i);
    assert.match(detail, new RegExp(code));
    // The misleading old message must not reappear for a server that clearly has ffmpeg.
    assert.doesNotMatch(detail, /not installed|not available/i);
  }
});

test("an unknown spawn error is surfaced with its code and message, length-capped", (_t: TestContext) => {
  const detail = describeBridgeSpawnError("EACCES", "permission denied");
  assert.match(detail, /EACCES/);
  assert.match(detail, /permission denied/i);
  assert.ok(detail.length <= 200);

  // No code at all still yields a usable message.
  assert.match(describeBridgeSpawnError(undefined, "weird failure"), /weird failure/);
});
