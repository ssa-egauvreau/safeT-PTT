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

/**
 * Build a minimally-shaped fake Stripe client + a recording store that
 * captures every billing patch the handler issues. Returning the captured
 * patches lets each test assert exactly the writes the handler performed
 * without depending on the real Stripe SDK or PostgreSQL.
 */
type StripeFake = {
  subscriptions: {
    retrieve(subscriptionId: string): Promise<Stripe.Subscription>;
  };
  retrieveCalls: string[];
};

function makeFakeStripe(
  build: (subscriptionId: string) => Partial<Stripe.Subscription>,
): StripeFake {
  const calls: string[] = [];
  return {
    retrieveCalls: calls,
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        calls.push(subscriptionId);
        return {
          id: subscriptionId,
          ...build(subscriptionId),
        } as Stripe.Subscription;
      },
    },
  };
}

type UpdateCall = { agencyId: number; patch: Record<string, unknown> };

function makeStore(opts: {
  agency?: { id: number; subscription_status: string } | null;
} = {}) {
  const updateCalls: UpdateCall[] = [];
  return {
    updateCalls,
    deps: {
      async updateAgencyBilling(agencyId: number, patch: Record<string, unknown>) {
        updateCalls.push({ agencyId, patch });
        return null;
      },
      async getAgencyById() {
        // The test only needs the subscription_status column; cast keeps
        // the production AgencyRow shape from leaking into the fixture.
        return (opts.agency ?? null) as unknown as ReturnType<
          typeof import("../../src/store.js").getAgencyById
        > extends Promise<infer T>
          ? T
          : never;
      },
    },
  };
}

test("processStripeEvent: checkout completion never force-enables a past-due subscription", async () => {
  // Original regression test for PR #280 — kept verbatim to lock in the
  // "stale checkout webhook must not un-suspend" contract.
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

test("processStripeEvent: checkout completion on an active subscription mirrors Stripe state (enables agency)", async () => {
  // Counterpart to the past_due test above: if Stripe says the
  // subscription is active, the agency must end up enabled. A regression
  // that always set `disabled: true` after the fix would silently keep
  // newly-paid agencies locked out.
  const stripe = makeFakeStripe(() => ({
    status: "active",
    metadata: { agency_id: "7", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: null,
  }));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "7" }, subscription: "sub_active" } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(stripe.retrieveCalls.length, 1, "must fetch the latest subscription state from Stripe");
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.agencyId, 7);
  assert.equal(store.updateCalls[0]?.patch.disabled, false);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(store.updateCalls[0]?.patch.planTier, "pro");
  assert.equal(store.updateCalls[0]?.patch.logsUnlimited, true);
  assert.equal(
    store.updateCalls[0]?.patch.transmissionRetentionDays,
    null,
    "logs_unlimited subscriptions must clear the retention cap",
  );
});

test("processStripeEvent: checkout completion with no agency_id in session metadata is a no-op (no Stripe call, no write)", async () => {
  // The handler reads the agency id off the *session*, not the
  // subscription, before deciding to call Stripe. If the guard ever
  // regressed to "always fetch", we'd hammer Stripe with one request
  // per non-platform checkout event the account receives (Stripe
  // delivers all checkout completions on the account, including
  // unrelated products). The retrieveCalls assertion pins that.
  const stripe = makeFakeStripe(() => ({}));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: {}, subscription: "sub_orphan" } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(stripe.retrieveCalls.length, 0);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: checkout completion without a string subscription id is a no-op", async () => {
  // Stripe Checkout sessions can complete without a subscription (e.g.
  // one-time payment mode). The handler must skip those cleanly — the
  // previous code path issued `disabled: false` for any session
  // matching the agency id, which would have un-suspended an agency
  // off a non-subscription purchase. We also test the embedded-object
  // shape Stripe sometimes returns when `expand` is set.
  const stripe = makeFakeStripe(() => ({}));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "9" }, subscription: null } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "9" }, subscription: { id: "sub_x" } } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(stripe.retrieveCalls.length, 0);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: customer.subscription.updated on a comped agency does NOT flip the disabled bit", async () => {
  // The comped state is set manually by the platform owner (e.g.
  // partner agency, demo account). Stripe still sends subscription
  // updates for whatever sub is attached, but the handler must skip
  // the second `updateAgencyBilling` call that adjusts `disabled` —
  // otherwise a stale Stripe state would override the owner's choice
  // and lock the comped agency out.
  const store = makeStore({
    agency: { id: 5, subscription_status: "comped" },
  });
  const stripe = makeFakeStripe(() => ({}));

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comp",
          status: "canceled",
          metadata: { agency_id: "5", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  // applySubscription still writes the bookkeeping fields (status,
  // plan tier, etc.) once, but the comped guard MUST suppress the
  // follow-up disabled write.
  assert.equal(store.updateCalls.length, 1, "comped agencies receive exactly one bookkeeping write");
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "canceled");
  // The applySubscription call still sets `disabled: !active` based on
  // the Stripe state — the regression we're guarding against is the
  // SECOND, follow-up write that would have set disabled true again.
  assert.ok(
    !store.updateCalls.slice(1).some((call) => "disabled" in call.patch),
    "no follow-up disabled flip on comped agencies",
  );
});

test("processStripeEvent: customer.subscription.updated on a normal agency writes the disabled bit a second time", async () => {
  // Non-comped agencies get TWO writes: one from applySubscription
  // (the bookkeeping fields) and one from the dedicated `disabled`
  // patch the handler issues right after. The second write is the
  // historical contract — keeping it pinned prevents a refactor from
  // accidentally relying on the applySubscription disabled value
  // alone, which would skip the post-comped-guard re-check.
  const store = makeStore({
    agency: { id: 11, subscription_status: "active" },
  });
  const stripe = makeFakeStripe(() => ({}));

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_normal",
          status: "canceled",
          metadata: { agency_id: "11", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(store.updateCalls.length, 2);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
  // The second write is the explicit re-affirmation of disabled
  // status — a regression that dropped it would let a future
  // bookkeeping refactor silently re-enable canceled accounts.
  assert.deepEqual(store.updateCalls[1]?.patch, { disabled: true });
});

test("processStripeEvent: customer.subscription.deleted routes through the same delete handler and disables the agency", async () => {
  // The handler aliases `deleted` to `updated`; if a refactor split
  // them, the delete branch could quietly stop disabling the agency.
  const store = makeStore({
    agency: { id: 13, subscription_status: "active" },
  });
  const stripe = makeFakeStripe(() => ({}));

  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_gone",
          status: "canceled",
          metadata: { agency_id: "13", plan_tier: "pro", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(store.updateCalls.length, 2);
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
  assert.equal(store.updateCalls[1]?.patch.disabled, true);
});

test("processStripeEvent: customer.subscription.updated with no matching agency in the store skips the disabled re-check", async () => {
  // If `getAgencyById` returns null (race: webhook arrived for an
  // agency that was already deleted), the handler must NOT issue the
  // second `disabled` write. Otherwise it would create a phantom row
  // or, in the SQL path, fail mid-webhook and force Stripe to retry
  // forever.
  const store = makeStore({ agency: null });
  const stripe = makeFakeStripe(() => ({}));

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_ghost",
          status: "active",
          metadata: { agency_id: "99", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  // Only the bookkeeping write from applySubscription — no follow-up
  // disabled patch because the agency lookup returned null.
  assert.equal(store.updateCalls.length, 1);
});

test("processStripeEvent: invoice.payment_failed fetches the subscription and lets applySubscription disable the agency", async () => {
  // The handler reads the subscription id off invoice.parent and
  // re-fetches from Stripe (rather than trusting the invoice payload)
  // because the invoice doesn't carry the full subscription state.
  // A regression that read invoice.subscription directly or skipped
  // the fetch would miss the disabled flip.
  const stripe = makeFakeStripe((subId) => ({
    id: subId,
    status: "past_due",
    metadata: { agency_id: "21", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: null,
  }));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_failed" } },
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.deepEqual(stripe.retrieveCalls, ["sub_failed"]);
  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(store.updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed accepts an embedded subscription object (not just an id string)", async () => {
  // The Stripe SDK types declare `subscription_details.subscription`
  // as either a string or an embedded Stripe.Subscription. Both
  // shapes must yield the same retrieve-and-apply behaviour.
  const stripe = makeFakeStripe((subId) => ({
    id: subId,
    status: "past_due",
    metadata: { agency_id: "21", plan_tier: "pro" },
    trial_end: null,
  }));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: {
            subscription_details: { subscription: { id: "sub_embedded" } },
          },
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.deepEqual(stripe.retrieveCalls, ["sub_embedded"]);
  assert.equal(store.updateCalls.length, 1);
});

test("processStripeEvent: invoice.payment_failed without a subscription reference is a no-op", async () => {
  // Some Stripe invoices have no subscription parent at all (e.g. an
  // ad-hoc invoice). The handler must skip those rather than crash
  // and trigger a Stripe retry storm.
  const stripe = makeFakeStripe(() => ({}));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { parent: null } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { parent: { subscription_details: {} } } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(stripe.retrieveCalls.length, 0);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: unknown / unhandled event types are silently ignored (no Stripe call, no write)", async () => {
  // Stripe sends ~hundreds of event types; the handler must not crash
  // or write on the long tail (e.g. customer.created, charge.refunded).
  // A regression that fell through to applySubscription on an
  // unrecognised event would attempt to read .metadata off the wrong
  // shape and throw — which Stripe then retries indefinitely.
  const stripe = makeFakeStripe(() => ({}));
  const store = makeStore();

  for (const type of [
    "customer.created",
    "charge.succeeded",
    "invoice.paid",
    "checkout.session.expired",
  ] as const) {
    await processStripeEvent(
      { type, data: { object: {} } } as unknown as Stripe.Event,
      stripe,
      store.deps,
    );
  }

  assert.equal(stripe.retrieveCalls.length, 0);
  assert.equal(store.updateCalls.length, 0);
});

test("processStripeEvent: applySubscription populates trialEndsAt as an ISO string when Stripe sends trial_end", async () => {
  // The trial-end timestamp is consumed by the admin UI banner and
  // the trial sweep — it must be an ISO string in the DB row, not a
  // raw epoch number. A regression that wrote the epoch directly
  // would make the sweep parse "1735689600" as ms-since-epoch (year
  // 56,983) and silently never expire trials.
  const trialEpoch = 1_735_689_600; // 2025-01-01T00:00:00Z
  const stripe = makeFakeStripe(() => ({
    status: "trialing",
    metadata: { agency_id: "3", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: trialEpoch,
  }));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "3" }, subscription: "sub_trial" } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  assert.equal(store.updateCalls[0]?.patch.subscriptionStatus, "trialing");
  assert.equal(store.updateCalls[0]?.patch.disabled, false, "trialing must enable the agency");
  assert.equal(
    store.updateCalls[0]?.patch.trialEndsAt,
    new Date(trialEpoch * 1000).toISOString(),
  );
});

test("processStripeEvent: applySubscription defaults plan_tier to basic and enforces the 3-day retention cap when logs_unlimited is not 'true'", async () => {
  // Stripe metadata is loosely typed strings. The handler treats
  // anything other than the exact literal "pro" as basic, and
  // anything other than "true" as `logs_unlimited: false`. Pinning
  // these defaults guards against a refactor that, for example,
  // started honouring `plan_tier: "PRO"` (case difference) and
  // silently upgraded customers, or stopped applying the retention
  // cap when metadata is absent.
  const stripe = makeFakeStripe(() => ({
    status: "active",
    // Note: NO plan_tier or logs_unlimited keys in metadata.
    metadata: { agency_id: "4" },
    trial_end: null,
  }));
  const store = makeStore();

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: { agency_id: "4" }, subscription: "sub_default" } },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(store.updateCalls.length, 1);
  const patch = store.updateCalls[0]?.patch ?? {};
  assert.equal(patch.planTier, "basic");
  assert.equal(patch.logsUnlimited, false);
  assert.equal(patch.transmissionRetentionDays, 3, "basic/non-unlimited tiers cap retention at 3 days");
  assert.equal(patch.trialEndsAt, null);
  // The Stripe subscription id must round-trip through the patch so
  // a renewed/reactivated subscription replaces the previous id in
  // the agencies row.
  assert.equal(patch.stripeSubscriptionId, "sub_default");
});

test("processStripeEvent: applySubscription skips writes when the subscription metadata has no agency_id", async () => {
  // Belt-and-suspenders for the subscription.updated path: if Stripe
  // sends a subscription update whose metadata lost the agency_id
  // (e.g. an admin manually edited it in the Stripe dashboard), the
  // handler must not blindly write to agency 0 or throw.
  const stripe = makeFakeStripe(() => ({}));
  const store = makeStore({ agency: { id: 1, subscription_status: "active" } });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_no_meta",
          status: "active",
          metadata: {},
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    stripe,
    store.deps,
  );

  assert.equal(store.updateCalls.length, 0);
});
