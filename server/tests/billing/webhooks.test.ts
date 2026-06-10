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
// processStripeEvent — additional coverage
//
// The webhook fan-out is the platform's *only* way to learn about Stripe
// state changes: a regression in this switch silently keeps a delinquent
// agency online (or, the inverse, kicks a paying agency offline). The cases
// below pin every branch the handler can take so a future refactor of the
// switch loses nothing silently.
// ---------------------------------------------------------------------------

interface CapturedCall {
  agencyId: number;
  patch: Record<string, unknown>;
}

interface FakeStore {
  deps: {
    updateAgencyBilling: (
      agencyId: number,
      patch: Record<string, unknown>,
    ) => Promise<null>;
    getAgencyById: (id: number) => Promise<unknown>;
  };
  updateCalls: CapturedCall[];
  getAgencyByIdCalls: number[];
}

function makeFakeStore(opts: { agency?: unknown } = {}): FakeStore {
  const updateCalls: CapturedCall[] = [];
  const getAgencyByIdCalls: number[] = [];
  return {
    updateCalls,
    getAgencyByIdCalls,
    deps: {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch });
        return null;
      },
      async getAgencyById(id) {
        getAgencyByIdCalls.push(id);
        return opts.agency ?? null;
      },
    },
  };
}

function fakeStripe(opts: {
  expectedSubId?: string;
  sub?: Partial<Stripe.Subscription>;
  onRetrieve?: (subscriptionId: string) => void;
}) {
  return {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        if (opts.expectedSubId !== undefined) {
          assert.equal(subscriptionId, opts.expectedSubId);
        }
        opts.onRetrieve?.(subscriptionId);
        return {
          id: subscriptionId,
          status: "active",
          metadata: {},
          trial_end: null,
          ...opts.sub,
        } as unknown as Stripe.Subscription;
      },
    },
  };
}

test("processStripeEvent: checkout completion with active subscription unsuspends agency", async () => {
  // Happy path: a fresh signup completing checkout. The fix kept the
  // disabled state aligned with the *fetched* subscription state — when
  // Stripe says active, we must clear `disabled` so the new agency can
  // actually log in.
  const store = makeFakeStore();
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "7" }, subscription: "sub_ok" } },
    } as unknown as Stripe.Event,
    fakeStripe({
      expectedSubId: "sub_ok",
      sub: {
        id: "sub_ok",
        status: "active",
        metadata: { agency_id: "7", plan_tier: "pro", logs_unlimited: "true" },
        trial_end: null,
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.agencyId, 7);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
  assert.equal(store.updateCalls[0]?.patch.planTier, "pro");
  assert.equal(store.updateCalls[0]?.patch.logsUnlimited, true);
  assert.equal(store.updateCalls[0]?.patch.transmissionRetentionDays, null);
  assert.equal(store.updateCalls[0]?.patch.stripeSubscriptionId, "sub_ok");
});

test("processStripeEvent: checkout completion is a no-op when session metadata has no agency_id", async () => {
  // Webhooks for sessions we did not initiate (or with truncated metadata)
  // must NOT write anything — otherwise we'd issue an UPDATE on agency id
  // 0/NaN and either corrupt the wrong tenant or throw and force Stripe
  // into an infinite retry loop.
  const store = makeFakeStore();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: {}, subscription: "sub_xyz" } },
    } as unknown as Stripe.Event,
    fakeStripe({ onRetrieve: () => (retrieveCalled = true) }),
    store.deps,
  );

  assert.equal(retrieveCalled, false, "must not even call Stripe.subscriptions.retrieve");
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: checkout completion is a no-op when session.subscription is not a string", async () => {
  // One-time checkout sessions (e.g. a non-subscription product) leave
  // `subscription: null` on the session payload. Stripe's TS types also
  // permit a hydrated Subscription object. Either way the handler must
  // bail out — calling `subscriptions.retrieve(null)` would throw and
  // trip the 500 path.
  const store = makeFakeStore();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: { metadata: { agency_id: "9" }, subscription: null },
      },
    } as unknown as Stripe.Event,
    fakeStripe({ onRetrieve: () => (retrieveCalled = true) }),
    store.deps,
  );

  assert.equal(retrieveCalled, false);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: customer.subscription.updated → active clears the disabled flag", async () => {
  // Simulates a delinquent agency paying their invoice: Stripe transitions
  // the subscription back to `active` and we must re-enable the agency.
  const store = makeFakeStore({
    agency: { id: 11, subscription_status: "past_due", disabled: true },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_11",
          status: "active",
          metadata: { agency_id: "11", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "active",
        metadata: { agency_id: "11", plan_tier: "basic", logs_unlimited: "false" },
      },
    }),
    store.deps,
  );

  assert.equal(store.getAgencyByIdCalls.length, 1);
  assert.equal(store.getAgencyByIdCalls[0], 11);
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
  assert.equal(store.updateCalls[0]?.patch.planTier, "basic");
  assert.equal(store.updateCalls[0]?.patch.logsUnlimited, false);
  assert.equal(store.updateCalls[0]?.patch.transmissionRetentionDays, 3);
});

test("processStripeEvent: customer.subscription.updated → past_due disables the agency", async () => {
  // The other direction: Stripe escalates a delinquent invoice to
  // `past_due` and we must drop the agency offline.
  const store = makeFakeStore({
    agency: { id: 12, subscription_status: "active" },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_12",
          status: "past_due",
          metadata: { agency_id: "12", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "past_due",
        metadata: { agency_id: "12", plan_tier: "pro", logs_unlimited: "true" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: customer.subscription.updated leaves a 'comped' agency's disabled flag alone", async () => {
  // 'comped' is the platform-only "the owner gave them this for free"
  // state. Owner-disabled comped agencies must stay disabled even when
  // Stripe emits unrelated subscription events.
  const store = makeFakeStore({
    agency: { id: 13, subscription_status: "comped", disabled: true },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_13",
          status: "canceled",
          metadata: { agency_id: "13", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "canceled",
        metadata: { agency_id: "13", plan_tier: "pro", logs_unlimited: "true" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: customer.subscription.updated does not write disabled when agency lookup returns null", async () => {
  // Defensive: if the agency was deleted, applySubscription still runs
  // (no throw) and writes based on the fetched subscription alone.
  const store = makeFakeStore({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_14",
          status: "active",
          metadata: { agency_id: "14", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "active",
        metadata: { agency_id: "14", plan_tier: "basic", logs_unlimited: "false" },
      },
    }),
    store.deps,
  );

  assert.equal(store.getAgencyByIdCalls.length, 1);
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
});

test("processStripeEvent: customer.subscription.deleted disables and writes canceled status", async () => {
  // A `customer.subscription.deleted` event signals the customer churned.
  const store = makeFakeStore({
    agency: { id: 15, subscription_status: "active" },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_15",
          status: "canceled",
          metadata: { agency_id: "15", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "canceled",
        metadata: { agency_id: "15", plan_tier: "pro", logs_unlimited: "true" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed retrieves the referenced subscription and applies it", async () => {
  // The 2024+ Stripe Invoice API exposes the linked subscription via
  // `parent.subscription_details.subscription`. The handler must extract
  // it, fetch the canonical subscription, and run applySubscription —
  // which will then map past_due → past_due and disable the agency. A
  // regression here means a failed-payment event silently does nothing.
  const store = makeFakeStore();
  let seen = "";
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_failed" } },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      onRetrieve: (id) => (seen = id),
      sub: {
        id: "sub_failed",
        status: "past_due",
        metadata: { agency_id: "20", plan_tier: "pro", logs_unlimited: "true" },
        trial_end: null,
      },
    }),
    store.deps,
  );

  assert.equal(seen, "sub_failed");
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.agencyId, 20);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed accepts the hydrated subscription object form", async () => {
  // Stripe's TS types also allow `subscription_details.subscription` to be
  // a hydrated Subscription object instead of a string id. The handler
  // reads `.id` off that object — pin it so a refactor that drops the
  // object branch doesn't silently start ignoring half of Stripe's
  // production payloads.
  const store = makeFakeStore();
  let seen = "";
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: {
            subscription_details: { subscription: { id: "sub_obj_form" } },
          },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      onRetrieve: (id) => (seen = id),
      sub: {
        id: "sub_obj_form",
        status: "past_due",
        metadata: { agency_id: "21", plan_tier: "basic", logs_unlimited: "false" },
        trial_end: null,
      },
    }),
    store.deps,
  );

  assert.equal(seen, "sub_obj_form");
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed is a no-op when the invoice has no subscription reference", async () => {
  // One-off invoices (e.g. a manually-created invoice for a setup fee)
  // have no linked subscription. The handler must skip gracefully — a
  // regression that called `subscriptions.retrieve(undefined)` would
  // throw and trip the outer 500 path, forcing infinite Stripe retries.
  const store = makeFakeStore();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { parent: null } },
    } as unknown as Stripe.Event,
    fakeStripe({ onRetrieve: () => (retrieveCalled = true) }),
    store.deps,
  );

  assert.equal(retrieveCalled, false);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: unknown event types are silently ignored", async () => {
  // Stripe sends *many* event types we do not subscribe to (charges,
  // payment_intents, customer.created, etc.). They must hit the default
  // branch and no-op. Otherwise any new Stripe webhook starts crashing
  // our handler.
  const store = makeFakeStore();
  let retrieveCalled = false;
  await processStripeEvent(
    {
      type: "customer.created",
      data: { object: { id: "cus_xyz" } },
    } as unknown as Stripe.Event,
    fakeStripe({ onRetrieve: () => (retrieveCalled = true) }),
    store.deps,
  );

  assert.equal(retrieveCalled, false);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: applySubscription serialises trial_end (unix seconds) to ISO timestamp", async () => {
  // The store column is `trial_ends_at TIMESTAMPTZ` and expects an ISO
  // string. Stripe ships `trial_end` as a unix-seconds integer. A
  // regression that forgot the *1000 multiplier would write a 1970 date
  // and the trial-sweep job would immediately mark every trial expired.
  const store = makeFakeStore();
  const trialEndUnix = 1735689600; // 2025-01-01T00:00:00Z
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          status: "trialing",
          metadata: { agency_id: "22", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: trialEndUnix,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "trialing",
        metadata: { agency_id: "22", plan_tier: "pro", logs_unlimited: "true" },
        trial_end: trialEndUnix,
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(
    store.updateCalls[0]?.patch.trialEndsAt,
    new Date(trialEndUnix * 1000).toISOString(),
  );
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "trialing");
  // `trialing` must clear the disabled flag.
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
});

test("processStripeEvent: applySubscription defaults plan_tier to 'basic' when metadata is missing", async () => {
  // The metadata.plan_tier key is set by the platform on checkout. Stripe
  // ships back whatever was sent — but a hand-edited subscription in the
  // Stripe dashboard can have it missing/malformed. The mapping rule is
  // "anything not exactly 'pro' is basic" — pin that contract so a
  // regression doesn't start defaulting to pro and silently grant Pro
  // features.
  const store = makeFakeStore();
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_no_tier",
          status: "active",
          metadata: { agency_id: "23" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "active",
        metadata: { agency_id: "23" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls[0]?.patch.planTier, "basic");
  // logs_unlimited absent → false → 3 day retention (paywall the long history).
  assert.equal(store.updateCalls[0]?.patch.logsUnlimited, false);
  assert.equal(store.updateCalls[0]?.patch.transmissionRetentionDays, 3);
});

// ---------------------------------------------------------------------------
// Regression guards for stale-webhook / owner-disable fixes (PRs #287–#291)
// ---------------------------------------------------------------------------

test("processStripeEvent: subscription.updated reconciles against live Stripe status", async () => {
  const store = makeFakeStore();
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      expectedSubId: "sub_123",
      sub: {
        status: "past_due",
        metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.agencyId, 42);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: ignores stale checkout completion for a superseded subscription id", async () => {
  const store = makeFakeStore({
    agency: { id: 42, stripe_subscription_id: "sub_new" },
  });
  let retrieveCalls = 0;
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "42" },
          subscription: "sub_old",
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({ onRetrieve: () => (retrieveCalls += 1) }),
    store.deps,
  );

  assert.equal(retrieveCalls, 0);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: subscription updates preserve owner-disabled agencies", async () => {
  const store = makeFakeStore({
    agency: { id: 42, disabled: true, subscription_status: "active" },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_owner_locked",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "active",
        metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "false" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: active recovery clears billing-driven suspension", async () => {
  const store = makeFakeStore({
    agency: { id: 7, disabled: true, subscription_status: "past_due" },
  });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_recovered",
          status: "active",
          metadata: { agency_id: "7", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe({
      sub: {
        status: "active",
        metadata: { agency_id: "7", plan_tier: "basic", logs_unlimited: "false" },
      },
    }),
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
});
