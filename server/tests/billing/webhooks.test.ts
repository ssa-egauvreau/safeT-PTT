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
import type { AgencyRow } from "../../src/store.js";

// ---------------------------------------------------------------------------
// Shared helpers for processStripeEvent branch tests.
//
// Every test below mocks Stripe + the agency store with the same shape and
// records every `updateAgencyBilling` / `getAgencyById` call so we can pin
// the exact writes the webhook commits. The webhook is the only path that
// flips an agency between paid / past_due / disabled, so missing any branch
// here would let a forged-but-valid-signature webhook silently re-enable
// (or wrongly disable) a tenant.
// ---------------------------------------------------------------------------

interface RecordedCall {
  agencyId: number;
  patch: Record<string, unknown>;
}

interface Recorder {
  updates: RecordedCall[];
  getById: number[];
  retrieveCalls: string[];
}

function makeAgency(overrides: Partial<AgencyRow>): AgencyRow {
  return {
    id: 42,
    name: "Test Agency",
    slug: "test-agency",
    radio_key: "test-key",
    disabled: false,
    created_at: "2026-01-01T00:00:00.000Z",
    default_codec: "codec2_3200",
    stripe_customer_id: "cus_test_42",
    stripe_subscription_id: "sub_test_42",
    subscription_status: "active",
    plan_tier: "basic",
    trial_ends_at: null,
    transmission_retention_days: 3,
    logs_unlimited: false,
    billing_email: "billing@example.com",
    signup_completed_at: "2026-01-01T00:00:00.000Z",
    trial_email_used: true,
    ...overrides,
  };
}

function makeDeps(opts: { agency?: AgencyRow | null }) {
  const rec: Recorder = { updates: [], getById: [], retrieveCalls: [] };
  return {
    rec,
    deps: {
      async updateAgencyBilling(agencyId: number, patch: unknown) {
        rec.updates.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById(id: number) {
        rec.getById.push(id);
        return opts.agency ?? null;
      },
    },
  };
}

function makeStripe(sub: Partial<Stripe.Subscription> & { id: string }, rec?: Recorder) {
  return {
    subscriptions: {
      async retrieve(id: string): Promise<Stripe.Subscription> {
        rec?.retrieveCalls.push(id);
        return { ...sub, id } as unknown as Stripe.Subscription;
      },
    },
  };
}

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
// processStripeEvent: customer.subscription.updated / deleted branches
//
// The recent webhook fix (348e779) re-routed the active-state derivation
// through the shared `isStripeSubscriptionActive` helper AND pins a hard
// guard: when the persisted agency row says `subscription_status === 'comped'`,
// the *second* `updateAgencyBilling({ disabled })` pass must be SKIPPED so
// a stray Stripe event can't re-toggle an owner-comped account. Both
// branches were untested before — checkout.session.completed is the only
// branch the existing test above exercises.
// ---------------------------------------------------------------------------

test("processStripeEvent: customer.subscription.updated → active sub re-enables (disabled=false on both writes)", async () => {
  // Two writes are expected in this branch — applySubscription writes the
  // full plan/state row, then the post-check re-writes `disabled` after
  // confirming the persisted status is not 'comped'. Both must agree on
  // `disabled: false` for an active sub, otherwise an admin who reloads the
  // page mid-write would see a flickering suspension state.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_active_1",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: makeAgency({ subscription_status: "active" }) });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 2, "expected applySubscription + post-check writes");
  assert.equal(rec.updates[0]?.patch.subscriptionStatus, "active");
  assert.equal(rec.updates[0]?.patch.disabled, false);
  assert.equal(rec.updates[1]?.patch.disabled, false);
  assert.equal(rec.getById[0], 42);
});

test("processStripeEvent: customer.subscription.updated → past_due flips disabled to true", async () => {
  // The most common production case — Stripe failed to collect, so the
  // platform must lock the agency. Both writes must converge on disabled=true.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_pastdue_2",
    status: "past_due",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: makeAgency({ subscription_status: "past_due" }) });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 2);
  assert.equal(rec.updates[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(rec.updates[0]?.patch.disabled, true);
  assert.equal(rec.updates[1]?.patch.disabled, true);
});

test("processStripeEvent: customer.subscription.deleted → canceled + disabled true", async () => {
  // `deleted` is the cancellation lifecycle event. mapStripeStatus collapses
  // 'canceled' onto our `canceled` state, and isStripeSubscriptionActive
  // returns false → both writes must mark the agency disabled so AI dispatch
  // / new transmissions are immediately gated.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_canceled_3",
    status: "canceled",
    metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: makeAgency({ subscription_status: "canceled" }) });

  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 2);
  assert.equal(rec.updates[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(rec.updates[0]?.patch.disabled, true);
  assert.equal(rec.updates[1]?.patch.disabled, true);
});

test("processStripeEvent: customer.subscription.updated → 'comped' agency skips the post-check write", async () => {
  // This is the regression-protection test for commit 348e779: when the
  // platform owner has comped an agency, a stale or out-of-band Stripe
  // event must NOT toggle the `disabled` flag a second time. The first
  // applySubscription write still happens (it persists plan/seat state),
  // but the explicit "ensure disabled = !active" post-check is the gate
  // that has to be skipped.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_comped_4",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: makeAgency({ subscription_status: "comped" }) });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 1, "comped agencies must skip the post-check disabled write");
  assert.equal(rec.getById[0], 42, "post-check still loads the agency to read its status");
});

test("processStripeEvent: customer.subscription.updated → no agency_id metadata is a clean no-op", async () => {
  // If a stripe event lacks `metadata.agency_id`, `applySubscription`
  // bails early. The post-check also must bail (the helper sees null
  // from `agencyIdFromMeta`) so we never call `getAgencyById(NaN)` or
  // emit a write keyed to the wrong agency.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_nometa_5",
    status: "active",
    metadata: {},
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 0);
  assert.equal(rec.getById.length, 0);
});

test("processStripeEvent: customer.subscription.updated → agency not found, post-check write is skipped", async () => {
  // applySubscription doesn't read the agency row (it issues the write
  // unconditionally on a valid agency_id), so the first write must still
  // land. The post-check, however, runs `getAgencyById`; when it returns
  // null we must NOT call updateAgencyBilling a second time (the original
  // bug would have hit `null.subscription_status` and crashed the handler).
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_nofound_6",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.equal(rec.updates.length, 1, "applySubscription writes once even when getById is null");
  assert.deepEqual(rec.getById, [42]);
});

// ---------------------------------------------------------------------------
// processStripeEvent: invoice.payment_failed branch
//
// Stripe emits `invoice.payment_failed` immediately when card auth fails;
// the handler reaches into the invoice → subscription_details to recover
// the subscription id (which may be a string OR a `{ id }` object depending
// on Stripe API version). Both shapes must funnel through applySubscription
// so the agency row is updated.
// ---------------------------------------------------------------------------

test("processStripeEvent: invoice.payment_failed with string subscription ref retrieves + applies", async () => {
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_invoice_a",
    status: "past_due",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_invoice_a" } },
        },
      },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.deepEqual(rec.retrieveCalls, ["sub_invoice_a"]);
  assert.equal(rec.updates.length, 1);
  assert.equal(rec.updates[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(rec.updates[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed with object-form subscription ref also resolves", async () => {
  // Stripe's TypeScript types model `subscription` as `string | Subscription`.
  // Real payloads from newer API versions often arrive as `{ id: "sub_..." }`.
  // The handler reads `subRef.id` when it isn't a string; this test pins
  // that fallback path.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_invoice_b",
    status: "past_due",
    metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: {
            subscription_details: { subscription: { id: "sub_invoice_b" } },
          },
        },
      },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );

  assert.deepEqual(rec.retrieveCalls, ["sub_invoice_b"]);
  assert.equal(rec.updates.length, 1);
  assert.equal(rec.updates[0]?.patch.stripeSubscriptionId, "sub_invoice_b");
});

test("processStripeEvent: invoice.payment_failed with no subscription ref → no-op", async () => {
  // An invoice for a non-subscription one-off (or a malformed payload)
  // has no `subscription_details.subscription`. The handler must not
  // call stripe.subscriptions.retrieve(undefined) or emit a write.
  const { rec, deps } = makeDeps({ agency: null });

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: { object: { parent: undefined } },
    } as unknown as Stripe.Event,
    makeStripe({ id: "sub_unused" }, rec),
    deps,
  );

  assert.equal(rec.retrieveCalls.length, 0);
  assert.equal(rec.updates.length, 0);
});

// ---------------------------------------------------------------------------
// processStripeEvent: checkout.session.completed boundary cases
// ---------------------------------------------------------------------------

test("processStripeEvent: checkout.session.completed without agency_id metadata is a no-op", async () => {
  // The handler guards with `if (agencyId && typeof session.subscription === 'string')`.
  // Missing agency_id must short-circuit BEFORE calling stripe.subscriptions.retrieve;
  // a regression that flipped the guard would issue an unauthenticated Stripe call
  // per webhook delivery.
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: { metadata: {}, subscription: "sub_should_not_be_fetched" },
      },
    } as unknown as Stripe.Event,
    makeStripe({ id: "sub_should_not_be_fetched" }, rec),
    deps,
  );
  assert.equal(rec.retrieveCalls.length, 0);
  assert.equal(rec.updates.length, 0);
});

test("processStripeEvent: checkout.session.completed with non-string subscription is a no-op", async () => {
  // Stripe's `session.subscription` can be expanded into a full object;
  // the handler only takes the fast path when it's a string id. Pin the
  // guard so a future refactor that called `retrieve(session.subscription as string)`
  // unconditionally would fail this test (it would try to retrieve `[object Object]`).
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "42" },
          subscription: { id: "sub_expanded" },
        },
      },
    } as unknown as Stripe.Event,
    makeStripe({ id: "sub_expanded" }, rec),
    deps,
  );
  assert.equal(rec.retrieveCalls.length, 0);
  assert.equal(rec.updates.length, 0);
});

// ---------------------------------------------------------------------------
// processStripeEvent: unhandled event types are a no-op
// ---------------------------------------------------------------------------

test("processStripeEvent: unknown event types fall through to default with no side effects", async () => {
  // The switch statement intentionally ignores every event the platform
  // doesn't act on (charge.succeeded, payment_intent.*, customer.created, …).
  // A regression that fell through to one of the handled branches by mistake
  // could mis-apply a charge metadata blob as if it were a subscription update.
  const { rec, deps } = makeDeps({ agency: makeAgency({}) });
  for (const eventType of [
    "charge.succeeded",
    "customer.created",
    "payment_intent.succeeded",
    "invoice.paid",
    "totally.fake.event",
  ]) {
    await processStripeEvent(
      {
        type: eventType,
        data: { object: { metadata: { agency_id: "42" } } },
      } as unknown as Stripe.Event,
      makeStripe({ id: "sub_unused" }, rec),
      deps,
    );
  }
  assert.equal(rec.retrieveCalls.length, 0);
  assert.equal(rec.updates.length, 0);
  assert.equal(rec.getById.length, 0);
});

// ---------------------------------------------------------------------------
// applySubscription field mapping (exercised via processStripeEvent)
//
// The handler builds the agency-billing patch from Stripe subscription
// metadata. The mapping rules are tiny but high-stakes — a regression in
// any one of them silently mis-bills tenants or strands their
// transmissions. Pin every field through the public webhook entrypoint.
// ---------------------------------------------------------------------------

test("applySubscription: logs_unlimited='true' → logsUnlimited true, transmissionRetentionDays null", async () => {
  // Logs-unlimited subscribers get null (=unlimited) retention. A regression
  // that defaulted to 3 days would silently truncate long-form recordings
  // even though the customer is paying for unlimited retention.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_logs_unlimited",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "pro", logs_unlimited: "true" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );
  const patch = rec.updates[0]?.patch ?? {};
  assert.equal(patch.logsUnlimited, true);
  assert.equal(patch.transmissionRetentionDays, null);
  assert.equal(patch.planTier, "pro");
});

test("applySubscription: missing logs_unlimited → logsUnlimited false, transmissionRetentionDays 3", async () => {
  // Default retention is 3 days for non-pro / standard plans. The
  // comparison is strict-equal to the string "true", so any other value
  // (missing, "false", "1", "TRUE") must fall back to the 3-day floor.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_logs_default",
    status: "active",
    metadata: { agency_id: "42" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );
  const patch = rec.updates[0]?.patch ?? {};
  assert.equal(patch.logsUnlimited, false);
  assert.equal(patch.transmissionRetentionDays, 3);
});

test("applySubscription: plan_tier defaults to 'basic' for any non-'pro' metadata value", async () => {
  // Defence-in-depth: a typo or future plan slug must not silently promote
  // the agency to the highest tier — it must collapse onto 'basic' so AI
  // dispatch stays gated until billing explicitly upgrades the row.
  for (const planRaw of ["basic", "BASIC", "Pro", "enterprise", undefined as unknown as string]) {
    const sub: Partial<Stripe.Subscription> = {
      id: `sub_plan_${planRaw ?? "missing"}`,
      status: "active",
      metadata: planRaw == null ? { agency_id: "42" } : { agency_id: "42", plan_tier: planRaw },
      trial_end: null,
    };
    const { rec, deps } = makeDeps({ agency: null });
    await processStripeEvent(
      {
        type: "customer.subscription.updated",
        data: { object: sub },
      } as unknown as Stripe.Event,
      makeStripe(sub, rec),
      deps,
    );
    assert.equal(
      rec.updates[0]?.patch.planTier,
      "basic",
      `plan_tier=${JSON.stringify(planRaw)} must collapse onto 'basic'`,
    );
  }
});

test("applySubscription: trial_end (unix seconds) → ISO timestamp on the agency row", async () => {
  // Stripe sends `trial_end` as a unix-second integer; the agency row
  // stores it as ISO. A regression that left it as a number would break
  // the BillingPanel countdown (it parses the string with `new Date(...)`).
  const trialUnix = 1_785_398_400; // 2026-08-01T00:00:00Z
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_trial_iso",
    status: "trialing",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: trialUnix,
  };
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );
  const patch = rec.updates[0]?.patch ?? {};
  assert.equal(patch.subscriptionStatus, "trialing");
  assert.equal(patch.disabled, false);
  assert.equal(
    patch.trialEndsAt,
    new Date(trialUnix * 1000).toISOString(),
    "trial_end must be converted from unix seconds to ISO UTC",
  );
});

test("applySubscription: null trial_end → trialEndsAt null (clears stale trial deadline)", async () => {
  // When Stripe transitions an agency off trialing (status=active and
  // trial_end goes null), the agency row's `trial_ends_at` must be
  // cleared. A regression that kept the prior value would surface a
  // "trial expired" banner indefinitely in the admin panel.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_trial_cleared",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );
  assert.equal(rec.updates[0]?.patch.trialEndsAt, null);
});

test("applySubscription: writes the Stripe subscription id back onto the agency row", async () => {
  // The webhook is the *only* place where stripe_subscription_id is
  // populated (signup creates only the customer; the subscription is
  // attached at checkout). A regression that dropped this field would
  // strand the agency without a subscription id, which breaks
  // `openBillingPortal` and `changePlan`.
  const sub: Partial<Stripe.Subscription> = {
    id: "sub_writes_id_back",
    status: "active",
    metadata: { agency_id: "42", plan_tier: "basic", logs_unlimited: "false" },
    trial_end: null,
  };
  const { rec, deps } = makeDeps({ agency: null });
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: { object: sub },
    } as unknown as Stripe.Event,
    makeStripe(sub, rec),
    deps,
  );
  assert.equal(rec.updates[0]?.patch.stripeSubscriptionId, "sub_writes_id_back");
});
