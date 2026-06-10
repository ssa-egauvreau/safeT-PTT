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
// processStripeEvent: customer.subscription.updated / deleted
//
// These two events are the single most frequent Stripe webhook in production
// (every renewal, plan change, payment failure, and cancellation fires one).
// The handler does TWO writes:
//  1. `applySubscription` — full state sync (status, plan_tier, logs_unlimited,
//     transmissionRetentionDays, trial_end ISO, disabled flag).
//  2. A second pass that re-asserts `disabled` only — and only when the
//     agency's local status is NOT "comped". That comped-guard is the entire
//     manual override system the platform owner uses to keep a flaky
//     customer or partner agency online; a regression that bypassed it would
//     auto-disable comped agencies the next time Stripe fires any
//     subscription event.
// ---------------------------------------------------------------------------

type FakeStore = {
  updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }>;
  agencyLookup: Record<number, { subscription_status: string } | null>;
};

function fakeDeps(
  agencyLookup: Record<number, { subscription_status: string } | null> = {},
): FakeStore & {
  updateAgencyBilling: (
    agencyId: number,
    patch: Record<string, unknown>,
  ) => Promise<null>;
  getAgencyById: (id: number) => Promise<unknown>;
} {
  const state: FakeStore = { updateCalls: [], agencyLookup };
  return {
    ...state,
    async updateAgencyBilling(agencyId: number, patch: Record<string, unknown>) {
      state.updateCalls.push({ agencyId, patch });
      return null;
    },
    async getAgencyById(id: number) {
      return state.agencyLookup[id] ?? null;
    },
  };
}

const stripeNeverRetrieves = {
  subscriptions: {
    async retrieve(): Promise<Stripe.Subscription> {
      throw new Error("subscriptions.retrieve must NOT be called for this event type");
    },
  },
};

test("processStripeEvent: customer.subscription.updated writes plan tier + logs_unlimited + nulls retention", async () => {
  // The webhook is the only place where logs_unlimited and the matching
  // transmission_retention_days nullification get applied for an existing
  // subscription. If applySubscription drifts (e.g. forgets to null
  // `transmissionRetentionDays` when logs_unlimited is true), the agency
  // would keep the 3-day cap even though they're paying for unlimited.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_777",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );

  // First call from applySubscription, second call from the disabled re-assert.
  assert.equal(deps.updateCalls.length, 2);
  const first = deps.updateCalls[0]!.patch;
  assert.equal(deps.updateCalls[0]!.agencyId, 42);
  assert.equal(first.stripeSubscriptionId, "sub_777");
  assert.equal(first.subscriptionStatus, "active");
  assert.equal(first.planTier, "pro");
  assert.equal(first.logsUnlimited, true);
  assert.equal(first.transmissionRetentionDays, null);
  assert.equal(first.disabled, false);
  assert.equal(first.trialEndsAt, null);

  // The second write must specifically RE-ENABLE the agency for an
  // active sub (defends against a stale `disabled: true` left over from
  // a prior past_due event).
  assert.equal(deps.updateCalls[1]!.patch.disabled, false);
});

test("processStripeEvent: subscription.updated with logs_unlimited=false sets transmissionRetentionDays back to 3", async () => {
  // Mirror image of the test above — when a customer downgrades off
  // unlimited logs, the 3-day cap must be re-applied. Without this the
  // basic tenant would silently keep unlimited retention.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_basic",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );

  const first = deps.updateCalls[0]!.patch;
  assert.equal(first.planTier, "basic");
  assert.equal(first.logsUnlimited, false);
  assert.equal(first.transmissionRetentionDays, 3);
});

test("processStripeEvent: subscription.updated converts Stripe trial_end (unix seconds) to ISO timestamp", async () => {
  // Stripe sends `trial_end` as UNIX seconds (not millis, not ISO). Our
  // schema stores ISO strings. A regression that wrote the unix number
  // verbatim would break every render of `trial_days_left` in the admin
  // billing panel.
  const deps = fakeDeps({ 42: { subscription_status: "trialing" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          status: "trialing",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: 1_700_000_000,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );

  assert.equal(
    deps.updateCalls[0]!.patch.trialEndsAt,
    new Date(1_700_000_000 * 1000).toISOString(),
  );
});

test("processStripeEvent: unknown plan_tier metadata falls back to 'basic' (never silently upgrades to pro)", async () => {
  // applySubscription explicitly checks `=== "pro"` — anything else
  // (typos, future tiers, missing field) must land on basic so a
  // misconfigured Stripe price can't accidentally unlock AI dispatch.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_x",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "enterprise", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );
  assert.equal(deps.updateCalls[0]!.patch.planTier, "basic");
});

test("processStripeEvent: missing plan_tier metadata defaults to 'basic'", async () => {
  // Defence in depth: a Stripe subscription with no plan_tier metadata
  // (older sub created before we started writing it) must still be
  // applied — just on the safe (cheaper) tier.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_legacy",
          status: "active",
          metadata: { agency_id: "42" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );
  assert.equal(deps.updateCalls[0]!.patch.planTier, "basic");
  // No logs_unlimited metadata → must read as false (NOT undefined).
  assert.equal(deps.updateCalls[0]!.patch.logsUnlimited, false);
});

test("processStripeEvent: subscription.updated with no agency_id metadata is ignored (no DB writes)", async () => {
  // applySubscription bails BEFORE writing if agency_id is missing — so
  // does the second-pass disabled re-assert. Critical: a malformed
  // event must NOT fall through to `updateAgencyBilling(null, ...)`.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_orphan",
          status: "active",
          metadata: {},
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );
  assert.equal(deps.updateCalls.length, 0);
});

test("processStripeEvent: customer.subscription.deleted disables the agency", async () => {
  // The cancellation event collapses to `subscriptionStatus: "canceled"`
  // and `disabled: true` — the agency loses AI dispatch and new-tx
  // ingestion immediately. Regression risk: deleted subs with status
  // !== "canceled" (Stripe quirk on some test fixtures) must still
  // disable, because `isStripeSubscriptionActive` is false for both.
  const deps = fakeDeps({ 42: { subscription_status: "active" } });
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_dead",
          status: "canceled",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );
  // applySubscription + the second-pass disabled re-assert.
  assert.equal(deps.updateCalls.length, 2);
  assert.equal(deps.updateCalls[0]!.patch.subscriptionStatus, "canceled");
  assert.equal(deps.updateCalls[0]!.patch.disabled, true);
  assert.equal(deps.updateCalls[1]!.patch.disabled, true);
});

test("processStripeEvent: COMPED agency is never re-disabled by a Stripe subscription event", async () => {
  // The comped-guard is the safety net for the platform owner's
  // manual "keep this customer on free service" override. A regression
  // here would let Stripe's automated webhooks override a manual
  // comp. applySubscription still runs (it syncs plan_tier etc.)
  // but the SECOND write (the disabled re-assert) must be skipped.
  const deps = fakeDeps({ 42: { subscription_status: "comped" } });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comped",
          status: "past_due",
          metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );

  // applySubscription wrote disabled=true (because Stripe says past_due),
  // BUT the second-pass disabled re-assert must NOT run for a comped agency.
  assert.equal(deps.updateCalls.length, 1, "only applySubscription should write; the comped guard blocks the second pass");
  assert.equal(deps.updateCalls[0]!.patch.subscriptionStatus, "past_due");
});

test("processStripeEvent: subscription.updated for unknown agency (DB lookup returns null) skips the second-pass disabled write", async () => {
  // If `getAgencyById` returns null (deleted/migrated agency), the
  // second-pass `updateAgencyBilling({ disabled })` must be skipped —
  // calling it would create a no-op UPDATE that errors out and
  // surfaces as a 500 from the webhook handler, forcing Stripe to retry.
  const deps = fakeDeps({}); // no agency 42 in lookup
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_gone",
          status: "active",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripeNeverRetrieves,
    deps,
  );
  // Only the applySubscription write; no second-pass disabled re-assert.
  assert.equal(deps.updateCalls.length, 1);
});

// ---------------------------------------------------------------------------
// processStripeEvent: invoice.payment_failed
//
// Stripe fires this when a recurring charge fails (expired card, etc.). The
// handler resolves the subscription id from the (sometimes object, sometimes
// string) `invoice.parent.subscription_details.subscription` shape, refetches
// the subscription, and applies it. The whole point is that a payment failure
// flips `disabled: true` so the agency is paywalled until the next successful
// renewal updates it back.
// ---------------------------------------------------------------------------

test("processStripeEvent: invoice.payment_failed (string subscription ref) refetches + applies", async () => {
  let retrieveCalledWith = "";
  const fakeStripe = {
    subscriptions: {
      async retrieve(id: string): Promise<Stripe.Subscription> {
        retrieveCalledWith = id;
        return {
          id,
          status: "past_due",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };
  const deps = fakeDeps();
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_1",
          parent: {
            subscription_details: { subscription: "sub_pay_fail" },
          },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    deps,
  );
  assert.equal(retrieveCalledWith, "sub_pay_fail");
  assert.equal(deps.updateCalls.length, 1);
  assert.equal(deps.updateCalls[0]!.patch.subscriptionStatus, "past_due");
  assert.equal(deps.updateCalls[0]!.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed (object subscription ref) extracts .id", async () => {
  // Older Stripe API versions / some fixtures hand back a full
  // Subscription OBJECT instead of an id string for
  // `invoice.parent.subscription_details.subscription`. The handler
  // explicitly tolerates both shapes — pin that contract.
  let retrieveCalledWith = "";
  const fakeStripe = {
    subscriptions: {
      async retrieve(id: string): Promise<Stripe.Subscription> {
        retrieveCalledWith = id;
        return {
          id,
          status: "past_due",
          metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };
  const deps = fakeDeps();
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_2",
          parent: {
            subscription_details: { subscription: { id: "sub_obj_form" } },
          },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    deps,
  );
  assert.equal(retrieveCalledWith, "sub_obj_form");
  assert.equal(deps.updateCalls.length, 1);
});

test("processStripeEvent: invoice.payment_failed with no subscription ref is a no-op", async () => {
  // One-off invoice (no recurring subscription) — the handler must
  // NOT try to refetch a missing subscription. Pin the early return.
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("must not refetch when there is no subscription ref");
      },
    },
  };
  const deps = fakeDeps();
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { id: "in_3", parent: undefined } },
    } as unknown as Stripe.Event,
    fakeStripe,
    deps,
  );
  assert.equal(deps.updateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// processStripeEvent: unknown event types
//
// Stripe fires dozens of event types we don't subscribe to (charge.refunded,
// customer.updated, etc.). The default case must silently no-op — a regression
// that threw or wrote anything would cause Stripe to retry indefinitely and
// could corrupt billing state on unrelated events.
// ---------------------------------------------------------------------------

test("processStripeEvent: unknown event types are silently ignored", async () => {
  const deps = fakeDeps();
  for (const type of [
    "charge.refunded",
    "customer.updated",
    "customer.subscription.created",
    "invoice.paid",
    "ping",
  ]) {
    await processStripeEvent(
      { type, data: { object: {} } } as unknown as Stripe.Event,
      stripeNeverRetrieves,
      deps,
    );
  }
  assert.equal(deps.updateCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed with non-string subscription (already expanded) is a no-op", async () => {
  // The checkout branch only fetches when `session.subscription` is a
  // string. If Stripe ever sends back an already-expanded Subscription
  // object on the session, the handler must NOT crash trying to call
  // `subscriptions.retrieve(obj)` — it just skips, and the followup
  // `customer.subscription.created/updated` event handles it.
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("retrieve must not be called when subscription is an object");
      },
    },
  };
  const deps = fakeDeps();
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "42" },
          subscription: { id: "sub_already_expanded" },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    deps,
  );
  assert.equal(deps.updateCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed with no agency_id in session metadata skips refetch", async () => {
  // Pin the early return — without an agency_id we cannot route the
  // update, so refetching Stripe would burn an API call for nothing.
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("retrieve must not be called when agency_id is missing");
      },
    },
  };
  const deps = fakeDeps();
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: { metadata: {}, subscription: "sub_orphan_session" },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    deps,
  );
  assert.equal(deps.updateCalls.length, 0);
});
