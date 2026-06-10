import { requirePool } from "../db.js";
import {
  countBillableRadioUsers,
  getAgencyBillingById,
  updateAgencyBilling,
  type AgencyRow,
} from "../store.js";
import { billingEnabled } from "./config.js";
import {
  createBillingPortalSession,
  createCheckoutSession,
  createStripeCustomer,
  syncSubscriptionQuantity,
  updateSubscriptionPlan,
} from "./stripe.js";
import type { BillingStatusResponse, PlanTier, SubscriptionStatus } from "./types.js";
import { TRIAL_DAYS } from "./types.js";

export function isBillingActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "comped" || status === "trialing";
}

/**
 * Pure helper: decides whether a disabled agency is disabled BECAUSE of
 * billing — i.e. should the auth gate surface `agency_suspended_billing`
 * (the "your free trial ended / payment failed" UX) rather than the
 * generic `agency_disabled` (admin manually flipped the kill switch).
 *
 * The rule mirrors what the auth middleware in `apiRoutes.ts` was inlining
 * pre-extraction:
 *   - The agency must be a self-service tenant (`signup_completed_at` set).
 *     Grandfathered / comped tenants without a sign-up record never hit this
 *     branch — they get the generic "agency_disabled" message.
 *   - `comped` and `active` are paying / sponsored tenants — never billing
 *     suspended.
 *   - `trialing` is billing-suspended ONLY if the trial deadline has already
 *     elapsed; an in-flight trial that an admin manually disables is not a
 *     billing problem.
 *   - Every other status (`past_due`, `canceled`) is billing-suspended.
 */
export function isBillingSuspended(
  agency: Pick<AgencyRow, "signup_completed_at" | "subscription_status" | "trial_ends_at"> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!agency) {
    return false;
  }
  if (agency.signup_completed_at == null) {
    return false;
  }
  if (agency.subscription_status === "comped" || agency.subscription_status === "active") {
    return false;
  }
  if (agency.subscription_status === "trialing") {
    if (agency.trial_ends_at != null && new Date(agency.trial_ends_at) > now) {
      return false;
    }
  }
  return true;
}

export function trialDaysLeft(trialEndsAt: string | null): number | null {
  if (!trialEndsAt) {
    return null;
  }
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  if (ms <= 0) {
    return 0;
  }
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export async function getBillingStatus(agency: AgencyRow): Promise<BillingStatusResponse> {
  const billableSeats = await countBillableRadioUsers(agency.id);
  return {
    plan_tier: agency.plan_tier,
    subscription_status: agency.subscription_status,
    trial_ends_at: agency.trial_ends_at,
    trial_days_left: trialDaysLeft(agency.trial_ends_at),
    billable_seats: billableSeats,
    logs_unlimited: agency.logs_unlimited,
    transmission_retention_days: agency.transmission_retention_days,
    billing_configured: billingEnabled(),
    portal_available: billingEnabled() && !!agency.stripe_customer_id,
    agency_disabled: agency.disabled,
  };
}

export async function ensureStripeCustomer(agency: AgencyRow, email: string): Promise<string | null> {
  if (agency.stripe_customer_id) {
    return agency.stripe_customer_id;
  }
  const customer = await createStripeCustomer({
    email,
    name: agency.name,
    agencyId: agency.id,
  });
  if (!customer) {
    return null;
  }
  await updateAgencyBilling(agency.id, { stripeCustomerId: customer.id });
  return customer.id;
}

export async function startCheckout(input: {
  agencyId: number;
  planTier: PlanTier;
  logsUnlimited: boolean;
  includeTrial?: boolean;
}): Promise<{ url: string } | { error: string }> {
  const agency = await getAgencyBillingById(input.agencyId);
  if (!agency) {
    return { error: "agency_not_found" };
  }
  if (!billingEnabled()) {
    return { error: "billing_not_configured" };
  }
  const email = agency.billing_email;
  if (!email) {
    return { error: "missing_billing_email" };
  }
  const customerId = await ensureStripeCustomer(agency, email);
  if (!customerId) {
    return { error: "stripe_customer_failed" };
  }

  const seats = await countBillableRadioUsers(agency.id);
  const session = await createCheckoutSession({
    customerId,
    agencyId: agency.id,
    planTier: input.planTier,
    seatQuantity: Math.max(1, seats),
    logsUnlimited: input.logsUnlimited,
    trialDays: input.includeTrial ? TRIAL_DAYS : undefined,
  });
  if (!session?.url) {
    return { error: "checkout_failed" };
  }
  return { url: session.url };
}

export async function openBillingPortal(agencyId: number): Promise<{ url: string } | { error: string }> {
  const agency = await getAgencyBillingById(agencyId);
  if (!agency?.stripe_customer_id) {
    return { error: "no_stripe_customer" };
  }
  const session = await createBillingPortalSession(agency.stripe_customer_id);
  if (!session?.url) {
    return { error: "portal_failed" };
  }
  return { url: session.url };
}

export async function syncSeatsForAgency(agencyId: number): Promise<void> {
  const agency = await getAgencyBillingById(agencyId);
  if (!agency?.stripe_subscription_id) {
    return;
  }
  const seats = await countBillableRadioUsers(agencyId);
  await syncSubscriptionQuantity(agency.stripe_subscription_id, Math.max(1, seats));
}

export async function changePlan(input: {
  agencyId: number;
  planTier: PlanTier;
  logsUnlimited: boolean;
}): Promise<{ ok: true } | { error: string }> {
  const agency = await getAgencyBillingById(input.agencyId);
  if (!agency) {
    return { error: "agency_not_found" };
  }

  if (agency.stripe_subscription_id) {
    const seats = await countBillableRadioUsers(agency.id);
    const updated = await updateSubscriptionPlan({
      subscriptionId: agency.stripe_subscription_id,
      planTier: input.planTier,
      logsUnlimited: input.logsUnlimited,
      seatQuantity: Math.max(1, seats),
    });
    if (!updated) {
      return { error: "stripe_update_failed" };
    }
  }

  await updateAgencyBilling(agency.id, {
    planTier: input.planTier,
    logsUnlimited: input.logsUnlimited,
    transmissionRetentionDays: input.logsUnlimited ? null : 3,
  });
  return { ok: true };
}

export async function emailAlreadyUsedTrial(email: string): Promise<boolean> {
  const res = await requirePool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agencies WHERE lower(billing_email) = lower($1) AND trial_email_used = TRUE;`,
    [email.trim()],
  );
  return Number(res.rows[0]?.n ?? "0") > 0;
}

export async function markTrialEmailUsed(email: string): Promise<void> {
  await requirePool().query(
    `UPDATE agencies SET trial_email_used = TRUE WHERE lower(billing_email) = lower($1);`,
    [email.trim()],
  );
}
