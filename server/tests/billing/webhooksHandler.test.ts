/**
 * HTTP-level tests for `handleStripeWebhook` early-return paths.
 *
 * The webhook is the only path that flips an agency between active and
 * `disabled = true`. Even before the signature verification + event dispatch
 * runs, three guard rails MUST hold:
 *
 *   1. When billing is not configured (no `STRIPE_SECRET_KEY` /
 *      `STRIPE_WEBHOOK_SECRET`) the handler must return **503
 *      `billing_not_configured`** — never 500, never 200, never any
 *      side-effect that depends on a real Stripe SDK instance.
 *
 *   2. When the request lacks a `stripe-signature` header (or has a
 *      non-string one), the handler must return **400 `missing_signature`**
 *      and skip Stripe's `constructEvent`, otherwise an unauthenticated
 *      caller could drive arbitrary subscription updates.
 *
 *   3. When the signature is wrong, Stripe's `constructEvent` throws and
 *      the handler must return **400 `invalid_signature`** — never 500.
 *
 * These three are pure-handler behaviours: no DB, no real Stripe call,
 * no event dispatch. They cover the majority of accidental misconfig +
 * malicious-traffic regressions in one cheap test file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleStripeWebhook } from "../../src/billing/webhooks.js";

interface BootResult {
  baseUrl: string;
  close: () => Promise<void>;
}

async function bootWebhook(): Promise<BootResult> {
  const app = express();
  // The real server mounts the webhook with `express.raw` so the body is a
  // Buffer (Stripe.constructEvent needs the byte-exact payload). Mirror that.
  app.post("/webhooks/stripe", express.raw({ type: "*/*" }), handleStripeWebhook);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("handleStripeWebhook: 503 billing_not_configured when STRIPE_SECRET_KEY is missing", async () => {
  await withEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: "whsec_x" }, async () => {
    const { baseUrl, close } = await bootWebhook();
    try {
      const res = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "billing_not_configured");
    } finally {
      await close();
    }
  });
});

test("handleStripeWebhook: 503 billing_not_configured when STRIPE_WEBHOOK_SECRET is missing", async () => {
  // A live Stripe key without a webhook secret is the most common operator
  // misconfiguration (the secret is set in a separate Stripe dashboard).
  // The handler MUST refuse rather than process events with no signature
  // verification — letting unsigned events through would let any caller
  // who guessed the URL flip subscriptions.
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: undefined }, async () => {
    const { baseUrl, close } = await bootWebhook();
    try {
      const res = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "billing_not_configured");
    } finally {
      await close();
    }
  });
});

test("handleStripeWebhook: 400 missing_signature when stripe-signature header is absent", async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: "whsec_x" },
    async () => {
      const { baseUrl, close } = await bootWebhook();
      try {
        const res = await fetch(`${baseUrl}/webhooks/stripe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "missing_signature");
      } finally {
        await close();
      }
    },
  );
});

test("handleStripeWebhook: 400 invalid_signature when the signature does not verify", async () => {
  // We can't easily forge a valid signature without leaking the secret, so
  // any nonzero signature must be rejected as invalid (NOT 500). Pinning
  // this 400 contract guards against a future refactor that turned the
  // `try/catch` around `constructEvent` into a 500 stack trace.
  await withEnv(
    { STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: "whsec_x" },
    async () => {
      const { baseUrl, close } = await bootWebhook();
      try {
        const res = await fetch(`${baseUrl}/webhooks/stripe`, {
          method: "POST",
          headers: {
            "stripe-signature": "t=1,v1=deadbeef",
            "content-type": "application/json",
          },
          body: "{}",
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "invalid_signature");
      } finally {
        await close();
      }
    },
  );
});
