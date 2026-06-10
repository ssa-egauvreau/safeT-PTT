import { useCallback, useEffect, useState } from "react";
import { api, describeError, type BillingStatus, type PlanTier } from "../../api";

export function BillingPanel() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planTier, setPlanTier] = useState<PlanTier>("basic");
  const [logsUnlimited, setLogsUnlimited] = useState(false);

  const reload = useCallback(async () => {
    try {
      const s = await api.getBillingStatus();
      setStatus(s);
      setPlanTier(s.plan_tier);
      setLogsUnlimited(s.logs_unlimited);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startBillingCheckout(planTier, logsUnlimited);
      window.location.href = res.url;
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openBillingPortal();
      window.location.href = res.url;
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function savePlan() {
    setBusy(true);
    setError(null);
    try {
      await api.updateBillingPlan(planTier, logsUnlimited);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="muted">Loading billing…</p>;
  }

  const trialActive =
    status?.subscription_status === "trialing" &&
    status.trial_days_left != null &&
    status.trial_days_left > 0;

  return (
    <div className="billing-panel">
      <h2>Billing &amp; subscription</h2>
      <p className="muted">
        Radio/handset accounts are billed per seat. Dispatchers and admins are included at no extra
        charge.
      </p>

      {error && <p className="error">{error}</p>}

      {status?.agency_disabled && (
        <div className="billing-alert billing-alert-warn">
          <strong>Account suspended.</strong> Your trial has ended or payment failed. Add a payment
          method to restore service.
        </div>
      )}

      {trialActive && (
        <div className="billing-alert billing-alert-info">
          <strong>{status.trial_days_left} day(s) left</strong> in your free trial.
        </div>
      )}

      <dl className="billing-stats">
        <div>
          <dt>Plan</dt>
          <dd>{status?.plan_tier === "pro" ? "Pro ($8.50/radio/mo)" : "Basic ($6.50/radio/mo)"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{status?.subscription_status ?? "—"}</dd>
        </div>
        <div>
          <dt>Billable radios</dt>
          <dd>{status?.billable_seats ?? 0}</dd>
        </div>
        <div>
          <dt>Transmission logs</dt>
          <dd>{status?.logs_unlimited ? "Unlimited ($20/mo add-on)" : "3 days included"}</dd>
        </div>
      </dl>

      <fieldset className="billing-options">
        <legend>Change plan</legend>
        <label>
          <input
            type="radio"
            checked={planTier === "basic"}
            onChange={() => setPlanTier("basic")}
          />
          Basic — $6.50 per radio / month
        </label>
        <label>
          <input type="radio" checked={planTier === "pro"} onChange={() => setPlanTier("pro")} />
          Pro — $8.50 per radio / month (includes AI dispatch)
        </label>
        <label>
          <input
            type="checkbox"
            checked={logsUnlimited}
            onChange={(e) => setLogsUnlimited(e.target.checked)}
          />
          Unlimited transmission logs — $20 / month (flat per agency)
        </label>
      </fieldset>

      <div className="billing-actions">
        {status?.billing_configured ? (
          <>
            {status.subscription_status === "trialing" || status.subscription_status === "canceled" ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void openCheckout()}>
                Add payment method
              </button>
            ) : null}
            {status.portal_available ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void openPortal()}>
                Manage billing &amp; invoices
              </button>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={() => void savePlan()}>
              Save plan changes
            </button>
          </>
        ) : (
          <p className="muted">
            Stripe billing is not configured on this server. Contact your platform operator.
          </p>
        )}
      </div>
    </div>
  );
}
