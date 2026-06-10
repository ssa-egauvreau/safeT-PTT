import type { Request, Response } from "express";
import Stripe from "stripe";
import { getStripe } from "./stripe.js";
import { stripeWebhookSecret } from "./config.js";
import { updateAgencyBilling, getAgencyById } from "../store.js";
import type { PlanTier, SubscriptionStatus } from "./types.js";

export function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "past_due";
  }
}

export function isStripeSubscriptionActive(status: Stripe.Subscription.Status): boolean {
  return status === "active" || status === "trialing";
}

export function agencyIdFromMeta(meta: Stripe.Metadata | null | undefined): number | null {
  const raw = meta?.agency_id;
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure projection from a Stripe.Subscription to the billing patch we write
 * to the `agencies` row. Extracted so the disabled / plan / retention
 * derivation can be unit-tested without standing up Stripe or Postgres.
 *
 * Critical contract: `disabled` is derived from the live Stripe status via
 * `isStripeSubscriptionActive` so a checkout-completion webhook retry for a
 * tenant whose subscription is `past_due` / `canceled` does NOT silently
 * re-enable them (regression that motivated this helper).
 */
export interface SubscriptionBillingPatch {
  stripeSubscriptionId: string;
  subscriptionStatus: SubscriptionStatus;
  planTier: PlanTier;
  logsUnlimited: boolean;
  transmissionRetentionDays: number | null;
  disabled: boolean;
  trialEndsAt: string | null;
}

export function subscriptionBillingPatch(sub: Stripe.Subscription): SubscriptionBillingPatch {
  const planTier: PlanTier = sub.metadata?.plan_tier === "pro" ? "pro" : "basic";
  const logsUnlimited = sub.metadata?.logs_unlimited === "true";
  return {
    stripeSubscriptionId: sub.id,
    subscriptionStatus: mapStripeStatus(sub.status),
    planTier,
    logsUnlimited,
    transmissionRetentionDays: logsUnlimited ? null : 3,
    disabled: !isStripeSubscriptionActive(sub.status),
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
  };
}

/**
 * Decides whether the `customer.subscription.updated` /
 * `customer.subscription.deleted` branch should flip `agency.disabled`.
 *
 * - Returns `null` for comped agencies — those are operator-controlled and
 *   must never be auto-disabled by a Stripe event (otherwise an admin who
 *   manually marked an agency comped would see it suspended the next time
 *   Stripe replays a stale subscription event).
 * - Otherwise returns `!isStripeSubscriptionActive(subStatus)`.
 */
export function shouldDisableForSubscriptionUpdate(
  subStatus: Stripe.Subscription.Status,
  currentAgencyStatus: SubscriptionStatus,
): boolean | null {
  if (currentAgencyStatus === "comped") {
    return null;
  }
  return !isStripeSubscriptionActive(subStatus);
}

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const agencyId = agencyIdFromMeta(sub.metadata);
  if (!agencyId) {
    return;
  }
  await updateAgencyBilling(agencyId, subscriptionBillingPatch(sub));
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const stripe = getStripe();
  const secret = stripeWebhookSecret();
  if (!stripe || !secret) {
    res.status(503).json({ error: "billing_not_configured" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    res.status(400).json({ error: "missing_signature" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, secret);
  } catch (err) {
    console.warn("[billing] webhook signature failed", err);
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const agencyId = agencyIdFromMeta(session.metadata);
        if (agencyId && typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await applySubscription(sub);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await applySubscription(sub);
        const agencyId = agencyIdFromMeta(sub.metadata);
        if (agencyId) {
          const agency = await getAgencyById(agencyId);
          if (agency) {
            const disabled = shouldDisableForSubscriptionUpdate(sub.status, agency.subscription_status);
            if (disabled !== null) {
              await updateAgencyBilling(agencyId, { disabled });
            }
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = invoice.parent?.subscription_details?.subscription;
        const subId = typeof subRef === "string" ? subRef : subRef?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscription(sub);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error("[billing] webhook handler error", error);
    res.status(500).json({ error: "webhook_failed" });
  }
}
