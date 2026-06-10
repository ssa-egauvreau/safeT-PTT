/**
 * Tests for `server/src/billing/types.ts`.
 *
 * `SUBSCRIPTION_STATUSES`, `PLAN_TIERS`, and `TRIAL_DAYS` are referenced from
 * the webhook handler, the signup flow, the trial sweep, and the admin REST
 * routes. A drift in either array (e.g. adding `incomplete` without auditing
 * `isBillingActive`) or in `TRIAL_DAYS` (e.g. accidentally bumping to 0)
 * silently breaks every paying tenant. This file is the canary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_TIERS,
  SUBSCRIPTION_STATUSES,
  TRIAL_DAYS,
} from "../../src/billing/types.js";

test("SUBSCRIPTION_STATUSES enumerates exactly the 5 statuses the platform supports", () => {
  assert.deepEqual(
    [...SUBSCRIPTION_STATUSES].sort(),
    ["active", "canceled", "comped", "past_due", "trialing"],
  );
});

test("SUBSCRIPTION_STATUSES contains no duplicates", () => {
  assert.equal(new Set(SUBSCRIPTION_STATUSES).size, SUBSCRIPTION_STATUSES.length);
});

test("PLAN_TIERS lists the two billable plans, basic first (ordering used in admin UI)", () => {
  assert.deepEqual(PLAN_TIERS, ["basic", "pro"]);
});

test("TRIAL_DAYS stays at 7 — changing this changes Stripe trial billing and the in-app trial sweep", () => {
  assert.equal(TRIAL_DAYS, 7);
  assert.equal(typeof TRIAL_DAYS, "number");
  assert.ok(TRIAL_DAYS > 0, "a zero/negative trial would either auto-disable signups or never expire");
});
