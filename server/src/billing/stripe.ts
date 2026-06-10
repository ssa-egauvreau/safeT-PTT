import Stripe from "stripe";
import {
  billingEnabled,
  priceIdForTier,
  publicAppUrl,
  stripePriceLogsUnlimited,
  stripeSecretKey,
} from "./config.js";
import type { PlanTier } from "./types.js";

let client: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!billingEnabled()) {
    return null;
  }
  if (!client) {
    client = new Stripe(stripeSecretKey()!);
  }
  return client;
}

export async function createStripeCustomer(input: {
  email: string;
  name: string;
  agencyId: number;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer | null> {
  const stripe = getStripe();
  if (!stripe) {
    return null;
  }
  return stripe.customers.create({
    email: input.email,
    name: input.name,
    metadata: {
      agency_id: String(input.agencyId),
      ...input.metadata,
    },
  });
}

export async function createCheckoutSession(input: {
  customerId: string;
  agencyId: number;
  planTier: PlanTier;
  seatQuantity: number;
  logsUnlimited: boolean;
  trialDays?: number;
}): Promise<Stripe.Checkout.Session | null> {
  const stripe = getStripe();
  const basePrice = priceIdForTier(input.planTier);
  if (!stripe || !basePrice) {
    return null;
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price: basePrice,
      quantity: Math.max(1, input.seatQuantity),
    },
  ];
  const logsPrice = stripePriceLogsUnlimited();
  if (input.logsUnlimited && logsPrice) {
    lineItems.push({ price: logsPrice, quantity: 1 });
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: input.customerId,
    line_items: lineItems,
    success_url: `${publicAppUrl()}/admin?billing=success`,
    cancel_url: `${publicAppUrl()}/admin?billing=canceled`,
    metadata: {
      agency_id: String(input.agencyId),
      plan_tier: input.planTier,
      logs_unlimited: input.logsUnlimited ? "true" : "false",
    },
    subscription_data: {
      metadata: {
        agency_id: String(input.agencyId),
        plan_tier: input.planTier,
        logs_unlimited: input.logsUnlimited ? "true" : "false",
      },
    },
  };

  if (input.trialDays != null && input.trialDays > 0) {
    params.subscription_data!.trial_period_days = input.trialDays;
  }

  return stripe.checkout.sessions.create(params);
}

export async function createBillingPortalSession(customerId: string): Promise<Stripe.BillingPortal.Session | null> {
  const stripe = getStripe();
  if (!stripe) {
    return null;
  }
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${publicAppUrl()}/admin`,
  });
}

export async function syncSubscriptionQuantity(
  subscriptionId: string,
  quantity: number,
): Promise<Stripe.Subscription | null> {
  const stripe = getStripe();
  if (!stripe) {
    return null;
  }
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items.data[0];
  if (!item) {
    return sub;
  }
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, quantity: Math.max(1, quantity) }],
    proration_behavior: "create_prorations",
  });
}

export async function updateSubscriptionPlan(input: {
  subscriptionId: string;
  planTier: PlanTier;
  logsUnlimited: boolean;
  seatQuantity: number;
}): Promise<Stripe.Subscription | null> {
  const stripe = getStripe();
  const basePrice = priceIdForTier(input.planTier);
  const logsPrice = stripePriceLogsUnlimited();
  if (!stripe || !basePrice) {
    return null;
  }

  const sub = await stripe.subscriptions.retrieve(input.subscriptionId, {
    expand: ["items.data.price"],
  });

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  let baseItemId: string | undefined;
  let logsItemId: string | undefined;

  for (const item of sub.items.data) {
    const priceId = typeof item.price === "string" ? item.price : item.price.id;
    if (priceId === stripePriceLogsUnlimited()) {
      logsItemId = item.id;
    } else {
      baseItemId = item.id;
    }
  }

  if (baseItemId) {
    items.push({ id: baseItemId, price: basePrice, quantity: Math.max(1, input.seatQuantity) });
  } else {
    items.push({ price: basePrice, quantity: Math.max(1, input.seatQuantity) });
  }

  if (input.logsUnlimited && logsPrice) {
    if (logsItemId) {
      items.push({ id: logsItemId, price: logsPrice, quantity: 1 });
    } else {
      items.push({ price: logsPrice, quantity: 1 });
    }
  } else if (logsItemId) {
    items.push({ id: logsItemId, deleted: true });
  }

  return stripe.subscriptions.update(input.subscriptionId, {
    items,
    proration_behavior: "create_prorations",
    metadata: {
      ...sub.metadata,
      plan_tier: input.planTier,
      logs_unlimited: input.logsUnlimited ? "true" : "false",
    },
  });
}
