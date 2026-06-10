import { Link } from "react-router-dom";
import trustData from "../../data/marketing/trustCenter.json";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight } from "../../icons";

const SALES_EMAIL = trustData.requestPacketEmail;
const packetMailto = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(trustData.requestPacketSubject)}`;

export function SecurityPage() {
  const highlights = trustData.pillars.slice(0, 6);

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
            agency&apos;s data stays in your tenant. For procurement questionnaires and full
            documentation, visit the{" "}
            <Link to="/trust" className="lp-inline-link">
              Trust Center
            </Link>
            .
          </p>
          <div className="android-setup-hero-links">
            <Link to="/trust" className="lp-btn lp-btn-primary">
              Full Trust Center <IconArrowRight size={14} />
            </Link>
            <a href={packetMailto} className="lp-btn lp-btn-ghost">
              Request security packet
            </a>
          </div>
        </div>

        <div className="trust-stats-grid trust-stats-compact">
          {trustData.reliabilityStats.map((stat) => (
            <article className="trust-stat-card" key={stat.label}>
              <div className="trust-stat-value">{stat.value}</div>
              <p>{stat.label}</p>
            </article>
          ))}
        </div>

        <div className="security-grid">
          {highlights.map((pillar) => (
            <article key={pillar.id}>
              <h2>{pillar.title}</h2>
              <p>{pillar.summary}</p>
            </article>
          ))}
        </div>

        <p className="lp-section-cta">
          <Link to="/trust">Read compliance status, operations, and architecture details →</Link>
        </p>
      </section>
    </MarketingLayout>
  );
}
