/**
 * Tests for `server/src/billing/email.ts`.
 *
 * `sendVerificationEmail` is the ONLY mechanism by which a new signup gets
 * a code to prove they own their email address. A regression here blocks
 * every new tenant from finishing onboarding.
 *
 * Properties pinned by this file:
 *
 *  1. **Dev mode (no RESEND_API_KEY)**: must log the code and return `true`
 *     synchronously. The signup flow treats a `false` return as
 *     `email_send_failed` and rolls back the signup verification row, so a
 *     regression that returned `false` in dev would make local / Cloud
 *     Agent signups silently fail at the verify-email step.
 *
 *  2. **Resend success path**: must POST to `https://api.resend.com/emails`
 *     with the Bearer auth header, JSON content type, and a body containing
 *     the `from` (`billingFromEmail`), the recipient, a 6-digit code, and
 *     a subject. The code must appear verbatim in the HTML body — that's
 *     what the recipient pastes back.
 *
 *  3. **Resend failure path**: a non-2xx response must read as `false`
 *     (not throw) so the signup route can surface `email_send_failed`
 *     instead of returning a 500. The handler must also tolerate a
 *     non-text-readable response (no infinite hang, no throw).
 *
 *  4. **No code logged when Resend IS configured**: only the dev branch
 *     logs the code — the production branch must never write the
 *     verification code to stdout (it would leak codes to log
 *     aggregators).
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { sendVerificationEmail } from "../../src/billing/email.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.BILLING_FROM_EMAIL;
const ORIGINAL_CONSOLE_LOG = console.log;
const ORIGINAL_CONSOLE_WARN = console.warn;

let logged: string[] = [];
let warned: string[] = [];

beforeEach(() => {
  logged = [];
  warned = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_CONSOLE_LOG;
  console.warn = ORIGINAL_CONSOLE_WARN;
  if (ORIGINAL_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_FROM === undefined) delete process.env.BILLING_FROM_EMAIL;
  else process.env.BILLING_FROM_EMAIL = ORIGINAL_FROM;
});

// ---------------------------------------------------------------------------
// Dev mode (no RESEND_API_KEY)
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns true in dev mode (no RESEND_API_KEY), even though no HTTP is made", async () => {
  delete process.env.RESEND_API_KEY;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await sendVerificationEmail("admin@example.com", "123456");
  assert.equal(result, true);
  assert.equal(fetchCalled, false, "must NOT call Resend when no API key is set");
});

test("sendVerificationEmail: dev mode logs the recipient + code so it's visible in the dev terminal", async () => {
  delete process.env.RESEND_API_KEY;
  await sendVerificationEmail("admin@example.com", "654321");
  assert.ok(
    logged.some((line) => line.includes("admin@example.com") && line.includes("654321")),
    `expected dev log to include recipient + code; got: ${JSON.stringify(logged)}`,
  );
});

test("sendVerificationEmail: dev mode also handles whitespace-only RESEND_API_KEY (treated as unset)", async () => {
  // The config helper `resendApiKey()` trims and returns null for
  // whitespace-only — confirm `sendVerificationEmail` treats that as
  // the dev branch (not a "key is set" branch that would then try to
  // POST with an effectively-empty Bearer header).
  process.env.RESEND_API_KEY = "   ";
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await sendVerificationEmail("admin@example.com", "111111");
  assert.equal(result, true);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------------
// Resend success path
// ---------------------------------------------------------------------------

test("sendVerificationEmail: posts to Resend with Bearer auth + JSON body + correct from/to/subject/code", async () => {
  process.env.RESEND_API_KEY = "re_test_123";
  process.env.BILLING_FROM_EMAIL = "billing@example.com";

  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await sendVerificationEmail("user@example.com", "424242");
  assert.equal(result, true);
  assert.ok(captured, "fetch must be called");
  const seen = captured as { url: string; init: RequestInit };
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.method, "POST");

  const headers = seen.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_123");
  assert.equal(headers["Content-Type"], "application/json");

  const body = JSON.parse(String(seen.init.body)) as {
    from: string;
    to: string[];
    subject: string;
    html: string;
  };
  assert.equal(body.from, "billing@example.com");
  assert.deepEqual(body.to, ["user@example.com"]);
  assert.ok(body.subject.toLowerCase().includes("verification"));
  // The 6-digit code must appear verbatim in the HTML — that's what
  // the recipient types back into the signup form.
  assert.ok(body.html.includes("424242"), "code must appear in the HTML body");
});

test("sendVerificationEmail: with Resend configured, code is NOT written to stdout (prevents log-aggregator leak)", async () => {
  // The dev branch logs the code; the production branch must not.
  // A regression that left the log statement in both branches would
  // leak every verification code to whatever log aggregator the
  // server is shipped into (Datadog, Railway logs, etc.).
  process.env.RESEND_API_KEY = "re_test_456";
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

  await sendVerificationEmail("user@example.com", "987654");
  assert.ok(
    !logged.some((line) => line.includes("987654")),
    `production path must not log the verification code; got: ${JSON.stringify(logged)}`,
  );
});

// ---------------------------------------------------------------------------
// Resend failure path
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns false (does not throw) when Resend responds non-2xx", async () => {
  // The signup route reads `false` here and translates it to
  // `email_send_failed`. A regression that threw would bubble as a
  // 500 from the signup endpoint and surface a stack trace to the
  // client.
  process.env.RESEND_API_KEY = "re_test_789";
  globalThis.fetch = (async () =>
    new Response('{"error":"invalid_from"}', { status: 422 })) as typeof fetch;

  const result = await sendVerificationEmail("user@example.com", "111111");
  assert.equal(result, false);
});

test("sendVerificationEmail: logs a structured warning when Resend rejects so failures are diagnosable", async () => {
  process.env.RESEND_API_KEY = "re_test_warn";
  globalThis.fetch = (async () =>
    new Response("bad domain", { status: 422 })) as typeof fetch;

  await sendVerificationEmail("user@example.com", "111111");
  assert.ok(
    warned.some((line) => line.includes("422")),
    `expected a warn with the status code; got: ${JSON.stringify(warned)}`,
  );
});

test("sendVerificationEmail: returns false when Resend responds 500 (server error, not silently treated as sent)", async () => {
  // 5xx from Resend must still surface as `false` — a regression that
  // returned `true` for 5xx would tell the signup flow the code was
  // sent when it never was, and the user would be locked out of
  // completing signup.
  process.env.RESEND_API_KEY = "re_test_500";
  globalThis.fetch = (async () =>
    new Response("internal error", { status: 500 })) as typeof fetch;
  assert.equal(await sendVerificationEmail("user@example.com", "111111"), false);
});

test("sendVerificationEmail: returns false (and does not crash) when the error body cannot be read", async () => {
  // The handler does `res.text().catch(() => "")` — a regression that
  // dropped the `.catch` would crash on a Response whose body stream
  // is already consumed or that errors mid-read.
  process.env.RESEND_API_KEY = "re_test_drain";
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("body stream broken");
      },
    } as unknown as Response;
  }) as typeof fetch;

  const result = await sendVerificationEmail("user@example.com", "111111");
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// BILLING_FROM_EMAIL fallback
// ---------------------------------------------------------------------------

test("sendVerificationEmail: defaults `from` to billing@safetptt.com when BILLING_FROM_EMAIL is unset", async () => {
  // If a Railway deployment forgets to set BILLING_FROM_EMAIL, the
  // helper must still send (the fallback is configured in
  // billingFromEmail()). A regression that sent an empty string would
  // make Resend reject every email.
  process.env.RESEND_API_KEY = "re_test_default_from";
  delete process.env.BILLING_FROM_EMAIL;
  let capturedBody = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await sendVerificationEmail("user@example.com", "111111");
  assert.equal(result, true);
  const body = JSON.parse(capturedBody) as { from: string };
  assert.equal(body.from, "billing@safetptt.com");
});
