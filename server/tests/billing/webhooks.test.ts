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
// processStripeEvent — branch coverage for the remaining event types.
//
// The handler routes four Stripe event families (checkout.session.completed,
// customer.subscription.updated/deleted, invoice.payment_failed) plus an
// implicit default branch for everything else. The existing test pins one
// specific regression on `checkout.session.completed`; the tests below pin
// each remaining branch because:
//
//   - `customer.subscription.updated` is the path Stripe uses for upgrades,
//     downgrades, trial conversions, and payment recoveries — i.e. it is
//     the single most frequent webhook in production. A regression on the
//     comped carve-out (348e779) would have a paying customer's upgrade
//     event silently flip a "comp" agency back into automatic enforcement.
//   - `customer.subscription.deleted` is the cancel/churn path. A bug
//     that skipped `applySubscription` would leave the agency reading as
//     `active` after Stripe terminated the subscription — paid features
//     still unlocked, no further invoices.
//   - `invoice.payment_failed` is the only path the platform reads to
//     learn about a recurring-charge failure. A regression that ignored
//     the event would let a delinquent customer keep AI dispatch running
//     until the next subscription.updated arrives (Stripe's retry cadence
//     is days, not minutes).
//   - The default branch must be a clean no-op — Stripe ships new event
//     types regularly, and an unmatched event must NOT crash the handler
//     (which would 500 and trigger Stripe's retry storm).
// ---------------------------------------------------------------------------

interface UpdateCall {
  agencyId: number;
  patch: Record<string, unknown>;
}

function makeDeps(getAgencyResult: unknown = null): {
  updateCalls: UpdateCall[];
  getAgencyCalls: number[];
  deps: {
    updateAgencyBilling: (agencyId: number, patch: unknown) => Promise<null>;
    getAgencyById: (agencyId: number) => Promise<unknown>;
  };
} {
  const updateCalls: UpdateCall[] = [];
  const getAgencyCalls: number[] = [];
  return {
    updateCalls,
    getAgencyCalls,
    deps: {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById(agencyId) {
        getAgencyCalls.push(agencyId);
        return getAgencyResult as never;
      },
    },
  };
}

function subscriptionEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  overrides: Partial<Stripe.Subscription> & { metadata: Stripe.Metadata },
): Stripe.Event {
  return {
    type,
    data: {
      object: {
        id: overrides.id ?? "sub_default",
        status: overrides.status ?? "active",
        metadata: overrides.metadata,
        trial_end: overrides.trial_end ?? null,
      } as unknown as Stripe.Subscription,
    },
  } as unknown as Stripe.Event;
}

const noStripe = {
  subscriptions: {
    async retrieve(): Promise<Stripe.Subscription> {
      throw new Error("stripe.subscriptions.retrieve should not be called for this event type");
    },
  },
};

test("processStripeEvent: customer.subscription.updated → applySubscription then disabled:false for active", async () => {
  // The "happy path" upgrade webhook: agency exists, not comped, Stripe
  // says active. The handler should write the full subscription patch
  // first (so plan_tier / logs_unlimited / status are persisted), then
  // immediately write a second `disabled:false` patch as the final word
  // on enforcement state. Pin both writes so a refactor that drops the
  // second write doesn't silently leave a re-activated agency disabled.
  const { updateCalls, getAgencyCalls, deps } = makeDeps({
    id: 7,
    subscription_status: "active",
  });
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      id: "sub_active",
      status: "active",
      metadata: { agency_id: "7", plan_tier: "pro", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(getAgencyCalls, [7]);
  assert.equal(updateCalls[0]?.agencyId, 7);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "active");
  assert.equal(updateCalls[0]?.patch.planTier, "pro");
  assert.equal(updateCalls[0]?.patch.logsUnlimited, false);
  assert.equal(updateCalls[0]?.patch.transmissionRetentionDays, 3);
  assert.equal(updateCalls[0]?.patch.disabled, false);
  assert.deepEqual(updateCalls[1], { agencyId: 7, patch: { disabled: false } });
});

test("processStripeEvent: customer.subscription.updated → past_due also writes disabled:true twice (no force-enable)", async () => {
  // applySubscription writes `disabled: !active`, so for a past_due sub
  // the first patch already says disabled:true. The second write should
  // also say disabled:true — a regression that flipped it would override
  // the paywall on the same webhook that should be enabling it.
  const { updateCalls, deps } = makeDeps({
    id: 9,
    subscription_status: "active",
  });
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      id: "sub_past",
      status: "past_due",
      metadata: { agency_id: "9", plan_tier: "basic", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0]?.patch.disabled, true);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.deepEqual(updateCalls[1], { agencyId: 9, patch: { disabled: true } });
});

test("processStripeEvent: customer.subscription.updated → COMPED agency is NEVER toggled by Stripe (348e779 fix)", async () => {
  // The carve-out: an agency that the platform owner manually moved to
  // `comped` from the owner portal must NOT have its `disabled` flag
  // touched by Stripe webhooks. Otherwise a stale subscription.updated
  // event (canceled subscription, comped post-cancel) would silently
  // re-disable an account the owner explicitly comped.
  //
  // The handler still runs applySubscription (so plan_tier/etc stay in
  // sync), but the second `disabled` write must be skipped entirely.
  const { updateCalls, getAgencyCalls, deps } = makeDeps({
    id: 13,
    subscription_status: "comped",
  });
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      id: "sub_comped",
      // A canceled Stripe sub on a comped agency: the worst case for
      // the regression — applySubscription writes disabled:true once,
      // and if we *also* wrote a second disabled patch, the comp would
      // be undone every time Stripe sent any subscription event.
      status: "canceled",
      metadata: { agency_id: "13", plan_tier: "pro", logs_unlimited: "true" },
    }),
    noStripe,
    deps,
  );
  // Only the applySubscription write — the second `disabled` patch was
  // skipped because the agency reads as comped.
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(getAgencyCalls, [13]);
  assert.equal(updateCalls[0]?.agencyId, 13);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "canceled");
});

test("processStripeEvent: customer.subscription.updated → agency lookup returns null skips the second write", async () => {
  // If the metadata points at an agency_id that no longer exists in our
  // DB (deleted tenant, dev DB out of sync with Stripe), the handler
  // must NOT issue a second `disabled` write — that would either error
  // or silently write to no rows depending on the SQL semantics. Pin
  // the early-return so a refactor that started ignoring `agency` being
  // null doesn't introduce a phantom write.
  const { updateCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { agency_id: "555", plan_tier: "pro", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  // applySubscription still runs (it doesn't consult getAgencyById).
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.agencyId, 555);
});

test("processStripeEvent: customer.subscription.deleted runs the same comped carve-out as updated", async () => {
  // The deleted event is grouped with updated in a single switch case,
  // so the same carve-out applies. Pin it explicitly so a refactor that
  // split the cases preserves the protection.
  const { updateCalls, deps } = makeDeps({
    id: 21,
    subscription_status: "comped",
  });
  await processStripeEvent(
    subscriptionEvent("customer.subscription.deleted", {
      id: "sub_gone",
      status: "canceled",
      metadata: { agency_id: "21", plan_tier: "basic", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "canceled");
});

test("processStripeEvent: customer.subscription.deleted on a non-comped agency writes disabled:true", async () => {
  // The cancel/churn path for a paying agency. After this event the
  // agency must read as disabled — that is the only thing that takes
  // their handsets offline and stops new transmissions.
  const { updateCalls, deps } = makeDeps({
    id: 32,
    subscription_status: "active",
  });
  await processStripeEvent(
    subscriptionEvent("customer.subscription.deleted", {
      id: "sub_cancel",
      status: "canceled",
      metadata: { agency_id: "32", plan_tier: "pro", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0]?.patch.disabled, true);
  assert.deepEqual(updateCalls[1], { agencyId: 32, patch: { disabled: true } });
});

test("processStripeEvent: invoice.payment_failed retrieves subscription by string ref and applies it", async () => {
  // The invoice payload nests the subscription id under
  // `invoice.parent.subscription_details.subscription` — either as a
  // string id or as an expanded object. The handler must extract it,
  // call Stripe to re-read the canonical subscription state, then run
  // applySubscription so the agency row reflects past_due.
  const { updateCalls, deps } = makeDeps(null);
  const stripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        assert.equal(subscriptionId, "sub_invoice_str");
        return {
          id: "sub_invoice_str",
          status: "past_due",
          metadata: { agency_id: "44", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_invoice_str" } },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event,
    stripe,
    deps,
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.agencyId, 44);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed extracts subscription id from an expanded object ref", async () => {
  // When the caller expands `subscription_details.subscription`, Stripe
  // returns the full Subscription object. The handler still has to read
  // `subRef.id` and re-retrieve — pin that branch so a refactor that
  // dropped the object case (and only handled strings) is caught.
  const { updateCalls, deps } = makeDeps(null);
  let retrievedId: string | null = null;
  const stripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        retrievedId = subscriptionId;
        return {
          id: subscriptionId,
          status: "past_due",
          metadata: { agency_id: "44", plan_tier: "basic" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: {
            subscription_details: {
              subscription: { id: "sub_invoice_obj" } as unknown as Stripe.Subscription,
            },
          },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event,
    stripe,
    deps,
  );
  assert.equal(retrievedId, "sub_invoice_obj");
  assert.equal(updateCalls.length, 1);
});

test("processStripeEvent: invoice.payment_failed without subscription ref is a clean no-op", async () => {
  // Some Stripe invoices (one-off invoices, draft invoices) don't have
  // a subscription. The handler must NOT throw and must NOT hit Stripe.
  // A regression that called retrieve(undefined) would surface as a 500
  // and have Stripe retry the event.
  const { updateCalls, deps } = makeDeps(null);
  let retrieveCalled = false;
  const stripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalled = true;
        return {} as Stripe.Subscription;
      },
    },
  };
  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: { parent: null } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event,
    stripe,
    deps,
  );
  assert.equal(retrieveCalled, false);
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: unknown event type is a clean no-op (no DB writes, no Stripe calls)", async () => {
  // Stripe ships new event types frequently (e.g. `tax.*`,
  // `radar.early_fraud_warning.created`). The default branch must NOT
  // throw — that would 500 the webhook and have Stripe retry the new
  // event type forever.
  const { updateCalls, getAgencyCalls, deps } = makeDeps(null);
  await processStripeEvent(
    {
      type: "ping" as unknown as Stripe.Event["type"],
      data: { object: {} as unknown as Stripe.Subscription },
    } as unknown as Stripe.Event,
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 0);
  assert.equal(getAgencyCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed without agency_id metadata is a no-op", async () => {
  // The session metadata is the only signal that ties this event to one
  // of our tenants. Without it, the handler must not call Stripe (could
  // refresh the wrong subscription) or write to any agency row.
  const { updateCalls, deps } = makeDeps(null);
  let retrieveCalled = false;
  const stripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalled = true;
        return {} as Stripe.Subscription;
      },
    },
  };
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: { metadata: {}, subscription: "sub_orphan" } as unknown as Stripe.Checkout.Session,
      },
    } as unknown as Stripe.Event,
    stripe,
    deps,
  );
  assert.equal(retrieveCalled, false);
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed without a string subscription is a no-op", async () => {
  // Stripe sometimes ships sessions with `subscription` as null (the
  // session expired before payment) or expanded into an object. The
  // current handler only acts on string-typed refs — pin that contract
  // so a refactor that started accepting null/object doesn't silently
  // write garbage to the agency row.
  const { updateCalls, deps } = makeDeps(null);
  let retrieveCalled = false;
  const stripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalled = true;
        return {} as Stripe.Subscription;
      },
    },
  };
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "99" },
          subscription: null,
        } as unknown as Stripe.Checkout.Session,
      },
    } as unknown as Stripe.Event,
    stripe,
    deps,
  );
  assert.equal(retrieveCalled, false);
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: applySubscription with trial_end converts Stripe's epoch seconds to an ISO string", async () => {
  // Stripe sends `trial_end` as unix seconds. The store schema expects
  // ISO timestamps, so the handler multiplies by 1000 before
  // `new Date(...).toISOString()`. A regression that forgot the *1000
  // would map e.g. 1_700_000_000 → 1970 and the trial-expiry sweep
  // would immediately suspend the tenant.
  const { updateCalls, deps } = makeDeps(null);
  const trialEndSeconds = 1_700_000_000;
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      id: "sub_trial",
      status: "trialing",
      trial_end: trialEndSeconds,
      metadata: { agency_id: "61", plan_tier: "basic", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  const applyPatch = updateCalls[0]?.patch;
  assert.equal(applyPatch?.trialEndsAt, new Date(trialEndSeconds * 1000).toISOString());
});

test("processStripeEvent: applySubscription with no trial_end writes trialEndsAt: null", async () => {
  // The paid-not-on-trial case. Pin that the field is explicitly
  // nulled — otherwise a previous trial date would linger after
  // conversion and the billing badge would mis-render.
  const { updateCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      trial_end: null,
      metadata: { agency_id: "62", plan_tier: "basic", logs_unlimited: "false" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls[0]?.patch.trialEndsAt, null);
});

test("processStripeEvent: applySubscription with logs_unlimited='true' sets transmission_retention_days to null (unlimited)", async () => {
  // The add-on price gates indefinite retention. A regression that
  // forced 3 days even with logs_unlimited would silently trim every
  // recording older than 3 days for a paying-for-unlimited customer.
  const { updateCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { agency_id: "70", plan_tier: "pro", logs_unlimited: "true" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls[0]?.patch.logsUnlimited, true);
  assert.equal(updateCalls[0]?.patch.transmissionRetentionDays, null);
});

test("processStripeEvent: applySubscription only treats the literal string 'true' as logs_unlimited", async () => {
  // The metadata is always string-typed in Stripe. The handler does a
  // strict `=== "true"` check; any other value (including "True", "1",
  // "yes") must be read as false. Pin this so a refactor that loosened
  // the check doesn't silently grant unlimited retention to every
  // tenant whose metadata holds a coerced truthy value.
  const { updateCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { agency_id: "71", plan_tier: "pro", logs_unlimited: "True" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls[0]?.patch.logsUnlimited, false);
  assert.equal(updateCalls[0]?.patch.transmissionRetentionDays, 3);
});

test("processStripeEvent: applySubscription defaults plan_tier to 'basic' for any non-'pro' value", async () => {
  // The only literal that maps to 'pro' is the string "pro". Anything
  // else (missing key, garbage value, future tier name) must conservatively
  // collapse to 'basic' — the cheaper, AI-dispatch-locked tier — so a
  // typo in metadata never silently grants pro features.
  const { updateCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { agency_id: "80", plan_tier: "enterprise" },
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls[0]?.patch.planTier, "basic");
});

test("processStripeEvent: applySubscription skips entirely when metadata has no agency_id", async () => {
  // A subscription that wasn't created via our checkout (e.g. Stripe
  // admin manually created one) lacks `agency_id`. The handler must
  // ignore it — writing with agencyId === null would either throw or
  // write to row id NaN. Pin the early-return so a refactor that
  // coerced null → 0 is caught.
  const { updateCalls, getAgencyCalls, deps } = makeDeps(null);
  await processStripeEvent(
    subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { plan_tier: "pro" } as Stripe.Metadata,
    }),
    noStripe,
    deps,
  );
  assert.equal(updateCalls.length, 0);
  // getAgencyById is also gated on agencyId being non-null, so it
  // must not be called either.
  assert.equal(getAgencyCalls.length, 0);
});
