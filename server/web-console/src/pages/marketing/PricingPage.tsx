import { Link } from "react-router-dom";
import { IconCheck, IconArrowRight } from "../../icons";
import { LOGS_ADDON, PLANS, ANNUAL_BILLING } from "../../data/marketing/pricing";
import { MarketingLayout } from "./MarketingLayout";

export function PricingPage() {
  return (
    <MarketingLayout
      title="Pricing"
      description="Simple per-radio pricing for safeT PTT. 7-day free trial, no credit card required."
    >
      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">Pricing</span>
          <h1>Pay for the radios you deploy</h1>
          <p>
            Monthly billing per radio/handset account. Dispatchers and admins are included. Start with
            a 7-day free trial — no credit card required.
          </p>
          <p className="pricing-annual-banner">
            <strong>Save {ANNUAL_BILLING.discountPercent}% with annual billing</strong> —{" "}
            {ANNUAL_BILLING.note}
          </p>
        </div>
        <div className="lp-plan-grid">
          {PLANS.map((plan) => {
            const annual = ANNUAL_BILLING.plans[plan.id];
            return (
              <article
                key={plan.id}
                className={plan.highlight ? "lp-plan-card lp-plan-featured" : "lp-plan-card"}
              >
                {plan.highlight && <span className="lp-plan-badge">AI dispatch</span>}
                <h3>{plan.name}</h3>
                <div className="lp-plan-price">
                  <span className="lp-plan-amount">{plan.price}</span>
                  <span className="lp-plan-unit">{plan.unit}</span>
                </div>
                <p className="pricing-annual-equiv">
                  or {annual.annualPerMonth}/radio/mo · {annual.annualTotal} {annual.unit}
                </p>
                <p className="lp-plan-blurb">{plan.blurb}</p>
                <ul className="lp-plan-features">
                  {plan.features.map((feat) => (
                    <li key={feat}>
                      <IconCheck size={15} /> {feat}
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/signup?plan=${plan.id}`}
                  className={
                    plan.highlight
                      ? "lp-btn lp-btn-primary lp-btn-block"
                      : "lp-btn lp-btn-ghost lp-btn-block"
                  }
                >
                  Start free trial <IconArrowRight size={15} />
                </Link>
              </article>
            );
          })}
        </div>
        <article className="lp-addon-card">
          <h3>{LOGS_ADDON.name}</h3>
          <div className="lp-plan-price">
            <span className="lp-plan-amount">{LOGS_ADDON.price}</span>
            <span className="lp-plan-unit">{LOGS_ADDON.unit}</span>
          </div>
          <p className="pricing-annual-equiv">
            or {ANNUAL_BILLING.logsAddon.annualTotal} {ANNUAL_BILLING.logsAddon.unit} (annual)
          </p>
          <p>{LOGS_ADDON.blurb}</p>
        </article>
        <p className="lp-pricing-note">
          Need volume pricing, multi-agency tenancy, purchase orders, or invoice billing?{" "}
          <a href="mailto:sales@safetptt.com">Contact sales</a>.
        </p>
      </section>
    </MarketingLayout>
  );
}
