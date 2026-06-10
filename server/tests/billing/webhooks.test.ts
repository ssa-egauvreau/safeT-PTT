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

test("processStripeEvent: checkout completion with no subscription id is a no-op", async () => {
  // Stripe sends `checkout.session.completed` for one-time payments too,
  // in which case `subscription` is null. The handler must NOT crash
  // calling `subscriptions.retrieve(null)` — it must short-circuit and
  // leave the agency row untouched.
  let retrieveCalled = false;
  const updateCalls: Array<unknown> = [];
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
      data: {
        object: { metadata: { agency_id: "42" }, subscription: null },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(...args: unknown[]) {
        updateCalls.push(args);
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalled, false, "no subscription → must not look it up");
  assert.equal(updateCalls.length, 0, "no subscription → no writes");
});

test("processStripeEvent: checkout completion with no agency_id metadata is a no-op", async () => {
  // Stripe may surface a `checkout.session.completed` for sessions created
  // outside our flow (Stripe Dashboard test buttons, ISV resellers).
  // Without our `agency_id` metadata, the handler must NOT update any row.
  let retrieveCalled = false;
  const updateCalls: Array<unknown> = [];
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
      data: { object: { metadata: {}, subscription: "sub_x" } },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(...args: unknown[]) {
        updateCalls.push(args);
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

test("processStripeEvent: customer.subscription.deleted disables the agency", async () => {
  // Stripe emits `customer.subscription.deleted` when the customer cancels
  // and the term ends. The handler must flip `disabled = true` (suspend
  // the agency) and stamp the local row with the terminal status.
  const updates: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("should not be called on a delete event");
      },
    },
  };

  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_canceled",
          status: "canceled",
          metadata: { agency_id: "7", plan_tier: "basic", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId, patch) {
        updates.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        // Pretend the agency exists and is NOT comped, so the
        // subscription.* path runs the second `updateAgencyBilling` to
        // re-confirm `disabled = true`.
        return {
          id: 7,
          subscription_status: "canceled",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  // applySubscription writes once, then the post-update guard writes again
  // when the agency is not comped. Both writes must set disabled = true.
  assert.ok(updates.length >= 1, "expected at least one update");
  for (const u of updates) {
    assert.equal(u.agencyId, 7);
    assert.notEqual(u.patch.disabled, false);
  }
  // The first write (from applySubscription) is the canonical one and
  // must include the terminal status.
  assert.equal(updates[0]?.patch.subscriptionStatus, "canceled");
  assert.equal(updates[0]?.patch.planTier, "basic");
});

test("processStripeEvent: comped agencies are NEVER toggled on subscription updates", async () => {
  // The "comped" status is a manual platform override (set by the owner
  // portal) for grandfathered tenants or partnerships. Stripe events for
  // a comped agency MUST NOT flip `disabled` — that would let a stale
  // Stripe webhook re-suspend a tenant the platform owner explicitly
  // marked as free. `applySubscription` will still update the metadata
  // bookkeeping; only the second guard's write must be skipped.
  let secondGuardWriteOccurred = false;
  const updateCalls: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("should not be called");
      },
    },
  };

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comped",
          // Stripe says canceled — but the agency is comped, so the
          // post-applySubscription guard must skip the disabled toggle.
          status: "canceled",
          metadata: { agency_id: "99", plan_tier: "pro", logs_unlimited: "false" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId, patch) {
        updateCalls.push({ agencyId, patch: patch as Record<string, unknown> });
        // The second `updateAgencyBilling` (the guard write) only carries
        // `disabled`. Detect it by patch shape.
        const keys = Object.keys(patch);
        if (keys.length === 1 && keys[0] === "disabled") {
          secondGuardWriteOccurred = true;
        }
        return null;
      },
      async getAgencyById() {
        return {
          id: 99,
          subscription_status: "comped",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  // applySubscription still runs (it bookkeeps Stripe's reported state
  // onto the agency row), but the post-guard MUST be skipped for comped.
  assert.equal(
    secondGuardWriteOccurred,
    false,
    "comped agency was re-toggled by a Stripe webhook — regression",
  );
  // The single applySubscription write is allowed.
  assert.equal(updateCalls.length, 1);
});

test("processStripeEvent: invoice.payment_failed retrieves the subscription and re-applies it", async () => {
  // When Stripe reports a failed invoice the most reliable signal is to
  // pull the up-to-date subscription state, because the invoice itself
  // doesn't carry the full set of metadata we need. The handler must
  // resolve the subscription id from `invoice.parent.subscription_details`
  // and apply the resulting subscription onto the agency row.
  const fetched: string[] = [];
  const updates: Array<{ agencyId: number; patch: Record<string, unknown> }> = [];
  const fakeStripe = {
    subscriptions: {
      async retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
        fetched.push(subscriptionId);
        return {
          id: subscriptionId,
          status: "past_due",
          metadata: { agency_id: "5", plan_tier: "basic", logs_unlimited: "false" },
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
          parent: { subscription_details: { subscription: "sub_failed" } },
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(agencyId, patch) {
        updates.push({ agencyId, patch: patch as Record<string, unknown> });
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.deepEqual(fetched, ["sub_failed"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.agencyId, 5);
  assert.equal(updates[0]?.patch.subscriptionStatus, "past_due");
  assert.equal(updates[0]?.patch.disabled, true, "past_due must suspend the agency");
});

test("processStripeEvent: invoice.payment_failed with no subscription is a no-op", async () => {
  // One-off invoices (no associated subscription) must not crash the
  // handler. Skip silently.
  let retrieveCalled = false;
  const updateCalls: unknown[] = [];
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
      data: { object: { parent: null } },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(...args: unknown[]) {
        updateCalls.push(args);
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

test("processStripeEvent: unhandled event types are a no-op (no Stripe call, no DB write)", async () => {
  // Stripe ships dozens of event types; the handler only acts on four.
  // The default branch must NOT crash and must NOT mutate state — anything
  // else would either spam Stripe with 500-retries or corrupt the agency
  // row from an unrelated event (e.g. `customer.tax_id.created`).
  let retrieveCalled = false;
  let updateCalled = false;
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
      type: "customer.tax_id.created",
      data: { object: {} },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling() {
        updateCalled = true;
        return null;
      },
      async getAgencyById() {
        return null;
      },
    },
  );

  assert.equal(retrieveCalled, false);
  assert.equal(updateCalled, false);
});

test("processStripeEvent: subscription.updated, comped, status active still bookkeeps but does NOT re-enable", async () => {
  // Mirror of the comped/canceled test: a happy `active` event on a
  // comped agency must also skip the second guard write. The platform's
  // contract is that Stripe state never overwrites a comped agency's
  // `disabled` flag — not in either direction.
  let secondGuardWriteOccurred = false;
  const fakeStripe = {
    subscriptions: {
      async retrieve(): Promise<Stripe.Subscription> {
        throw new Error("not called");
      },
    },
  };

  await processStripeEvent(
    {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comped_active",
          status: "active",
          metadata: { agency_id: "100", plan_tier: "pro", logs_unlimited: "true" },
          trial_end: null,
        },
      },
    } as unknown as Stripe.Event,
    fakeStripe,
    {
      async updateAgencyBilling(_agencyId: number, patch: Record<string, unknown>) {
        const keys = Object.keys(patch);
        if (keys.length === 1 && keys[0] === "disabled") {
          secondGuardWriteOccurred = true;
        }
        return null;
      },
      async getAgencyById() {
        return {
          id: 100,
          subscription_status: "comped",
        } as unknown as Awaited<ReturnType<typeof import("../../src/store.js").getAgencyById>>;
      },
    },
  );

  assert.equal(
    secondGuardWriteOccurred,
    false,
    "comped agency disabled flag must not be touched by a webhook, even for an 'active' event",
  );
});
