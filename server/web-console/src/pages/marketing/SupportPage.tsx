import { Link } from "react-router-dom";
import issues from "../../data/marketing/troubleshooting.json";
import { MarketingLayout } from "./MarketingLayout";

const SALES_EMAIL = "sales@safetptt.com";

export function SupportPage() {
  return (
    <MarketingLayout title="Support" description="Get help with safeT PTT.">
      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Support</span>
          <h1>We are here to help</h1>
          <p>
            Start with the guides below. For account issues or enterprise deployments, email{" "}
            <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>.
          </p>
        </div>
        <div className="support-links">
          <Link to="/setup" className="support-link-card">
            <h3>Setup guide</h3>
            <p>Step-by-step agency provisioning and handset deployment.</p>
          </Link>
          <Link to="/setup/android" className="support-link-card">
            <h3>Android &amp; Inrico setup</h3>
            <p>APK install, Vysor, IRC590 and TM-7 Plus hardware keys — with pictures.</p>
          </Link>
          <Link to="/faq" className="support-link-card">
            <h3>FAQ</h3>
            <p>Billing, hardware, security, and common questions.</p>
          </Link>
          <Link to="/devices" className="support-link-card">
            <h3>Supported devices</h3>
            <p>Inrico IRC590, TM7 Plus, Android, iOS, Windows, browser, and more.</p>
          </Link>
          <Link to="/trust" className="support-link-card">
            <h3>Trust Center</h3>
            <p>Security architecture, compliance status, and security packet requests.</p>
          </Link>
          <Link to="/interoperability" className="support-link-card">
            <h3>Interoperability</h3>
            <p>LMR bridges, P25 stream ingest, and codec options.</p>
          </Link>
          <Link to="/security" className="support-link-card">
            <h3>Security</h3>
            <p>Encryption, tenancy, and data retention.</p>
          </Link>
          <Link to="/updates" className="support-link-card">
            <h3>Product updates</h3>
            <p>Release notes and changelog.</p>
          </Link>
        </div>
        <h2 className="support-h2">Troubleshooting</h2>
        <div className="troubleshoot-grid">
          {issues.map((issue) => (
            <article key={issue.title} className="troubleshoot-card">
              <h3>{issue.title}</h3>
              <p className="muted">{issue.symptoms}</p>
              <ul>
                {issue.fixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </MarketingLayout>
  );
}
