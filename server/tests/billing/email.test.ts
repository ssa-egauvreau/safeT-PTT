/**
 * Tests for `server/src/billing/email.ts`.
 *
 * The verification email is the only channel that gates self-service signup
 * — until the user enters the 6-digit code from this email, no agency, no
 * admin, and no Stripe customer is created. Two regressions matter:
 *
 *   1. **Dev-mode short-circuit**: when `RESEND_API_KEY` is unset (every
 *      local + CI environment), the helper must NOT try to call Resend
 *      and must return `true` so the signup flow proceeds. A regression
 *      that returned `false` here would block every dev/test signup with
 *      an `email_send_failed` error and silently break the demo path.
 *
 *   2. **Resend HTTP outcome propagation**: when the API key IS set, the
 *      helper must report `false` on a non-2xx Resend response, otherwise
 *      we'd happily delete the verification row in Postgres while the
 *      operator never received a code and can never sign up. This file
 *      pins both the success (true) and failure (false) branches by
 *      stubbing `globalThis.fetch`.
 *
 * The Resend payload itself (subject, HTML body, from-address) is also
 * pinned because changing the from-domain without updating Resend's DKIM
 * config silently sends emails that land in every recipient's spam folder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendVerificationEmail } from "../../src/billing/email.js";

const ENV_KEYS = ["RESEND_API_KEY", "BILLING_FROM_EMAIL"] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function withFetchStub<T>(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// Dev-mode short-circuit
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns true and skips fetch when RESEND_API_KEY is unset", async () => {
  await withEnv({ RESEND_API_KEY: undefined }, () =>
    withFetchStub(
      () => {
        // If fetch is called in dev mode, fail loudly: a regression here would
        // hammer Resend with un-authenticated requests on every CI run.
        throw new Error("fetch must not be called in dev mode");
      },
      async (calls) => {
        const ok = await sendVerificationEmail("ops@example.com", "123456");
        assert.equal(ok, true);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("sendVerificationEmail: also dev-mode for whitespace-only RESEND_API_KEY", async () => {
  await withEnv({ RESEND_API_KEY: "   " }, () =>
    withFetchStub(
      () => {
        throw new Error("fetch must not be called when API key is whitespace");
      },
      async (calls) => {
        const ok = await sendVerificationEmail("ops@example.com", "123456");
        assert.equal(ok, true);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Resend HTTP outcome
// ---------------------------------------------------------------------------

test("sendVerificationEmail: returns true on a 2xx Resend response", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_123" }, () =>
    withFetchStub(
      () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }),
      async (calls) => {
        const ok = await sendVerificationEmail("ops@example.com", "123456");
        assert.equal(ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, "https://api.resend.com/emails");
      },
    ),
  );
});

test("sendVerificationEmail: returns false when Resend responds non-2xx", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_123" }, () =>
    withFetchStub(
      () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 422 }),
      async () => {
        const ok = await sendVerificationEmail("ops@example.com", "123456");
        assert.equal(ok, false);
      },
    ),
  );
});

test("sendVerificationEmail: returns false on a 5xx Resend outage", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_123" }, () =>
    withFetchStub(
      () => new Response("upstream timeout", { status: 503 }),
      async () => {
        const ok = await sendVerificationEmail("ops@example.com", "123456");
        assert.equal(ok, false);
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Resend request shape
// ---------------------------------------------------------------------------

test("sendVerificationEmail: sends bearer-auth POST with the recipient and code in HTML", async () => {
  // Pin the request shape so a refactor can't accidentally drop the bearer
  // header (every call would 401), change the path (every call would 404),
  // or leak the verification code into the wrong field.
  await withEnv({ RESEND_API_KEY: "re_test_xyz", BILLING_FROM_EMAIL: "billing@safetptt.com" }, () =>
    withFetchStub(
      () => new Response("{}", { status: 200 }),
      async (calls) => {
        await sendVerificationEmail("ops@example.com", "654321");
        assert.equal(calls.length, 1);
        const { url, init } = calls[0]!;
        assert.equal(url, "https://api.resend.com/emails");
        assert.equal(init.method, "POST");
        const headers = init.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer re_test_xyz");
        assert.equal(headers["Content-Type"], "application/json");
        const body = JSON.parse(String(init.body)) as {
          from: string;
          to: string[];
          subject: string;
          html: string;
        };
        assert.equal(body.from, "billing@safetptt.com");
        assert.deepEqual(body.to, ["ops@example.com"]);
        assert.match(body.subject, /verification code/i);
        assert.match(body.html, /654321/);
      },
    ),
  );
});

test("sendVerificationEmail: BILLING_FROM_EMAIL override is honoured", async () => {
  await withEnv(
    { RESEND_API_KEY: "re_test_xyz", BILLING_FROM_EMAIL: "alerts@safet.example" },
    () =>
      withFetchStub(
        () => new Response("{}", { status: 200 }),
        async (calls) => {
          await sendVerificationEmail("ops@example.com", "111222");
          const body = JSON.parse(String(calls[0]!.init.body)) as { from: string };
          assert.equal(body.from, "alerts@safet.example");
        },
      ),
  );
});
