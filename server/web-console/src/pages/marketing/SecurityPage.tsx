import { MarketingLayout } from "./MarketingLayout";

export function SecurityPage() {
  return (
    <MarketingLayout
      title="Security"
      description="How safeT PTT protects your agency's voice and data."
    >
      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Security</span>
          <h1>Built for public safety</h1>
          <p>
            safeT PTT is a private enterprise platform — not a consumer walkie-talkie app. Your
            agency's data stays in your tenant.
          </p>
        </div>
        <div className="security-grid">
          <article>
            <h2>Encrypted voice relay</h2>
            <p>
              Every transmission travels over an authenticated, encrypted WebSocket relay. Handsets
              bind to your agency with a per-tenant radio key; accounts authenticate individually.
            </p>
          </article>
          <article>
            <h2>Multi-tenant isolation</h2>
            <p>
              Channels, users, recordings, alerts, and audit events are scoped to your agency. No
              cross-tenant data access is possible through the API.
            </p>
          </article>
          <article>
            <h2>Session control</h2>
            <p>
              Newest sign-in wins — if a handset is lost, signing in elsewhere immediately retires the
              old session so it cannot keep listening.
            </p>
          </article>
          <article>
            <h2>Data retention</h2>
            <p>
              All plans include 3 days of transmission logs. Agencies can add unlimited retention for
              $20/month. Retention sweeps run automatically on the server.
            </p>
          </article>
          <article>
            <h2>Payments</h2>
            <p>
              Card data is handled by Stripe — safeT never stores payment card numbers on our
              servers.
            </p>
          </article>
          <article>
            <h2>Important disclaimer</h2>
            <p>
              safeT PTT supplements — it does not replace — mission-critical Land Mobile Radio (LMR)
              systems. Agencies should maintain conventional radio backup for life-safety operations.
            </p>
          </article>
        </div>
      </section>
    </MarketingLayout>
  );
}
