/**
 * Tests for the pure helpers exported from `server/src/billing/webhooks.ts`.
 *
 * The webhook handler itself talks to Stripe + the agency store, but two
 * tiny helpers do the entire conversion of Stripe-shaped data into
 * platform decisions, and they are pinned here:
 *
 *  - `mapStripeStatus` is the single source of truth for "what happens
 *    when Stripe says X". A regression that maps `unpaid` → `active`
 *    silently keeps a non-paying agency online; mapping a future Stripe
 *    state (e.g. `paused`) onto `active` is even worse — currently it
 *    falls through to `past_due`, which trips the disabled gate in
 *    `applySubscription`. The default-branch test pins that fail-safe.
 *  - `agencyIdFromMeta` is how the webhook recovers WHICH agency to
 *    update. A regression that returned `0` instead of `null` would
 *    overwrite agency id 0 (or, worse, the first row in the SET); a
 *    `NaN` slipping through would `UPDATE agencies WHERE id = NaN`,
 *    failing mid-webhook and forcing Stripe to retry into eternity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  agencyIdFromMeta,
  isStripeSubscriptionActive,
  mapStripeStatus,
  processStripeEvent,
} from "../../src/billing/webhooks.js";

test("mapStripeStatus: collapses every non-active Stripe state onto our paywall states", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
  // Both Stripe failure states must trip the past_due paywall.
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
  // Both terminal cancellation states must collapse onto our `canceled`
  // — `incomplete_expired` is "the customer never finished checkout"
  // and is functionally a cancel.
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("incomplete_expired"), "canceled");
});

test("mapStripeStatus: unknown / future Stripe states fall back to past_due (fail-closed)", () => {
  // Stripe can ship new subscription states without a Stripe SDK
  // upgrade (the union type is just a TypeScript projection of the
  // remote API). The default branch must NOT fall back to "active"; if
  // it does, an unknown state would silently keep a possibly-broken
  // agency online. `past_due` is the safe choice — it disables the
  // agency until an admin resolves the situation.
  const exotic = "paused" as unknown as Stripe.Subscription.Status;
  assert.equal(mapStripeStatus(exotic), "past_due");

  const incomplete = "incomplete" as unknown as Stripe.Subscription.Status;
  assert.equal(
    mapStripeStatus(incomplete),
    "past_due",
    "'incomplete' (the post-Checkout, pre-payment state) must NOT count as active",
  );
});

test("mapStripeStatus: never returns 'comped' (that's a platform-only state, never a Stripe state)", () => {
  // The "comped" state is set manually by the platform owner from the
  // owner portal — Stripe never emits it. A regression that mapped any
  // Stripe state onto comped would un-track that agency from billing
  // entirely.
  const stripeStates: Stripe.Subscription.Status[] = [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete_expired",
    "incomplete" as Stripe.Subscription.Status,
  ];
  for (const s of stripeStates) {
    assert.notEqual(mapStripeStatus(s), "comped", `state ${s} must not collapse onto 'comped'`);
  }
});

test("isStripeSubscriptionActive: true only for active and trialing", () => {
  assert.equal(isStripeSubscriptionActive("active"), true);
  assert.equal(isStripeSubscriptionActive("trialing"), true);
});

test("isStripeSubscriptionActive: false for delinquent/canceled/unknown states", () => {
  assert.equal(isStripeSubscriptionActive("past_due"), false);
  assert.equal(isStripeSubscriptionActive("unpaid"), false);
  assert.equal(isStripeSubscriptionActive("canceled"), false);
  assert.equal(isStripeSubscriptionActive("incomplete_expired"), false);
  assert.equal(isStripeSubscriptionActive("incomplete"), false);
  assert.equal(isStripeSubscriptionActive("paused"), false);
  assert.equal(
    isStripeSubscriptionActive("brand_new_status" as unknown as Stripe.Subscription.Status),
    false,
  );
});

test("agencyIdFromMeta: extracts numeric agency_id from Stripe metadata", () => {
  assert.equal(agencyIdFromMeta({ agency_id: "42" }), 42);
  assert.equal(agencyIdFromMeta({ agency_id: "1" }), 1);
});

test("agencyIdFromMeta: returns null when metadata is missing or empty", () => {
  // The webhook handler treats `null` here as "this event isn't ours,
  // ignore it"; any non-null number triggers an UPDATE on the agencies
  // table, so the boundary cases must read as null cleanly.
  assert.equal(agencyIdFromMeta(null), null);
  assert.equal(agencyIdFromMeta(undefined), null);
  assert.equal(agencyIdFromMeta({}), null);
  // Stripe metadata values can technically be empty strings — must
  // also surface as null instead of NaN.
  assert.equal(agencyIdFromMeta({ agency_id: "" }), null);
});

test("agencyIdFromMeta: tolerates trailing-junk strings (parseInt semantics)", () => {
  // Documented Node behaviour: parseInt("42abc", 10) === 42. This is
  // the historical behaviour of the helper — we want to assert it
  // explicitly so a refactor to Number()/coerce doesn't silently
  // tighten the contract and start dropping legitimate Stripe events
  // whose metadata was double-stringified by an earlier integration.
  assert.equal(agencyIdFromMeta({ agency_id: "42abc" }), 42);
});

test("agencyIdFromMeta: returns null for non-numeric agency_id strings", () => {
  // A non-numeric value (e.g. someone wrote "agency_42" or a slug)
  // must NOT silently collapse to 0 or NaN — it must read as null so
  // the webhook ignores the event instead of issuing a destructive
  // UPDATE on agency id 0.
  assert.equal(agencyIdFromMeta({ agency_id: "not-a-number" }), null);
  assert.equal(agencyIdFromMeta({ agency_id: "agency_42" }), null);
  assert.equal(agencyIdFromMeta({ agency_id: "abc" }), null);
});

test("agencyIdFromMeta: parses negative values verbatim (no silent clamping)", () => {
  // Negative is a clear signal of a misconfigured metadata value, but
  // the helper today returns the parsed number as-is and lets the
  // caller's UPDATE WHERE id = -1 simply hit zero rows. Pin that
  // contract — a regression that started clamping to 0 would silently
  // re-route a misconfigured event onto agency id 0.
  assert.equal(agencyIdFromMeta({ agency_id: "-1" }), -1);
});

test("agencyIdFromMeta: does NOT use other metadata keys (just `agency_id`)", () => {
  // Pin the exact key — a refactor that started reading `agencyId` or
  // `id` would silently start sending writes to agencies whose
  // metadata has unrelated numeric fields.
  assert.equal(agencyIdFromMeta({ agencyId: "42" } as unknown as Stripe.Metadata), null);
  assert.equal(agencyIdFromMeta({ id: "42" } as unknown as Stripe.Metadata), null);
});

// ---------------------------------------------------------------------------
// processStripeEvent
// ---------------------------------------------------------------------------

test("processStripeEvent: checkout completion never force-enables a past-due subscription", async () => {
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  const fakeStripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        assert.equal(subscriptionId, "sub_123");
        return {
          id: "sub_123",
          status: "past_due",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "42" },
          subscription: "sub_123",
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.agencyId, 42);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updateCalls[0]?.patch.disabled, true);
  assert.ok(!updateCalls.some((call) => call.patch.disabled === false));
});

// ---------------------------------------------------------------------------
// processStripeEvent: customer.subscription.updated / deleted / invoice.payment_failed
//
// These branches are the bulk of how Stripe tells us a tenant's payment
// state changed. Each one feeds into `applySubscription` which then
// rewrites the agency's `subscription_status`, `disabled`, `plan_tier`,
// `logs_unlimited`, `transmission_retention_days`, and `trial_ends_at`
// fields. A bug here is a paywall bug — either non-paying agencies
// stay enabled or paying agencies get suspended — so each branch is
// pinned with an end-to-end driver that runs the real
// `processStripeEvent` against fake Stripe + fake store deps.
// ---------------------------------------------------------------------------

/** Build a Stripe.Subscription stub with sensible defaults for the test. */
function fakeSubscription(overrides: {
  id?: string;
  status: Stripe.Subscription.Status;
  metadata?: Record<string, string>;
  trial_end?: number | null;
}): Stripe.Subscription {
  return {
    id: overrides.id ?? "sub_test",
    status: overrides.status,
    metadata: overrides.metadata ?? { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: overrides.trial_end ?? null,
  } as unknown as Stripe.Subscription;
}

interface RecordedUpdate {
  agencyId: number;
  patch: Record<string, unknown>;
}

/**
 * Fake store + Stripe collectors used by the processStripeEvent tests.
 * `agencyRows` lets a test pin a specific `subscription_status` on the
 * agency lookup that runs after `applySubscription` in the updated/
 * deleted branches — the comped-agency safeguard depends on it.
 */
function makeDeps(agencyRows: Record<number, { subscription_status: string }> = {}) {
  const updateCalls: RecordedUpdate[] = [];
  return {
    updateCalls,
    deps: {
      async updateAgencyBilling(agencyId: number, patch: Record<string, unknown>) {
        updateCalls.push({ agencyId, patch });
        return null;
      },
      async getAgencyById(agencyId: number) {
        return (agencyRows[agencyId] ?? null) as never;
      },
    },
  };
}

test("processStripeEvent: customer.subscription.updated with active sub re-enables the agency", async () => {
  // The most common renewal-after-failure path. Stripe says active; the
  // platform must mirror that by un-disabling the row. A regression that
  // forgot the second `updateAgencyBilling` call (the post-getAgencyById
  // one) would leave a paying customer locked out after recovery.
  const { updateCalls, deps } = makeDeps({ 42: { subscription_status: "past_due" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: fakeSubscription({
          id: "sub_active",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "false" },
        }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
    deps,
  );

  // Two writes: applySubscription, then the explicit disabled-sync write.
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(updateCalls[0]?.patch.disabled, false);
  assert.equal(updateCalls[0]?.patch.planTier, "pro");
  // The follow-up sync must agree — never re-disable an active sub.
  assert.equal(updateCalls[1]?.patch.disabled, false);
});

test("processStripeEvent: customer.subscription.deleted disables the agency and marks it canceled", async () => {
  // Hard cancel: Stripe says the subscription is gone. We must record
  // status=canceled AND disabled=true. A regression that mapped canceled
  // → active (e.g. a default-branch flip) would keep an ex-customer's
  // radios online.
  const { updateCalls, deps } = makeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: fakeSubscription({
          id: "sub_gone",
          status: "canceled",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
        }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "canceled" }) } },
    deps,
  );

  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(updateCalls[0]?.patch.disabled, true);
  // Follow-up sync must agree.
  assert.equal(updateCalls[1]?.patch.disabled, true);
});

test("processStripeEvent: comped agency is NEVER force-disabled by subscription.updated", async () => {
  // A platform-comped tenant has `subscription_status = 'comped'` set by
  // the owner portal. Stripe might still fire spurious updated events
  // (e.g. a leftover test subscription), and the second `updateAgencyBilling`
  // call must skip those agencies. This is the single most important
  // safeguard in the webhook — losing it would let a stray Stripe event
  // suspend a hand-comped, non-billing tenant (often the platform owner's
  // own demo agency).
  const { updateCalls, deps } = makeDeps({ 42: { subscription_status: "comped" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: fakeSubscription({
          id: "sub_x",
          status: "canceled", // would normally disable
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
        }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "canceled" }) } },
    deps,
  );

  // applySubscription still writes once (it is unaware of the comped
  // flag, by design — comped is enforced at the second-write level).
  // The pin here is that the second sync write does NOT happen.
  assert.equal(
    updateCalls.length,
    1,
    "comped agency must not receive the disabled-sync follow-up write",
  );
});

test("processStripeEvent: invoice.payment_failed loads subscription and marks past_due + disabled", async () => {
  // The payment-failed branch routes through the subscription retrieval
  // step (the invoice itself doesn't carry the new status). A regression
  // that skipped the retrieve or used the invoice's old status would
  // leave the agency in 'active' after a billing failure.
  const { updateCalls, deps } = makeDeps();
  let retrievedId: string | null = null;
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: {
            subscription_details: { subscription: "sub_fail" },
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event,
    {
      subscriptions: {
        async retrieve(id: string) {
          retrievedId = id;
          return fakeSubscription({
            id: "sub_fail",
            status: "past_due",
            metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          });
        },
      },
    },
    deps,
  );

  assert.equal(retrievedId, "sub_fail");
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed with no subscription reference is a no-op", async () => {
  // Some Stripe invoices are not subscription-tied (e.g. one-off
  // invoices). Without a subscription id we have no agency to update.
  // Pin the no-op so a future refactor can't start reaching into other
  // invoice fields and write to the wrong agency.
  const { updateCalls, deps } = makeDeps();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { parent: null } as unknown as Stripe.Invoice },
    } as unknown as Stripe.Event,
    {
      subscriptions: {
        async retrieve() {
          retrieveCalled = true;
          return fakeSubscription({ status: "active" });
        },
      },
    },
    deps,
  );
  assert.equal(updateCalls.length, 0);
  assert.equal(retrieveCalled, false);
});

test("processStripeEvent: subscription event without agency_id metadata is a no-op", async () => {
  // The agency id is the only thing tying a Stripe event to one of our
  // tenants. If it's missing (e.g. a subscription created outside our
  // checkout flow), the handler MUST NOT issue any UPDATE — otherwise
  // a missing-meta event would have to either error out (Stripe retries
  // forever) or write to agency id 0.
  const { updateCalls, deps } = makeDeps();
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: fakeSubscription({ status: "active", metadata: {} }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
    deps,
  );
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: unknown event types are silently ignored", async () => {
  // Stripe emits many event types we never registered an interest in.
  // The default branch must do nothing — not throw, not write — so the
  // webhook returns 200 and Stripe doesn't retry the same noise forever.
  const { updateCalls, deps } = makeDeps();
  await processStripeEvent(
    {
      type: "customer.created",
      data: { object: {} },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
    deps,
  );
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed without a subscription string is a no-op", async () => {
  // The checkout webhook only fires once the customer finished a
  // subscription-mode checkout, but a Setup-mode session or a
  // malformed payload may arrive with `subscription === null`. We must
  // not call `stripe.subscriptions.retrieve(null)` — that would throw
  // and force Stripe to retry the same broken event forever.
  const { updateCalls, deps } = makeDeps();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: { metadata: { agency_id: "42" }, subscription: null } as unknown as Stripe.Checkout.Session,
      },
    } as unknown as Stripe.Event,
    {
      subscriptions: {
        async retrieve() {
          retrieveCalled = true;
          return fakeSubscription({ status: "active" });
        },
      },
    },
    deps,
  );
  assert.equal(updateCalls.length, 0);
  assert.equal(retrieveCalled, false);
});

test("processStripeEvent: trial_end on the subscription becomes a UTC ISO trialEndsAt", async () => {
  // `applySubscription` converts the unix-seconds `trial_end` into an
  // ISO string for the `trial_ends_at` column. The trial-sweep job
  // and the admin Billing panel both parse this column with
  // `new Date(string)`, so the conversion must produce a valid ISO
  // string in UTC. Pin the conversion so a refactor to a locale-aware
  // formatter is caught.
  const { updateCalls, deps } = makeDeps();
  const trialUnix = Math.floor(Date.UTC(2030, 0, 15, 12, 0, 0) / 1000);
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: fakeSubscription({
          status: "trialing",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: trialUnix,
        }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "trialing" }) } },
    deps,
  );
  assert.ok(updateCalls.length >= 1);
  assert.equal(updateCalls[0]?.patch.trialEndsAt, "2030-01-15T12:00:00.000Z");
});

test("processStripeEvent: logsUnlimited=true blanks transmissionRetentionDays, false sets 3", async () => {
  // The "unlimited logs" add-on is the only thing that lifts the
  // 3-day retention cap. The webhook must keep the two columns in
  // sync: `logs_unlimited=true` → `transmission_retention_days=null`
  // (meaning "keep forever"), and false → 3. A drift here means the
  // nightly retention sweep silently deletes a paying customer's audio.
  for (const logsUnlimited of [true, false]) {
    const { updateCalls, deps } = makeDeps();
    await processStripeEvent(
      {
        type: "customer.subscription.updated",
        data: {
          object: fakeSubscription({
            status: "active",
            metadata: {
              agency_id: "42",
              plan_tier: "basic",
              logs_unlimited: logsUnlimited ? "true" : "false",
            },
          }),
        },
      } as unknown as Stripe.Event,
      { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
      deps,
    );
    assert.ok(updateCalls.length >= 1);
    assert.equal(updateCalls[0]?.patch.logsUnlimited, logsUnlimited);
    assert.equal(
      updateCalls[0]?.patch.transmissionRetentionDays,
      logsUnlimited ? null : 3,
      `logs_unlimited=${logsUnlimited} must drive retention_days=${logsUnlimited ? "null" : "3"}`,
    );
  }
});

test("processStripeEvent: missing/unknown plan_tier defaults to 'basic'", async () => {
  // `applySubscription` parses `plan_tier` strictly — anything other
  // than the literal "pro" collapses to "basic". This pins the
  // narrowing so a refactor that started accepting arbitrary strings
  // can't silently push a tenant onto an unknown tier.
  for (const meta of [
    { agency_id: "42", logs_unlimited: "false" } as Record<string, string>,
    { agency_id: "42", plan_tier: "gold", logs_unlimited: "false" } as Record<string, string>,
    { agency_id: "42", plan_tier: "", logs_unlimited: "false" } as Record<string, string>,
  ]) {
    const { updateCalls, deps } = makeDeps();
    await processStripeEvent(
      {
        type: "customer.subscription.updated",
        data: {
          object: fakeSubscription({
            status: "active",
            metadata: meta,
          }),
        },
      } as unknown as Stripe.Event,
      { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
      deps,
    );
    assert.ok(updateCalls.length >= 1);
    assert.equal(updateCalls[0]?.patch.planTier, "basic");
  }
});

test("processStripeEvent: 'pro' plan_tier is preserved through to the UPDATE", async () => {
  // The complement of the previous test — the only string that must
  // round-trip is "pro". Pin it explicitly so a regression that
  // started lowercasing or trimming differently is caught.
  const { updateCalls, deps } = makeDeps();
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: fakeSubscription({
          status: "active",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
        }),
      },
    } as unknown as Stripe.Event,
    { subscriptions: { retrieve: async () => fakeSubscription({ status: "active" }) } },
    deps,
  );
  assert.ok(updateCalls.length >= 1);
  assert.equal(updateCalls[0]?.patch.planTier, "pro");
  assert.equal(updateCalls[0]?.patch.logsUnlimited, true);
});
