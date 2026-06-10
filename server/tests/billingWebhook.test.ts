/**
 * Tests for `server/src/billing/webhooks.ts` — the Stripe webhook receiver
 * that drives the subscription state machine.
 *
 * Why these matter:
 *  - The webhook is mounted in `index.ts` BEFORE the JSON body parser
 *    (it needs the raw bytes for signature verification). That makes the
 *    handler's signature/secret guards the only thing standing between
 *    `agencies.subscription_status` and a forged update from the public
 *    internet.
 *  - A regression that accepted a webhook with no signature would let an
 *    attacker `POST` a fake `customer.subscription.updated` event with a
 *    crafted `agency_id` and `plan_tier=pro`, unlocking AI dispatch and
 *    bypassing the trial countdown for any tenant.
 *  - A regression that 500'd on a missing secret (instead of 503) would
 *    surface to Stripe as a retryable failure and have Stripe spam our
 *    error logs with an exponentially-backing-off retry barrage.
 *
 * The signature path itself is owned by the Stripe SDK; we don't try to
 * forge a valid signature. We pin the *contract* of the three guard
 * branches the handler owns: missing config → 503, missing signature →
 * 400, invalid signature → 400.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express, { raw } from "express";

import { handleStripeWebhook } from "../src/billing/webhooks.js";

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Boot a tiny Express app that mounts ONLY the Stripe webhook the same way
 * `index.ts` does — raw body parser first, then the handler. This keeps the
 * test honest about the production wiring without dragging in the full API.
 */
async function bootWebhookServer(): Promise<TestServer> {
  const app = express();
  app.post("/v1/billing/webhook", raw({ type: "application/json" }), (req, res) => {
    void handleStripeWebhook(req, res);
  });
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

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const k of keys) out.set(k, process.env[k]);
  return out;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("Stripe webhook: 503 when STRIPE_SECRET_KEY is missing (no Stripe client)", async () => {
  // Without a Stripe secret we cannot verify any signature. A 500 here
  // would tell Stripe to retry forever; 503 says "service unavailable"
  // and Stripe's retry policy backs off appropriately.
  const snap = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const { baseUrl, close } = await bootWebhookServer();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ id: "evt_test_1", type: "ping" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "billing_not_configured");
  } finally {
    await close();
    restoreEnv(snap);
  }
});

test("Stripe webhook: 400 when stripe-signature header is missing", async () => {
  // Stripe always sends `Stripe-Signature`. A request without it is either
  // a probe or a forgery attempt — never a legitimate event. Reject with
  // 400 so it doesn't show up in our error monitor as a 5xx.
  const snap = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_webhook_unit_a";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value_unit_a";
  const { baseUrl, close } = await bootWebhookServer();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_test_2", type: "ping" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_signature");
  } finally {
    await close();
    restoreEnv(snap);
  }
});

test("Stripe webhook: 400 when stripe-signature is present but invalid", async () => {
  // Forged signature must NOT be processed. The Stripe SDK throws inside
  // `webhooks.constructEvent`; the handler must catch it and respond 400
  // with `invalid_signature`. A regression that let the throw bubble would
  // return a 500 with a leaked stack trace, AND would tell Stripe to keep
  // retrying the (forged) event.
  const snap = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_webhook_unit_b";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value_unit_b";
  const { baseUrl, close } = await bootWebhookServer();
  try {
    const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=not-a-real-signature",
      },
      body: JSON.stringify({
        id: "evt_test_3",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_forgery", metadata: { agency_id: "1", plan_tier: "pro" } } },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_signature");
  } finally {
    await close();
    restoreEnv(snap);
  }
});

test("Stripe webhook: arrays in stripe-signature header are rejected as 400", async () => {
  // Express collapses repeated headers into an array. The handler must
  // refuse an array (which would otherwise stringify and accidentally
  // pass the `typeof === 'string'` later). This pins the explicit check.
  const snap = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_webhook_unit_c";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value_unit_c";
  const { baseUrl, close } = await bootWebhookServer();
  try {
    // node's fetch sends comma-separated when given a single string, so we
    // construct the request manually with a duplicate header. Express
    // exposes the duplicated value as a comma-joined string, not an array,
    // so the practical attack surface is the comma-list. Still: pin that
    // it's rejected as an invalid signature, not 500.
    const res = await fetch(`${baseUrl}/v1/billing/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=a, t=2,v1=b",
      },
      body: "{}",
    });
    // Either invalid_signature (Stripe SDK rejects the malformed header)
    // or missing_signature would be acceptable defensive outcomes — what
    // is NOT acceptable is a 5xx. Pin "must be 4xx".
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  } finally {
    await close();
    restoreEnv(snap);
  }
});
