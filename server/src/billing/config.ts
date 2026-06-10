import type { PlanTier } from "./types.js";

/** Stripe and billing configuration from environment. */
export function billingEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}

export function stripeSecretKey(): string | null {
  return process.env.STRIPE_SECRET_KEY?.trim() || null;
}

export function stripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

export function stripePriceBasic(): string | null {
  return process.env.STRIPE_PRICE_BASIC?.trim() || null;
}

export function stripePricePro(): string | null {
  return process.env.STRIPE_PRICE_PRO?.trim() || null;
}

export function stripePriceLogsUnlimited(): string | null {
  return process.env.STRIPE_PRICE_LOGS_UNLIMITED?.trim() || null;
}

export function publicAppUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim();
  if (raw) {
    return raw.replace(/\/+$/, "");
  }
  return "https://safet-ptt.com";
}

export function priceIdForTier(tier: PlanTier): string | null {
  return tier === "pro" ? stripePricePro() : stripePriceBasic();
}

export function resendApiKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

export function billingFromEmail(): string {
  return process.env.BILLING_FROM_EMAIL?.trim() || "billing@safetptt.com";
}
