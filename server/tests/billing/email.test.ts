/**
 * Tests for `server/src/billing/email.ts`.
 *
 * `sendVerificationEmail` is the only thing between a self-service signup
 * (`POST /v1/signup/verify-email`) and a real OTP landing in the prospect's
 * inbox. The trigger PR that added direct billing-config + webhook + route
 * coverage left this module with zero direct tests, even though it owns:
 *
 *  1. **The dev fallback.** When `RESEND_API_KEY` is unset (every Cloud Agent
 *     boot, every local dev session, every CI run) the function MUST log the
 *     code to the console and return `true` — otherwise `requestSignupVerification`
 *     would `error: "email_send_failed"` and the entire trial-signup happy
 *     path would 400 in development without any indication why.
 *
 *  2. **The Resend success path.** When the key IS set, the function POSTs
 *     to `https://api.resend.com/emails` and returns `true` ONLY when the
 *     response is `res.ok`. A regression that returned `true` on a 4xx /
 *     5xx response would silently tell every prospect "we sent your code"
 *     while Resend was actually rejecting the payload — a brutal funnel
 *     leak with no signal in logs.
 *
 *  3. **The Resend failure path.** Non-ok responses must return `false` and
 *     `console.warn` (not `console.error` — error would page the on-call,
 *     and a verification-email bounce is not a sev1).
 *
 *  4. **The request shape Resend expects.** `from` must be the trimmed
 *     `BILLING_FROM_EMAIL` (or the documented default `billing@safetptt.com`,
 *     pinned in `billing/config.test.ts`), `to` must be an array, the subject
 *     line must match what users are told to look for in their inbox, and
 *     the code must be visibly rendered in the HTML body. A typo in any of
 *     these breaks deliverability or the user's ability to find the code
 *     in their inbox.
 *
 * The module reads `resendApiKey()` and `billingFromEmail()` lazily on every
 * call, so each test toggles the env directly without needing to re-import.
 * We stub `globalThis.fetch` per-test so we never make a real network call.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { sendVerificationEmail } from "../../src/billing/email.js";

const ENV_KEYS = ["RESEND_API_KEY", "BILLING_FROM_EMAIL"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch | undefined;
let savedConsoleLog: typeof console.log;
let savedConsoleWarn: typeof console.warn;
let logged: unknown[][] = [];
let warned: unknown[][] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedFetch = globalThis.fetch;
  savedConsoleLog = console.log;
  savedConsoleWarn = console.warn;
  logged = [];
  warned = [];
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (savedFetch === undefined) {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  } else {
    globalThis.fetch = savedFetch;
  }
  console.log = savedConsoleLog;
  console.warn = savedConsoleWarn;
});

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Replace `globalThis.fetch` with a controllable stub. The stub records each
 * invocation and returns the requested fake `Response`. Throws fatally if
 * the real fetch is hit — tests are not allowed to make outbound calls.
 */
function stubFetch(handler: (call: FetchCall) => { ok: boolean; status: number; text?: string }): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const bodyRaw = init?.body;
    let body: unknown = bodyRaw;
    if (typeof bodyRaw === "string") {
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        body = bodyRaw;
      }
    }
    const call: FetchCall = { url, method: init?.method, headers, body };
    calls.push(call);
    const result = handler(call);
    return {
      ok: result.ok,
      status: result.status,
      text: async () => result.text ?? "",
    } as Response;
  }) as typeof fetch;
  return calls;
}

// ---------------------------------------------------------------------------
// Dev fallback (no Resend API key)
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns true and never calls fetch when RESEND_API_KEY is unset", async () => {
  // The dev / Cloud Agent default is RESEND_API_KEY=unset. The function MUST
  // succeed locally so the signup happy-path works in dev — otherwise every
  // tester would have to provision a real Resend key just to exercise the
  // verify-email flow.
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called in dev fallback");
  }) as typeof fetch;

  const ok = await sendVerificationEmail("dev@example.com", "123456");
  assert.equal(ok, true);
  assert.equal(fetchCalled, false, "no outbound HTTP call when running without Resend");
});

test("sendVerificationEmail: dev fallback logs the recipient and code to the console", async () => {
  // The console log is the ONLY way a dev or Cloud Agent can complete signup
  // locally — they read the OTP off stdout and paste it back into the form.
  // Pin both the recipient and the code presence so a refactor that started
  // redacting the code (well-meaning) doesn't break the dev loop.
  globalThis.fetch = (async () => {
    throw new Error("fetch must not be called in dev fallback");
  }) as typeof fetch;

  await sendVerificationEmail("operator@example.com", "987654");
  assert.equal(logged.length, 1, "exactly one console.log in the dev fallback");
  const line = String(logged[0]?.[0] ?? "");
  assert.ok(line.includes("operator@example.com"), `log line must include recipient: ${line}`);
  assert.ok(line.includes("987654"), `log line must include the code: ${line}`);
});

test("sendVerificationEmail: dev fallback treats whitespace-only RESEND_API_KEY as unset", async () => {
  // `resendApiKey()` returns null for whitespace-only values (covered in
  // billing/config.test.ts). This test pins that `sendVerificationEmail`
  // consumes that contract — i.e. it routes whitespace-only keys through
  // the dev fallback rather than POSTing to Resend with a blank Bearer
  // header (which would 401 every signup in prod).
  process.env.RESEND_API_KEY = "   ";
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called when key is whitespace-only");
  }) as typeof fetch;

  const ok = await sendVerificationEmail("a@b.com", "111111");
  assert.equal(ok, true);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------------
// Resend success path
// ---------------------------------------------------------------------------

test("sendVerificationEmail: POSTs to Resend and returns true on a 200 response", async () => {
  process.env.RESEND_API_KEY = "re_test_success_key";
  const calls = stubFetch(() => ({ ok: true, status: 200 }));

  const ok = await sendVerificationEmail("user@example.com", "246810");

  assert.equal(ok, true);
  assert.equal(calls.length, 1, "exactly one POST per call");
  const call = calls[0]!;
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.method, "POST");
});

test("sendVerificationEmail: sends Authorization Bearer using the trimmed RESEND_API_KEY", async () => {
  // The trim contract is owned by `resendApiKey()` and exercised in
  // billing/config.test.ts. This test pins that the email sender honours
  // that trim — a leading newline / trailing space in the Railway env var
  // (the most common operator footgun) must NOT end up in the Bearer header
  // verbatim, where Resend rejects it as a malformed token.
  process.env.RESEND_API_KEY = "  re_test_trim_key\n";
  const calls = stubFetch(() => ({ ok: true, status: 200 }));

  await sendVerificationEmail("user@example.com", "333333");

  assert.equal(calls[0]?.headers["authorization"], "Bearer re_test_trim_key");
  assert.equal(calls[0]?.headers["content-type"], "application/json");
});

test("sendVerificationEmail: payload uses BILLING_FROM_EMAIL default when env unset", async () => {
  process.env.RESEND_API_KEY = "re_test_from_default";
  const calls = stubFetch(() => ({ ok: true, status: 200 }));

  await sendVerificationEmail("user@example.com", "555555");

  const body = calls[0]?.body as Record<string, unknown> | undefined;
  assert.ok(body, "body must be JSON");
  // Default is pinned in billing/config.test.ts as billing@safetptt.com.
  assert.equal(
    body.from,
    "billing@safetptt.com",
    "from address must fall back to the documented default",
  );
});

test("sendVerificationEmail: payload uses BILLING_FROM_EMAIL env value when set", async () => {
  // An operator setting a custom from address (e.g. for a white-labelled
  // tenant) must see that value reach Resend — otherwise their domain
  // alignment for DKIM / SPF would silently fail and deliverability would
  // tank without warning.
  process.env.RESEND_API_KEY = "re_test_from_custom";
  process.env.BILLING_FROM_EMAIL = "noreply@tenant.example.com";
  const calls = stubFetch(() => ({ ok: true, status: 200 }));

  await sendVerificationEmail("user@example.com", "777777");

  const body = calls[0]?.body as Record<string, unknown> | undefined;
  assert.equal(body?.from, "noreply@tenant.example.com");
});

test("sendVerificationEmail: payload uses an array `to`, the documented subject, and renders the code in the HTML", async () => {
  // Resend's `to` field accepts a string or an array of strings; the
  // implementation uses an array for forward compatibility. Pin that
  // contract — switching to a bare string would still work for Resend,
  // but a downstream batching change that depended on the array shape
  // would silently break.
  // The subject must contain "safeT PTT" + "verification code" so prospects
  // searching their inbox for either phrase can find the message; we pin
  // the user-visible wording exactly. The code MUST be present in the HTML
  // body — a regression that dropped it would tell the user "we sent it"
  // and then hand them an empty email.
  process.env.RESEND_API_KEY = "re_test_payload_shape";
  const calls = stubFetch(() => ({ ok: true, status: 200 }));

  await sendVerificationEmail("Mixed.Case@Example.COM", "424242");

  const body = calls[0]?.body as Record<string, unknown> | undefined;
  assert.ok(body, "body must parse as JSON");
  assert.deepEqual(body.to, ["Mixed.Case@Example.COM"], "to is an array containing the raw recipient");
  assert.equal(body.subject, "Your safeT PTT verification code");
  const html = String(body.html ?? "");
  assert.ok(html.includes("424242"), `HTML body must contain the literal code, got: ${html}`);
  assert.ok(html.includes("safeT PTT"), "HTML body must reference the product name");
  assert.ok(
    html.includes("30 minutes"),
    "HTML body must mention the 30-minute expiry to match the CODE_TTL_MS contract in signup.ts",
  );
});

// ---------------------------------------------------------------------------
// Resend failure path
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns false when Resend responds non-ok (4xx)", async () => {
  // The most insidious regression possible in this file: returning `true`
  // on a non-ok response would silently break every signup while logging
  // nothing useful. Pin the false return value AND the warn (not error)
  // severity so monitoring alerts fire at the right level.
  process.env.RESEND_API_KEY = "re_test_failure_4xx";
  stubFetch(() => ({ ok: false, status: 422, text: "invalid from address" }));

  const ok = await sendVerificationEmail("user@example.com", "111000");

  assert.equal(ok, false, "non-ok response must yield false");
  assert.ok(warned.length >= 1, "failure should warn so ops can grep logs for it");
  const warnLine = warned.map((args) => args.join(" ")).join(" | ");
  assert.ok(
    warnLine.includes("422"),
    `warn line must include the Resend status code for grep-ability: ${warnLine}`,
  );
});

test("sendVerificationEmail: returns false when Resend responds non-ok (5xx)", async () => {
  // 5xx must NOT be retried by this function (the route handler may decide
  // to surface email_send_failed back to the client). The contract is
  // strictly "return false on any non-ok"; pin both 4xx and 5xx so a
  // refactor doesn't add an asymmetric retry that would double-send some
  // codes and miss others.
  process.env.RESEND_API_KEY = "re_test_failure_5xx";
  stubFetch(() => ({ ok: false, status: 503, text: "" }));

  const ok = await sendVerificationEmail("user@example.com", "222000");
  assert.equal(ok, false);
});

test("sendVerificationEmail: failure path survives a Resend body that is not readable as text", async () => {
  // The implementation does `res.text().catch(() => "")`. A Response whose
  // `.text()` throws (truncated stream, decoding error) must NOT crash the
  // signup route — it must still return false cleanly. Pin that the
  // catch is in place.
  process.env.RESEND_API_KEY = "re_test_failure_text_throws";
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("stream closed");
      },
    }) as Response) as typeof fetch;

  const ok = await sendVerificationEmail("user@example.com", "333000");
  assert.equal(ok, false);
});
