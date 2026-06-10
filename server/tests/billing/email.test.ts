/**
 * Tests for `server/src/billing/email.ts` — the signup verification email
 * sender used by `POST /v1/signup/verify-email`.
 *
 * Why this is worth pinning:
 *
 *  - The dev fallback (no `RESEND_API_KEY` set) must return `true` and log
 *    the code to the console. A regression here would either crash the
 *    signup flow in Cloud Agent / local dev (no Resend creds) or — worse
 *    — silently return `false`, causing every signup to error out with
 *    `email_send_failed` despite the code being valid.
 *
 *  - The production path must:
 *      * POST to the Resend API with `Bearer <key>` and a JSON body that
 *        carries the From (env-derived), To (single-element array), and
 *        the verification code embedded in the HTML.
 *      * Return `true` on 2xx and `false` on any non-2xx (the route turns
 *        that into a 400 `email_send_failed` for the SPA).
 *
 *  - A leak that included the API key in the request body, or that
 *    dropped the Bearer auth header, would break Resend integration in
 *    ways that don't show up in dev (which never makes the call).
 *
 * The sender uses `fetch`, so we replace `globalThis.fetch` per-test with
 * an inline stub. No actual network call is ever made.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { sendVerificationEmail } from "../../src/billing/email.js";

const ENV_KEYS = ["RESEND_API_KEY", "BILLING_FROM_EMAIL"] as const;

type EnvSnapshot = Map<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const out: EnvSnapshot = new Map();
  for (const k of ENV_KEYS) out.set(k, process.env[k]);
  return out;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let envSnap: EnvSnapshot;
let originalFetch: typeof globalThis.fetch | undefined;
let originalConsoleLog: typeof console.log;

beforeEach(() => {
  envSnap = snapshotEnv();
  originalFetch = globalThis.fetch;
  originalConsoleLog = console.log;
});

afterEach(() => {
  restoreEnv(envSnap);
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  console.log = originalConsoleLog;
});

// ---------------------------------------------------------------------------
// Dev fallback: no RESEND_API_KEY → log to console, return true
// ---------------------------------------------------------------------------

test("sendVerificationEmail: no RESEND_API_KEY → logs to console and returns true (dev fallback)", async () => {
  // The Cloud Agent VM and most local dev boots do NOT set RESEND_API_KEY.
  // Returning false in this path would turn every signup attempt into an
  // `email_send_failed` toast — making the signup flow untestable in dev.
  delete process.env.RESEND_API_KEY;

  let networkCalled = false;
  globalThis.fetch = (async () => {
    networkCalled = true;
    return new Response("nope", { status: 500 });
  }) as typeof globalThis.fetch;

  const logged: string[] = [];
  console.log = ((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  }) as typeof console.log;

  const ok = await sendVerificationEmail("admin@example.com", "424242");
  assert.equal(ok, true);
  assert.equal(networkCalled, false, "dev fallback must NOT hit api.resend.com");
  // The console log must include enough info for a dev to manually verify
  // — both the destination and the code.
  assert.ok(
    logged.some((line) => line.includes("admin@example.com") && line.includes("424242")),
    `expected console.log line containing email + code, got: ${JSON.stringify(logged)}`,
  );
});

test("sendVerificationEmail: whitespace-only RESEND_API_KEY counts as unset (dev fallback)", async () => {
  // `resendApiKey()` already trims to null on whitespace, but pin the
  // end-to-end behaviour: any whitespace-only key must NOT cause us to
  // POST a Bearer header of `Bearer ` to Resend (would 401).
  process.env.RESEND_API_KEY = "   ";

  let networkCalled = false;
  globalThis.fetch = (async () => {
    networkCalled = true;
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;

  console.log = (() => {}) as typeof console.log;
  const ok = await sendVerificationEmail("u@example.com", "111111");
  assert.equal(ok, true);
  assert.equal(networkCalled, false, "whitespace key must not trigger a network call");
});

// ---------------------------------------------------------------------------
// Production path: POSTs to Resend with the configured fields
// ---------------------------------------------------------------------------

test("sendVerificationEmail: when configured, POSTs to Resend with Bearer auth and JSON body", async () => {
  process.env.RESEND_API_KEY = "re_test_abc";
  process.env.BILLING_FROM_EMAIL = "verify@example.com";

  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;

  const ok = await sendVerificationEmail("dest@example.com", "987654");
  assert.equal(ok, true);

  // Endpoint URL is fixed — pin it so a refactor can't silently change
  // which API we call.
  assert.equal(capturedUrl, "https://api.resend.com/emails");

  // Method + headers must be POST with Authorization and JSON content-type.
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string> | undefined;
  assert.equal(headers?.Authorization, "Bearer re_test_abc");
  assert.equal(headers?.["Content-Type"], "application/json");

  // Body must be JSON containing the From (env-derived, trimmed),
  // To (single-element array of the recipient), and the verification
  // code embedded in the rendered HTML.
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.from, "verify@example.com");
  assert.deepEqual(body.to, ["dest@example.com"]);
  assert.ok(typeof body.subject === "string" && body.subject.length > 0);
  assert.ok(
    typeof body.html === "string" && body.html.includes("987654"),
    "verification code must appear in the HTML body so the recipient can read it",
  );
});

test("sendVerificationEmail: configured but Resend returns 401 → false", async () => {
  // A bad / revoked API key shows up as 401 from Resend. The function
  // must surface that as `false` so the route returns
  // `email_send_failed` rather than pretending the email went out.
  process.env.RESEND_API_KEY = "re_test_bad";

  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch;

  // Silence the warn so the test output stays clean.
  const origWarn = console.warn;
  console.warn = (() => {}) as typeof console.warn;
  try {
    const ok = await sendVerificationEmail("dest@example.com", "654321");
    assert.equal(ok, false);
  } finally {
    console.warn = origWarn;
  }
});

test("sendVerificationEmail: configured but Resend returns 500 → false", async () => {
  // Resend / network outages must NOT crash the signup endpoint — they
  // must return false so the route can respond 400 cleanly.
  process.env.RESEND_API_KEY = "re_test_ok";

  globalThis.fetch = (async () => new Response("server error", { status: 500 })) as typeof globalThis.fetch;

  const origWarn = console.warn;
  console.warn = (() => {}) as typeof console.warn;
  try {
    const ok = await sendVerificationEmail("dest@example.com", "000000");
    assert.equal(ok, false);
  } finally {
    console.warn = origWarn;
  }
});

test("sendVerificationEmail: falls back to default From: when BILLING_FROM_EMAIL is unset", async () => {
  // Pin the default From so a missing env var doesn't end up sending
  // with a literal empty string (which Resend would reject as 400).
  process.env.RESEND_API_KEY = "re_test_default_from";
  delete process.env.BILLING_FROM_EMAIL;

  let captured: { from?: string } = {};
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;

  const ok = await sendVerificationEmail("x@example.com", "111111");
  assert.equal(ok, true);
  assert.equal(captured.from, "billing@safetptt.com");
});
