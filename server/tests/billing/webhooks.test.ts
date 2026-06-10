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
// processStripeEvent — checkout.session.completed: no-op branches
//
// The checkout webhook is mounted on a public URL. A regression that
// dropped the `agencyId && typeof session.subscription === "string"` guard
// would either issue a write against agency id 0 (no metadata case) or
// `await stripe.subscriptions.retrieve(<non-string>)`, which throws and
// returns 500 → Stripe retries forever. Pin both no-op branches so a
// future refactor can't quietly turn either into a destructive UPDATE.
// ---------------------------------------------------------------------------

test("processStripeEvent: checkout.session.completed with missing agency_id metadata is a no-op", async () => {
  // Without agency_id in the session metadata, we don't know which row
  // to update — must NOT issue an UPDATE. (A regression that defaulted
  // to id 0 would clobber the first row in the table.)
  const updateCalls: Array<{ agencyId: number }> = [];
  let retrieveCalled = false;
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalled = true;
        return { id: "sub_x", status: "active", metadata: {}, trial_end: null } as unknown as Stripe.Subscription;
      },
    },
  };

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: { object: { metadata: {}, subscription: "sub_x" } },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId) {
        updateCalls.push({ agencyId });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(updateCalls.length, 0, "no UPDATE should fire without agency_id metadata");
  assert.equal(retrieveCalled, false, "Stripe API should not be called either");
});

test("processStripeEvent: checkout.session.completed with non-string subscription is a no-op", async () => {
  // Stripe sometimes embeds the subscription as an object rather than a
  // string id. The handler short-circuits on `typeof === "string"` to
  // avoid passing an object to `stripe.subscriptions.retrieve(...)`,
  // which would throw a runtime TypeError.
  let retrieveCalled = false;
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalled = true;
        return { id: "sub_x", status: "active", metadata: { agency_id: "1" }, trial_end: null } as unknown as Stripe.Subscription;
      },
    },
  };
  const updateCalls: number[] = [];

  await processStripeEvent(
    {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { agency_id: "1" },
          subscription: { id: "sub_x" } as unknown as string,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId) {
        updateCalls.push(agencyId);
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalled, false);
  assert.equal(updateCalls.length, 0);
});

test("processStripeEvent: checkout.session.completed with no subscription field is a no-op", async () => {
  // Some checkout sessions (non-subscription mode, payment-only) carry
  // no `subscription`. The handler must skip rather than blow up.
  let retrieveCalled = false;
  const fakeStripe = {
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
      data: { object: { metadata: { agency_id: "42" } } },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling() {
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalled, false);
});

// ---------------------------------------------------------------------------
// processStripeEvent — customer.subscription.updated / .deleted
//
// This is the everyday Stripe event: trial converts to active, customer
// upgrades, customer cancels. The handler does TWO writes for
// non-comped agencies:
//   1. applySubscription() syncs everything (status, plan, retention,
//      disabled flag, trial_end).
//   2. A second updateAgencyBilling re-asserts `disabled` based purely on
//      `isStripeSubscriptionActive`. This second write is SKIPPED for
//      `comped` agencies — the comp state must never be flipped off by an
//      incoming Stripe event.
//
// Pin the comped-preserve path explicitly, plus the canceled-disables
// path that is the entire point of the deletion event.
// ---------------------------------------------------------------------------

test("processStripeEvent: customer.subscription.updated → active syncs all fields and stays enabled", async () => {
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_active",
          status: "active",
          metadata: { agency_id: "7", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        // Non-comped agency → handler issues the second `disabled: false` write.
        return {
          id: 7,
          subscription_status: "active",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  // First call from applySubscription, second from the post-apply re-assert.
  assert.equal(updateCalls.length, 2);

  const first = updateCalls[0]!;
  assert.equal(first.agencyId, 7);
  assert.equal(first.patch.subscriptionStatus, "active");
  assert.equal(first.patch.planTier, "pro");
  assert.equal(first.patch.logsUnlimited, true);
  assert.equal(first.patch.transmissionRetentionDays, null);
  assert.equal(first.patch.disabled, false);
  assert.equal(first.patch.stripeSubscriptionId, "sub_active");
  assert.equal(first.patch.trialEndsAt, null);

  const second = updateCalls[1]!;
  assert.deepEqual(second.patch, { disabled: false });
});

test("processStripeEvent: customer.subscription.deleted → canceled disables the agency", async () => {
  // Cancellation flow: Stripe pings us with status=canceled, the handler
  // collapses that onto our `canceled` and trips disabled=true. A
  // regression that left disabled=false would keep a no-longer-paying
  // tenant on the radio indefinitely.
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_dead",
          status: "canceled",
          metadata: { agency_id: "9", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return {
          id: 9,
          subscription_status: "active",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(updateCalls[0]?.patch.disabled, true);
  assert.deepEqual(updateCalls[1]?.patch, { disabled: true });
});

test("processStripeEvent: customer.subscription.updated does NOT flip a comped agency", async () => {
  // The comped state is set manually by the platform owner (free service
  // for grandfathered tenants, demos, etc). A Stripe webhook from a
  // since-attached card must NOT be allowed to silently un-comp the
  // agency. The handler skips the post-apply `disabled` re-assert when
  // the stored status is already `comped`.
  //
  // Note: applySubscription itself still writes (because it doesn't read
  // the current row), but the SECOND `disabled` write is suppressed.
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  let getAgencyCalls = 0;
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comped",
          status: "active",
          metadata: { agency_id: "11", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        getAgencyCalls += 1;
        return {
          id: 11,
          subscription_status: "comped",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  assert.equal(getAgencyCalls, 1, "must check the row's current status before the second write");
  // Only the applySubscription write — no second `disabled` patch.
  assert.equal(updateCalls.length, 1);
  // The patches that ARE written must not include a stray `disabled: false`
  // override coming from a parallel write.
  assert.equal(updateCalls[0]?.patch.disabled, false, "the apply-write does run; comped only suppresses the SECOND write");
});

test("processStripeEvent: customer.subscription.updated with no agency_id is a complete no-op", async () => {
  // No metadata → applySubscription bails immediately AND the post-apply
  // disable check is skipped (the `if (agencyId)` guard). Any update or
  // getAgencyById here would mean the handler is leaking writes onto an
  // unidentified row.
  const updateCalls: number[] = [];
  let getAgencyCalls = 0;
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_anon",
          status: "active",
          metadata: {},
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(agencyId) {
        updateCalls.push(agencyId);
        return null;
      },
      async getAgencyById() {
        getAgencyCalls += 1;
        return null;
      },
    },
  );

  assert.equal(updateCalls.length, 0);
  assert.equal(getAgencyCalls, 0);
});

test("processStripeEvent: customer.subscription.updated where agency vanished mid-flight is safe", async () => {
  // Race: Stripe event for an agency that was deleted between the apply
  // and the comped-check read. `getAgencyById` returns null. The handler
  // must NOT throw and must NOT issue the second write (which would hit
  // a now-stale id).
  const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_gone",
          status: "canceled",
          metadata: { agency_id: "13", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(_agencyId, patch) {
        updateCalls.push({ patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  // Only the applySubscription write — the post-apply re-assert is skipped.
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "canceled");
});

// ---------------------------------------------------------------------------
// processStripeEvent — invoice.payment_failed
//
// The handler accepts the Stripe v2018+ shape (parent.subscription_details
// with the subscription as either a string or an object). A regression
// that only handled one shape would silently drop the other. Pin both,
// plus the no-op when no subscription reference is present.
// ---------------------------------------------------------------------------

test("processStripeEvent: invoice.payment_failed (string subscription ref) re-syncs subscription state", async () => {
  let retrieveCalledWith: string | null = null;
  const fakeStripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        retrieveCalledWith = subscriptionId;
        return {
          id: subscriptionId,
          status: "past_due",
          metadata: { agency_id: "21", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        } as unknown as Stripe.Subscription;
      },
    },
  };
  const updateCalls: Array<{ patch: Record<string, unknown> }> = [];

  await processStripeEvent(
    {
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_failed_str" } },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(_agencyId, patch) {
        updateCalls.push({ patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalledWith, "sub_failed_str");
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updateCalls[0]?.patch.disabled, true);
});

test("processStripeEvent: invoice.payment_failed (object subscription ref) extracts the id", async () => {
  // Stripe SDK types include both string and Subscription-object shapes
  // for `subscription`. The handler unwraps via `.id`. A regression that
  // relied on `typeof === "string"` everywhere would silently miss every
  // failed-payment event whose subscription reference came back expanded.
  let retrieveCalledWith: string | null = null;
  const fakeStripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        retrieveCalledWith = subscriptionId;
        return {
          id: subscriptionId,
          status: "past_due",
          metadata: { agency_id: "22", plan_tier: "basic", logs_unlimited: "false" },
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
          parent: { subscription_details: { subscription: { id: "sub_failed_obj" } } },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling() {
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalledWith, "sub_failed_obj");
});

test("processStripeEvent: invoice.payment_failed with no subscription reference is a no-op", async () => {
  // Some invoice events (one-off charges, ad-hoc invoices) carry no
  // subscription reference. The handler must skip cleanly rather than
  // call retrieve("undefined") and 500.
  let retrieveCalled = false;
  const fakeStripe = {
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
      data: { object: { parent: undefined } },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling() {
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalled, false);
});

// ---------------------------------------------------------------------------
// processStripeEvent — applySubscription parsing edge cases
//
// applySubscription is private but reachable through every event type.
// These tests pin its three string-parsing edge cases:
//   - plan_tier defaults to "basic" for any value that is not exactly "pro"
//   - logs_unlimited is true ONLY for the literal string "true"
//   - trial_end converts a Unix-second integer to ISO; null stays null
// A regression on any of these silently mis-bills tenants.
// ---------------------------------------------------------------------------

test("processStripeEvent: plan_tier metadata defaults to 'basic' unless exactly 'pro'", async () => {
  // Anything that isn't the literal string "pro" must map to basic. A
  // regression to a truthy/loose check (e.g. lowercase compare) would
  // accept "Pro" / "PRO" / arbitrary truthy values and silently bump
  // tenants onto the more expensive plan.
  const variants: Array<{ raw: string; expected: "basic" | "pro" }> = [
    { raw: "pro", expected: "pro" },
    { raw: "Pro", expected: "basic" },
    { raw: "PRO", expected: "basic" },
    { raw: "premium", expected: "basic" },
    { raw: "", expected: "basic" },
    { raw: "basic", expected: "basic" },
  ];
  for (const v of variants) {
    const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
    await processStripeEvent(
      {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_x",
            status: "active",
            metadata: { agency_id: "1", plan_tier: v.raw, logs_unlimited: "false" },
            trial_end: null,
          },
        },
      } as unknown as Stripe.Event,
      { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
      {
        async updateAgencyBilling(_agencyId, patch) {
          updateCalls.push({ patch: patch as Record<string, unknown> });
          return null;
        },
        async getAgencyById() {
          return null;
        },
      },
    );
    assert.equal(updateCalls[0]?.patch.planTier, v.expected, `plan_tier=${JSON.stringify(v.raw)} should map to ${v.expected}`);
  }
});

test("processStripeEvent: logs_unlimited metadata is true only for exact 'true' string", async () => {
  // Stripe metadata is always strings. A regression to a truthy check
  // would accept "1" / "yes" / anything-non-empty and silently bill
  // tenants for unlimited logs.
  const variants: Array<{ raw: string; expectedFlag: boolean; expectedRetention: number | null }> = [
    { raw: "true", expectedFlag: true, expectedRetention: null },
    { raw: "True", expectedFlag: false, expectedRetention: 3 },
    { raw: "TRUE", expectedFlag: false, expectedRetention: 3 },
    { raw: "1", expectedFlag: false, expectedRetention: 3 },
    { raw: "yes", expectedFlag: false, expectedRetention: 3 },
    { raw: "", expectedFlag: false, expectedRetention: 3 },
    { raw: "false", expectedFlag: false, expectedRetention: 3 },
  ];
  for (const v of variants) {
    const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
    await processStripeEvent(
      {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_x",
            status: "active",
            metadata: { agency_id: "1", plan_tier: "basic", logs_unlimited: v.raw },
            trial_end: null,
          },
        },
      } as unknown as Stripe.Event,
      { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
      {
        async updateAgencyBilling(_agencyId, patch) {
          updateCalls.push({ patch: patch as Record<string, unknown> });
          return null;
        },
        async getAgencyById() {
          return null;
        },
      },
    );
    assert.equal(updateCalls[0]?.patch.logsUnlimited, v.expectedFlag, `logs_unlimited=${JSON.stringify(v.raw)} flag mismatch`);
    assert.equal(
      updateCalls[0]?.patch.transmissionRetentionDays,
      v.expectedRetention,
      `logs_unlimited=${JSON.stringify(v.raw)} retention mismatch`,
    );
  }
});

test("processStripeEvent: trial_end Unix seconds become ISO; null stays null", async () => {
  // Stripe sends trial_end as Unix seconds (or null). The handler
  // multiplies by 1000 → ISO. A regression that omitted the *1000
  // would write a 1970 timestamp; a regression that sent the raw
  // number would store an unparseable string in the agencies row.
  const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_trial",
          status: "trialing",
          // Unix seconds: 1781568000 → 2026-06-16T00:00:00.000Z
          trial_end: 1781568000,
          metadata: { agency_id: "5", plan_tier: "basic", logs_unlimited: "false" },
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(_agencyId, patch) {
        updateCalls.push({ patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(updateCalls[0]?.patch.trialEndsAt, "2026-06-16T00:00:00.000Z");
  assert.equal(updateCalls[0]?.patch.subscriptionStatus, "trialing");
  // Trial counts as active per isStripeSubscriptionActive — must NOT disable.
  assert.equal(updateCalls[0]?.patch.disabled, false);
});

test("processStripeEvent: trial_end null stays null (paid subscription with no trial)", async () => {
  const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_paid",
          status: "active",
          trial_end: null,
          metadata: { agency_id: "5", plan_tier: "basic", logs_unlimited: "false" },
        },
      },
    } as unknown as Stripe.Event,
    { subscriptions: { async retrieve(): Promise<Stripe.Subscription> { throw new Error("not used"); } } },
    {
      async updateAgencyBilling(_agencyId, patch) {
        updateCalls.push({ patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(updateCalls[0]?.patch.trialEndsAt, null);
});

// ---------------------------------------------------------------------------
// processStripeEvent — unknown event types
//
// Stripe webhooks deliver dozens of event types we don't handle. The
// handler must silently no-op (returning 200) so Stripe doesn't retry
// every irrelevant event into the error log forever. Pin the contract.
// ---------------------------------------------------------------------------

test("processStripeEvent: unknown event types are silently ignored (no DB writes, no Stripe API calls)", async () => {
  let updateCalls = 0;
  let getAgencyCalls = 0;
  let retrieveCalls = 0;
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        retrieveCalls += 1;
        return {} as Stripe.Subscription;
      },
    },
  };

  for (const type of [
    "customer.created",
    "invoice.paid",
    "charge.succeeded",
    "payment_method.attached",
    "ping",
    "this.event.does.not.exist",
  ]) {
    await processStripeEvent(
      {
        type,
        data: { object: { metadata: { agency_id: "99" } } },
      } as unknown as Stripe.Event,
      fakeStripe,
      {
        async updateAgencyBilling() {
          updateCalls += 1;
          return null;
        },
        async getAgencyById() {
          getAgencyCalls += 1;
          return null;
        },
      },
    );
  }

  assert.equal(updateCalls, 0);
  assert.equal(getAgencyCalls, 0);
  assert.equal(retrieveCalls, 0);
});
