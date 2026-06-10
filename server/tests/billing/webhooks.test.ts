/**
 * Tests for `handleStripeWebhook` (`server/src/billing/webhooks.ts`).
 *
 * The webhook is the only billing endpoint that is **not** behind the
 * console JWT auth — it's gated entirely by Stripe's signed-payload
 * verification. A regression that drops or reorders the verification
 * checks would let any internet caller forge `customer.subscription.*`
 * events and either suspend a paying agency or activate an unpaid one.
 *
 * The handler MUST in this exact order:
 *   1. Refuse with 503 `billing_not_configured` if Stripe credentials
 *      aren't set on the host (otherwise we'd construct a Stripe client
 *      from an undefined secret and fail confusingly later).
 *   2. Refuse with 400 `missing_signature` if the `Stripe-Signature`
 *      header is absent or non-string.
 *   3. Refuse with 400 `invalid_signature` if the body's HMAC doesn't
 *      match the stored webhook secret.
 *
 * Each test runs in a fresh Express server with the same raw-body
 * mounting the production code uses (`raw({ type: "application/json" })`),
 * because Stripe's signature verification operates on the byte-for-byte
 * request body — a regression that swapped this for `express.json()`
 * would silently break verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { handleStripeWebhook } from "../../src/billing/webhooks.js";

async function bootWebhookServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.post(
    "/v1/billing/webhook",
    express.raw({ type: "application/json" }),
    (req, res) => {
      void handleStripeWebhook(req, res);
    },
  );

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of keys) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  });
}

test("POST /v1/billing/webhook: returns 503 billing_not_configured when STRIPE_SECRET_KEY is unset", async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
    async () => {
      const { baseUrl, close } = await bootWebhookServer();
      try {
        const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "anything",
          },
          body: JSON.stringify({ type: "checkout.session.completed" }),
        });
        // The bouncer fires before signature verification, so we get the
        // documented 503 rather than a 400 invalid_signature that would
        // misleadingly suggest the secret was wrong.
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "billing_not_configured");
      } finally {
        await close();
      }
    },
  );
});

test("POST /v1/billing/webhook: returns 503 when STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing", async () => {
  // Belt-and-braces: even if the API key is wired up, we still refuse
  // until the *webhook* secret is configured. Otherwise any internet
  // caller could replay our own published event payloads.
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_dummy_for_webhook_tests",
      STRIPE_WEBHOOK_SECRET: undefined,
    },
    async () => {
      const { baseUrl, close } = await bootWebhookServer();
      try {
        const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "anything",
          },
          body: JSON.stringify({ type: "checkout.session.completed" }),
        });
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "billing_not_configured");
      } finally {
        await close();
      }
    },
  );
});

test("POST /v1/billing/webhook: returns 400 missing_signature when the Stripe-Signature header is absent", async () => {
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_dummy_for_webhook_tests",
      STRIPE_WEBHOOK_SECRET: "whsec_dummy_for_webhook_tests",
    },
    async () => {
      const { baseUrl, close } = await bootWebhookServer();
      try {
        const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "checkout.session.completed" }),
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

test("POST /v1/billing/webhook: returns 400 invalid_signature when the HMAC does not match", async () => {
  // The body is well-formed JSON, the signature header is present, but
  // it's not a real Stripe HMAC for our (fake) secret. `constructEvent`
  // throws → handler must respond 400 invalid_signature, NOT 200, NOT
  // 500. A regression where the try/catch is removed or the response
  // status is wrong would let a forged payload silently update an
  // agency's subscription state.
  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_dummy_for_webhook_tests",
      STRIPE_WEBHOOK_SECRET: "whsec_dummy_for_webhook_tests",
    },
    async () => {
      const { baseUrl, close } = await bootWebhookServer();
      try {
        const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "t=1700000000,v1=deadbeef",
          },
          body: JSON.stringify({
            id: "evt_test",
            type: "checkout.session.completed",
            data: { object: { metadata: { agency_id: "1" } } },
          }),
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
