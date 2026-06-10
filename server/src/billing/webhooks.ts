import type { Request, Response } from "express";
import Stripe from "stripe";
import { getStripe } from "./stripe.js";
import { stripeWebhookSecret } from "./config.js";
import { updateAgencyBilling, getAgencyById } from "../store.js";
import type { PlanTier, SubscriptionStatus } from "./types.js";

interface WebhookStoreDeps {
  updateAgencyBilling: typeof updateAgencyBilling;
  getAgencyById: typeof getAgencyById;
}

interface StripeSubscriptionReader {
  subscriptions: {
    retrieve(subscriptionId: string): Promise<Stripe.Subscription>;
  };
}

const defaultStoreDeps: WebhookStoreDeps = {
  updateAgencyBilling,
  getAgencyById,
};

/**
 * Maps a Stripe subscription state onto the platform's internal lifecycle
 * column. Exported so the contract can be pinned by unit tests — every
 * Stripe state must collapse onto exactly one of our five
 * `SubscriptionStatus` values, and any unknown future state must
 * conservatively land in `past_due` (which trips the disabled gate in
 * `applySubscription`) rather than silently re-enabling the agency.
 */
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

/** True only when Stripe reports a subscription the platform should treat as online. */
export function isStripeSubscriptionActive(status: Stripe.Subscription.Status): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Pulls the agency id out of Stripe webhook metadata (set on checkout
 * session + subscription metadata in `stripe.ts`). Exported for unit
 * testing — a regression that returned `0`/`NaN` instead of `null` would
 * cause `applySubscription` to update agency id 0 (or throw mid-webhook
 * and Stripe to retry), so the tripwire matters.
 */
export function agencyIdFromMeta(meta: Stripe.Metadata | null | undefined): number | null {
  const raw = meta?.agency_id;
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function applySubscription(
  sub: Stripe.Subscription,
  deps: WebhookStoreDeps = defaultStoreDeps,
): Promise<void> {
  const agencyId = agencyIdFromMeta(sub.metadata);
  if (!agencyId) {
    return;
  }
  const planTier = (sub.metadata.plan_tier === "pro" ? "pro" : "basic") as PlanTier;
  const logsUnlimited = sub.metadata.logs_unlimited === "true";
  const status = mapStripeStatus(sub.status);
  const active = isStripeSubscriptionActive(sub.status);

  await deps.updateAgencyBilling(agencyId, {
    stripeSubscriptionId: sub.id,
    subscriptionStatus: status,
    planTier,
    logsUnlimited,
    transmissionRetentionDays: logsUnlimited ? null : 3,
    disabled: !active,
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
  });
}

export async function processStripeEvent(
  event: Stripe.Event,
  stripe: StripeSubscriptionReader,
  deps: WebhookStoreDeps = defaultStoreDeps,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const agencyId = agencyIdFromMeta(session.metadata);
      if (agencyId && typeof session.subscription === "string") {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        // Keep disabled status aligned with the fetched subscription state.
        // Never force-enable here, because stale/retried checkout events can
        // arrive after a subscription already became past_due/canceled.
        await applySubscription(sub, deps);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const eventSub = event.data.object as Stripe.Subscription;
      const sub = await stripe.subscriptions.retrieve(eventSub.id);
      await applySubscription(sub, deps);
      const agencyId = agencyIdFromMeta(sub.metadata);
      if (agencyId) {
        const agency = await deps.getAgencyById(agencyId);
        if (agency && agency.subscription_status !== "comped") {
          const active = isStripeSubscriptionActive(sub.status);
          await deps.updateAgencyBilling(agencyId, { disabled: !active });
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
        await applySubscription(sub, deps);
      }
      break;
    }
    default:
      break;
  }
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
    await processStripeEvent(event, stripe, defaultStoreDeps);
    res.json({ received: true });
  } catch (error) {
    console.error("[billing] webhook handler error", error);
    res.status(500).json({ error: "webhook_failed" });
  }
}
