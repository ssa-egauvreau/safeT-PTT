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
  subscriptionBillingPatch,
} from "../../src/billing/webhooks.js";

/**
 * Builds a minimally-shaped Stripe.Subscription stub. Only the fields
 * read by `subscriptionBillingPatch` are populated — every other Stripe
 * field is left undefined, which is fine because the helper only
 * touches `id`, `status`, `metadata`, and `trial_end`.
 */
function stubSub(overrides: {
  id?: string;
  status?: Stripe.Subscription.Status;
  metadata?: Stripe.Metadata;
  trial_end?: number | null;
} = {}): Stripe.Subscription {
  return {
    id: overrides.id ?? "sub_test",
    status: overrides.status ?? "active",
    metadata: (overrides.metadata ?? { agency_id: "42" }) as Stripe.Metadata,
    trial_end: overrides.trial_end ?? null,
  } as unknown as Stripe.Subscription;
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
// subscriptionBillingPatch
//
// Pins the exact DB patch the webhook will write for a given Stripe
// subscription. This is the helper extracted from `applySubscription`
// during the "avoid re-enabling suspended agencies on checkout webhook
// retries" fix (PR #278) — without these tests, a regression to the
// previous formulation `disabled: status === "canceled" || status === "past_due"`
// would silently re-enable agencies whose subscription is `incomplete`,
// `paused`, or any unknown future Stripe state.
// ---------------------------------------------------------------------------

test("subscriptionBillingPatch: returns null when metadata has no agency_id", () => {
  // The webhook handler reads this as "this event is not ours, skip the
  // UPDATE". Returning a patch with agencyId 0 or NaN here would corrupt
  // an unrelated row in the agencies table.
  assert.equal(subscriptionBillingPatch(stubSub({ metadata: {} as Stripe.Metadata })), null);
  assert.equal(
    subscriptionBillingPatch(stubSub({ metadata: { agency_id: "" } as Stripe.Metadata })),
    null,
  );
  assert.equal(
    subscriptionBillingPatch(stubSub({ metadata: { agency_id: "not-a-number" } as Stripe.Metadata })),
    null,
  );
});

test("subscriptionBillingPatch: active subscription writes disabled=false", () => {
  const update = subscriptionBillingPatch(stubSub({ status: "active" }));
  assert.ok(update, "active subscription should produce a patch");
  assert.equal(update.patch.disabled, false);
  assert.equal(update.patch.subscriptionStatus, "active");
});

test("subscriptionBillingPatch: trialing subscription writes disabled=false (paying trial)", () => {
  // The 7-day trial is the documented onboarding path — disabling
  // trialing agencies would cut off paying customers' first week.
  const update = subscriptionBillingPatch(stubSub({ status: "trialing" }));
  assert.ok(update);
  assert.equal(update.patch.disabled, false);
  assert.equal(update.patch.subscriptionStatus, "trialing");
});

test("subscriptionBillingPatch: past_due/unpaid sets disabled=true (paywall)", () => {
  for (const status of ["past_due", "unpaid"] as const) {
    const update = subscriptionBillingPatch(stubSub({ status }));
    assert.ok(update, `${status} should produce a patch`);
    assert.equal(update.patch.disabled, true, `${status} must disable the agency`);
    assert.equal(update.patch.subscriptionStatus, "past_due");
  }
});

test("subscriptionBillingPatch: canceled/incomplete_expired sets disabled=true", () => {
  for (const status of ["canceled", "incomplete_expired"] as const) {
    const update = subscriptionBillingPatch(stubSub({ status }));
    assert.ok(update);
    assert.equal(update.patch.disabled, true, `${status} must disable the agency`);
    assert.equal(update.patch.subscriptionStatus, "canceled");
  }
});

test("subscriptionBillingPatch: incomplete/paused/unknown set disabled=true (PR #278 regression guard)", () => {
  // This is the exact behavior PR #278 fixed. The pre-fix code derived
  // `disabled` from the mapped status: `status === "canceled" ||
  // status === "past_due"`. Because mapStripeStatus collapses
  // incomplete/paused/unknown onto "past_due", that LOOKED right —
  // but combined with the now-removed `updateAgencyBilling(agencyId, { disabled: false })`
  // after applySubscription on checkout.session.completed, retries of
  // checkout events on `incomplete` subscriptions would re-enable a
  // suspended agency. New formulation derives disabled directly from
  // isStripeSubscriptionActive, which only allows active/trialing.
  for (const status of [
    "incomplete",
    "paused",
    "future_state_not_yet_in_sdk",
  ] as Stripe.Subscription.Status[]) {
    const update = subscriptionBillingPatch(stubSub({ status }));
    assert.ok(update, `${status} should produce a patch`);
    assert.equal(
      update.patch.disabled,
      true,
      `${status} must NOT re-enable a suspended agency`,
    );
  }
});

test("subscriptionBillingPatch: plan_tier='pro' is the only string mapped to pro", () => {
  // The metadata is set by `stripe.ts` during checkout. Any divergence
  // from the exact string "pro" must fall through to "basic" — a
  // regression that mapped "Pro" or "PRO" to "pro" would silently
  // upgrade customers, then bill them on the wrong line item.
  assert.equal(subscriptionBillingPatch(stubSub({ metadata: { agency_id: "42", plan_tier: "pro" } }))!.patch.planTier, "pro");
  assert.equal(subscriptionBillingPatch(stubSub({ metadata: { agency_id: "42", plan_tier: "Pro" } }))!.patch.planTier, "basic");
  assert.equal(subscriptionBillingPatch(stubSub({ metadata: { agency_id: "42", plan_tier: "" } }))!.patch.planTier, "basic");
  assert.equal(subscriptionBillingPatch(stubSub({ metadata: { agency_id: "42" } }))!.patch.planTier, "basic");
});

test("subscriptionBillingPatch: logs_unlimited='true' is the only string mapped to true", () => {
  // Same contract as plan_tier — pinned exactly so a refactor to
  // Boolean()/truthy coercion (which would flip "false" → true) is
  // caught immediately. Logs-unlimited customers pay a separate line
  // item; flipping a false to true silently gives them the upgrade.
  const yes = subscriptionBillingPatch(
    stubSub({ metadata: { agency_id: "42", logs_unlimited: "true" } }),
  )!;
  assert.equal(yes.patch.logsUnlimited, true);
  assert.equal(yes.patch.transmissionRetentionDays, null, "unlimited logs ⇒ no retention cap");

  for (const raw of ["false", "True", "1", "yes", ""]) {
    const update = subscriptionBillingPatch(
      stubSub({ metadata: { agency_id: "42", logs_unlimited: raw } }),
    )!;
    assert.equal(update.patch.logsUnlimited, false, `logs_unlimited=${JSON.stringify(raw)} ⇒ false`);
    assert.equal(
      update.patch.transmissionRetentionDays,
      3,
      `logs_unlimited=${JSON.stringify(raw)} ⇒ default 3-day retention`,
    );
  }
});

test("subscriptionBillingPatch: trial_end is converted from unix seconds to ISO UTC", () => {
  // `trial_end` is a Stripe unix-seconds value. The DB column is a
  // text ISO timestamp; a regression that forgot the * 1000 would
  // store dates in 1970 and break the trial-expiry sweep entirely.
  const update = subscriptionBillingPatch(
    stubSub({ trial_end: Math.floor(Date.UTC(2026, 0, 8, 12, 0, 0) / 1000) }),
  )!;
  assert.equal(update.patch.trialEndsAt, "2026-01-08T12:00:00.000Z");
});

test("subscriptionBillingPatch: missing trial_end leaves trialEndsAt=null (not 1970)", () => {
  // For non-trial subscriptions Stripe omits `trial_end`. A coercion
  // bug that passed 0 to `new Date(0 * 1000)` would write
  // "1970-01-01T00:00:00.000Z" and immediately flag every paid
  // account as a lapsed trial.
  const update = subscriptionBillingPatch(stubSub({ trial_end: null }))!;
  assert.equal(update.patch.trialEndsAt, null);
});

test("subscriptionBillingPatch: stripeSubscriptionId always echoes the Stripe sub id", () => {
  // The handler relies on this id being written so subsequent
  // customer.subscription.updated events can be correlated.
  const update = subscriptionBillingPatch(stubSub({ id: "sub_xyz123" }))!;
  assert.equal(update.patch.stripeSubscriptionId, "sub_xyz123");
});

test("subscriptionBillingPatch: agencyId echoes the parsed metadata value", () => {
  // Sanity check that the helper does not silently drop or rewrite the
  // agency id when building the patch (e.g. a regression that clamped
  // to a positive int set could re-route writes to a different row).
  const update = subscriptionBillingPatch(stubSub({ metadata: { agency_id: "777" } }))!;
  assert.equal(update.agencyId, 777);
});
