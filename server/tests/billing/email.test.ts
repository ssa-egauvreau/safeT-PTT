/**
 * Tests for `server/src/billing/email.ts`.
 *
 * `sendVerificationEmail` is the single hop on the public self-service
 * signup path: a regression here either silently drops the verification
 * code (signup completes never) or silently accepts a code that was
 * never delivered (signup proceeds without email-of-record control).
 *
 * The function has two distinct branches that this file pins:
 *
 *   1. **Dev fallback** — when `RESEND_API_KEY` is unset/blank,
 *      `sendVerificationEmail` MUST log the code to stdout and resolve
 *      `true` without making any network call. A regression that swung
 *      this to `false` would block every dev/Cloud Agent signup attempt
 *      because `requestSignupVerification` returns `email_send_failed`
 *      on a falsy result.
 *
 *   2. **Resend POST** — when the key is set, exactly one POST goes to
 *      `https://api.resend.com/emails`, with the bearer key, JSON
 *      content-type, the configured `from` address (`billingFromEmail()`
 *      with the `BILLING_FROM_EMAIL` override), the recipient, and an
 *      HTML body that actually contains the 6-digit code. A regression
 *      here would send blank, mis-addressed, or unauthenticated requests
 *      to Resend — failures the user sees as `email_send_failed`.
 *
 *   3. **Failure-path contract** — any non-2xx response from Resend MUST
 *      surface as `false` so the route returns `email_send_failed` to
 *      the client (rather than pretending the email went through). The
 *      handler also reads the response body for a console warning; this
 *      file confirms the read happens and never throws even on a body
 *      that is itself broken.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = ["RESEND_API_KEY", "BILLING_FROM_EMAIL"] as const;

const savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch | undefined;
let savedConsoleLog: typeof console.log;
let savedConsoleWarn: typeof console.warn;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  savedFetch = globalThis.fetch;
  savedConsoleLog = console.log;
  savedConsoleWarn = console.warn;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (savedFetch !== undefined) {
    globalThis.fetch = savedFetch;
  }
  console.log = savedConsoleLog;
  console.warn = savedConsoleWarn;
});

const { sendVerificationEmail } = await import("../../src/billing/email.js");

// ---------------------------------------------------------------------------
// Dev fallback (RESEND_API_KEY unset/blank)
// ---------------------------------------------------------------------------

test("sendVerificationEmail: with RESEND_API_KEY unset, never calls fetch and returns true", async () => {
  delete process.env.RESEND_API_KEY;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called in dev fallback");
  }) as typeof fetch;
  // Suppress the dev-mode log from leaking into the test reporter.
  console.log = () => {};

  const ok = await sendVerificationEmail("ops@example.com", "123456");
  assert.equal(ok, true);
  assert.equal(fetchCalls, 0, "fetch must not run when RESEND_API_KEY is unset");
});

test("sendVerificationEmail: blank/whitespace RESEND_API_KEY also falls back to dev mode", async () => {
  // The config helper trims; a whitespace-only value (e.g. someone
  // pasted just a newline into Railway) MUST be treated as unset, not
  // sent to Resend with `Authorization: Bearer  ` and a 401.
  process.env.RESEND_API_KEY = "   ";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called when RESEND_API_KEY is whitespace");
  }) as typeof fetch;
  console.log = () => {};

  const ok = await sendVerificationEmail("ops@example.com", "654321");
  assert.equal(ok, true);
  assert.equal(fetchCalls, 0);
});

test("sendVerificationEmail: dev fallback logs the recipient and code (so signup is testable locally)", async () => {
  delete process.env.RESEND_API_KEY;
  const logged: string[] = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === "string") logged.push(msg);
  };
  // Make sure no test is accidentally hitting the network.
  globalThis.fetch = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;

  const ok = await sendVerificationEmail("user@example.com", "424242");
  assert.equal(ok, true);
  // The exact message format isn't load-bearing, but the recipient and
  // the code must both be in the log so a developer can finish signup
  // without a real inbox.
  const joined = logged.join("\n");
  assert.match(joined, /user@example\.com/);
  assert.match(joined, /424242/);
});

// ---------------------------------------------------------------------------
// Resend POST (RESEND_API_KEY set)
// ---------------------------------------------------------------------------

interface CapturedFetch {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: {
    from?: string;
    to?: string[];
    subject?: string;
    html?: string;
  };
}

function captureFetchResponding(
  response: Response | (() => Response | Promise<Response>),
): { calls: CapturedFetch[] } {
  const calls: CapturedFetch[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers ?? {});
    let body: CapturedFetch["body"] = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
    calls.push({
      url,
      method: init?.method,
      authorization: headers.get("authorization") ?? undefined,
      contentType: headers.get("content-type") ?? undefined,
      body,
    });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { calls };
}

test("sendVerificationEmail: posts to api.resend.com with bearer auth, JSON body, recipient and code", async () => {
  process.env.RESEND_API_KEY = "re_test_abc";
  delete process.env.BILLING_FROM_EMAIL;
  const { calls } = captureFetchResponding(new Response("{}", { status: 200 }));
  console.log = () => {};

  const ok = await sendVerificationEmail("admin@agency.test", "987654");
  assert.equal(ok, true);
  assert.equal(calls.length, 1, "exactly one POST per send");

  const call = calls[0];
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.method, "POST");
  assert.equal(call.authorization, "Bearer re_test_abc");
  assert.match(call.contentType ?? "", /application\/json/);
  assert.deepEqual(call.body.to, ["admin@agency.test"]);
  // The default from-address must be used when BILLING_FROM_EMAIL is unset.
  assert.equal(call.body.from, "billing@safetptt.com");
  assert.ok(call.body.subject && /verification/i.test(call.body.subject), "subject mentions verification");
  // The 6-digit code MUST appear verbatim in the HTML body, otherwise
  // the user has nothing to type into the signup form.
  assert.match(call.body.html ?? "", /987654/);
});

test("sendVerificationEmail: BILLING_FROM_EMAIL overrides the default From address", async () => {
  process.env.RESEND_API_KEY = "re_test_abc";
  process.env.BILLING_FROM_EMAIL = "billing-test@example.org";
  const { calls } = captureFetchResponding(new Response("{}", { status: 200 }));
  console.log = () => {};

  const ok = await sendVerificationEmail("admin@agency.test", "111222");
  assert.equal(ok, true);
  assert.equal(calls[0].body.from, "billing-test@example.org");
});

test("sendVerificationEmail: trims whitespace from RESEND_API_KEY before signing the request", async () => {
  // The config helper trims, so a copy-paste with surrounding spaces
  // should still authenticate cleanly. A regression that fed the raw
  // value into the Authorization header would 401 every send.
  process.env.RESEND_API_KEY = "  re_test_xyz  ";
  const { calls } = captureFetchResponding(new Response("{}", { status: 200 }));
  console.log = () => {};

  const ok = await sendVerificationEmail("admin@agency.test", "999000");
  assert.equal(ok, true);
  assert.equal(calls[0].authorization, "Bearer re_test_xyz");
});

// ---------------------------------------------------------------------------
// Failure-path contract (Resend returns non-2xx)
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns false when Resend responds with a non-2xx status", async () => {
  process.env.RESEND_API_KEY = "re_test_abc";
  captureFetchResponding(new Response("rate limited", { status: 429 }));
  // The handler logs a warning on failure; suppress to keep the
  // reporter clean and assert the warning fires.
  let warned = false;
  console.warn = () => {
    warned = true;
  };

  const ok = await sendVerificationEmail("admin@agency.test", "112233");
  assert.equal(ok, false, "non-2xx must propagate as false so the route reports email_send_failed");
  assert.equal(warned, true, "a failure must be logged for operator visibility");
});

test("sendVerificationEmail: 4xx Resend response (e.g. invalid From) still resolves false (no throw)", async () => {
  // A regression that turned the failure path into a throw would
  // surface as a 500 from the express handler instead of a clean
  // `email_send_failed` 400 — masking the real cause from the user.
  process.env.RESEND_API_KEY = "re_test_abc";
  captureFetchResponding(new Response("bad from", { status: 422 }));
  console.warn = () => {};

  const ok = await sendVerificationEmail("admin@agency.test", "445566");
  assert.equal(ok, false);
});

test("sendVerificationEmail: tolerates a response whose body throws during text() (still false)", async () => {
  // `email.ts` reads `await res.text().catch(() => "")` for the
  // diagnostic log — pin that the catch is in place so a malformed
  // response from Resend can never crash the handler.
  process.env.RESEND_API_KEY = "re_test_abc";
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("body unreadable");
      },
    } as unknown as Response)) as typeof fetch;
  console.warn = () => {};

  const ok = await sendVerificationEmail("admin@agency.test", "778899");
  assert.equal(ok, false);
});
