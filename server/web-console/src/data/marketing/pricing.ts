export interface PricingPlan {
  id: "basic" | "pro";
  name: string;
  price: string;
  unit: string;
  blurb: string;
  features: string[];
  highlight?: boolean;
}

export const PLANS: PricingPlan[] = [
  {
    id: "basic",
    name: "Basic",
    price: "$6.50",
    unit: "per radio / month",
    blurb: "Everything you need to run a private push-to-talk network.",
    features: [
      "safeT Mobile for Android & Inrico handsets",
      "safeT Command dispatch console",
      "safeT Control admin panel",
      "Encrypted voice & emergency alerts",
      "Live GPS mapping",
      "3-day transmission log retention",
      "Dispatchers & admins included free",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$8.50",
    unit: "per radio / month",
    blurb: "Basic plus AI dispatch for automated CAD workflows.",
    features: [
      "Everything in Basic",
      "AI dispatch per channel",
      "Plate lookup & knowledge base",
      "Ten-8 CAD integration",
      "AI activity log & dry-run testing",
    ],
    highlight: true,
  },
];

export const LOGS_ADDON = {
  name: "Unlimited logs",
  price: "$20",
  unit: "per agency / month",
  blurb: "Keep every transmission and transcript indefinitely instead of the included 3-day window.",
};

/** Annual billing — 15% discount vs paying monthly × 12. */
export const ANNUAL_BILLING = {
  discountPercent: 15,
  note: "Save 15% when you pay annually per radio. Contact sales to switch an existing subscription or request a quote.",
  plans: {
    basic: {
      monthly: "$6.50",
      annualPerMonth: "$5.53",
      annualTotal: "$66.30",
      unit: "per radio / year",
    },
    pro: {
      monthly: "$8.50",
      annualPerMonth: "$7.23",
      annualTotal: "$86.70",
      unit: "per radio / year",
    },
  },
  logsAddon: {
    monthly: "$20",
    annualTotal: "$204",
    unit: "per agency / year",
  },
};
