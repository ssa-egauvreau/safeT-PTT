/**
 * Tests for `server/src/billing/email.ts`.
 *
 * `sendVerificationEmail` is the only outbound side-effect in the
 * self-service signup flow added in 4e7ffa6. It is called once per signup
 * request from `requestSignupVerification` (`signup.ts`) and its return
 * value gates whether the signup REST route reports success to the
 * caller — a regression that:
 *
 *  - Returned `false` in dev mode (no `RESEND_API_KEY`) would block every
 *    local / Cloud Agent signup behind an "email_send_failed" error even
 *    though the implementation deliberately logs-and-succeeds when the
 *    Resend API key is missing.
 *  - Returned `true` after Resend rejected the request (non-2xx) would
 *    pretend the verification code was delivered. The 6-digit code only
 *    lives in the `signup_verifications` table, so the user is stranded
 *    with no way to complete signup.
 *  - Issued the wrong request shape (URL, Authorization header, body
 *    keys) would either 401 at Resend (silent breakage in prod) or
 *    deliver an email with no recipient / no code.
 *
 * The handler is fully exercisable from a unit test because the only
 * external surface is `global.fetch`. We swap it per test, never modify
 * shared module state, and restore the original on teardown.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { sendVerificationEmail } from "../../src/billing/email.js";

const ORIGINAL = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  BILLING_FROM_EMAIL: process.env.BILLING_FROM_EMAIL,
  fetch: globalThis.fetch,
  log: console.log,
  warn: console.warn,
};

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.BILLING_FROM_EMAIL;
  // Silence the dev-mode console output so the test runner stays
  // quiet; individual tests reach in and inspect logs if they care.
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  if (ORIGINAL.RESEND_API_KEY === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = ORIGINAL.RESEND_API_KEY;
  }
  if (ORIGINAL.BILLING_FROM_EMAIL === undefined) {
    delete process.env.BILLING_FROM_EMAIL;
  } else {
    process.env.BILLING_FROM_EMAIL = ORIGINAL.BILLING_FROM_EMAIL;
  }
  globalThis.fetch = ORIGINAL.fetch;
  console.log = ORIGINAL.log;
  console.warn = ORIGINAL.warn;
});

// ---------------------------------------------------------------------------
// Dev-mode path: no RESEND_API_KEY
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns true in dev mode (no RESEND_API_KEY) without hitting the network", async () => {
  // Tripwire — the dev-mode short-circuit is the ONLY reason local
  // signup works without a Resend account. A regression that called
  // fetch anyway with `Authorization: Bearer null` would 401 silently.
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const ok = await sendVerificationEmail("dev@example.com", "123456");
  assert.equal(ok, true);
  assert.equal(fetchCalled, false, "dev mode must not call Resend");
});

test("sendVerificationEmail: dev mode logs the code so the developer can complete signup", async () => {
  // The signup form needs the 6-digit code; in dev mode the only
  // delivery channel is the server log. A regression that swallowed
  // the log would leave the dev with no way to finish signup.
  const logged: string[] = [];
  console.log = (msg: unknown) => {
    logged.push(String(msg));
  };
  const ok = await sendVerificationEmail("dev@example.com", "424242");
  assert.equal(ok, true);
  const line = logged.find((l) => l.includes("verification email (dev)"));
  assert.ok(line, "expected dev-mode log line");
  assert.ok(line!.includes("to=dev@example.com"), "log must include recipient");
  assert.ok(line!.includes("code=424242"), "log must include the 6-digit code");
});

// ---------------------------------------------------------------------------
// Resend-mode path: RESEND_API_KEY set
// ---------------------------------------------------------------------------

test("sendVerificationEmail: POSTs to the Resend /emails endpoint with the bearer token", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ id: "re_email_1" }), { status: 200 });
  }) as unknown as typeof fetch;

  const ok = await sendVerificationEmail("user@example.com", "987654");
  assert.equal(ok, true);

  assert.equal(capturedUrl, "https://api.resend.com/emails");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer re_test_key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(capturedInit?.method, "POST");
});

test("sendVerificationEmail: body carries the recipient, verification code, and configured from-address", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.BILLING_FROM_EMAIL = "billing@example.org";

  let capturedBody: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body as string | undefined;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await sendVerificationEmail("ops@example.com", "112233");
  assert.ok(capturedBody, "expected a JSON body");
  const payload = JSON.parse(capturedBody!) as {
    from: string;
    to: string[];
    subject: string;
    html: string;
  };
  // The recipient must be a single-element array — Resend treats a
  // bare string differently and quietly drops the message.
  assert.deepEqual(payload.to, ["ops@example.com"]);
  assert.equal(payload.from, "billing@example.org");
  assert.ok(payload.subject.length > 0, "subject must be non-empty");
  assert.ok(
    payload.html.includes("112233"),
    "html body must embed the 6-digit code (the only delivery channel for it)",
  );
});

test("sendVerificationEmail: falls back to billing@safetptt.com when BILLING_FROM_EMAIL is unset", async () => {
  // Mirrors the config.ts default — pin it here too so a refactor
  // of the default value catches the contract change end-to-end.
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.BILLING_FROM_EMAIL;

  let capturedBody: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body as string | undefined;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await sendVerificationEmail("ops@example.com", "112233");
  const payload = JSON.parse(capturedBody!) as { from: string };
  assert.equal(payload.from, "billing@safetptt.com");
});

test("sendVerificationEmail: returns false when Resend responds with a non-2xx status", async () => {
  // Resend returns 4xx on bad keys, throttled accounts, and
  // unverified from-addresses. The signup route surfaces our `false`
  // return value as an `email_send_failed` API error — silently
  // returning `true` here would mark the signup_verifications row as
  // delivered while the user never receives the code.
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
    })) as unknown as typeof fetch;

  const ok = await sendVerificationEmail("ops@example.com", "112233");
  assert.equal(ok, false);
});

test("sendVerificationEmail: returns false on 5xx and tolerates a non-text response body", async () => {
  // The helper catches errors from `res.text()` (Resend can disconnect
  // mid-body) so it must never throw out of the signup flow. Pin the
  // contract — a refactor that dropped the `.catch(() => "")` would
  // raise an unhandled rejection through Express and crash the route.
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 503,
    })) as unknown as typeof fetch;

  const ok = await sendVerificationEmail("ops@example.com", "112233");
  assert.equal(ok, false);
});

test("sendVerificationEmail: surfaces failures through console.warn (operator visibility)", async () => {
  // The only way an operator notices a misconfigured Resend account
  // in production is the warning log line. Make sure the failure
  // path actually emits it — a silent failure would let signups break
  // for hours without anyone noticing.
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = (async () =>
    new Response("bad request", { status: 400 })) as unknown as typeof fetch;

  const warned: string[] = [];
  console.warn = (msg: unknown) => {
    warned.push(String(msg));
  };
  const ok = await sendVerificationEmail("ops@example.com", "112233");
  assert.equal(ok, false);
  assert.ok(
    warned.some((m) => m.includes("verification email failed")),
    "expected an operator-visible warning on Resend failure",
  );
});

test("sendVerificationEmail: trims a leading-whitespace API key (mirrors config.resendApiKey)", async () => {
  // The Cloud Agent / Railway operator footgun is pasting an env var
  // with a leading newline. config.ts trims; pin that the email
  // helper also routes through that trim and does NOT send the
  // literal whitespace to Resend (which would 401).
  process.env.RESEND_API_KEY = "  re_test_trimmed  ";
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    capturedAuth = headers["Authorization"];
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await sendVerificationEmail("ops@example.com", "112233");
  assert.equal(capturedAuth, "Bearer re_test_trimmed");
});

test("sendVerificationEmail: whitespace-only RESEND_API_KEY falls back to dev mode (no fetch)", async () => {
  // `config.resendApiKey()` returns null for whitespace-only — the
  // email helper must therefore take the dev-mode short-circuit
  // instead of issuing a `Bearer null` request to Resend.
  process.env.RESEND_API_KEY = "   ";
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const ok = await sendVerificationEmail("ops@example.com", "112233");
  assert.equal(ok, true, "whitespace-only API key should still allow dev signup");
  assert.equal(fetchCalled, false, "whitespace-only API key must not hit Resend");
});
