/** Subscription lifecycle states stored on agencies. */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "comped";

/** Billable plan tier — pro unlocks AI dispatch. */
export type PlanTier = "basic" | "pro";

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "comped",
];

export const PLAN_TIERS: PlanTier[] = ["basic", "pro"];

export const TRIAL_DAYS = 7;

export interface AgencyBillingRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  plan_tier: PlanTier;
  trial_ends_at: string | null;
  transmission_retention_days: number | null;
  logs_unlimited: boolean;
  billing_email: string | null;
  signup_completed_at: string | null;
  trial_email_used: boolean;
}

export interface BillingStatusResponse {
  plan_tier: PlanTier;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  trial_days_left: number | null;
  billable_seats: number;
  logs_unlimited: boolean;
  transmission_retention_days: number | null;
  billing_configured: boolean;
  portal_available: boolean;
  agency_disabled: boolean;
}
