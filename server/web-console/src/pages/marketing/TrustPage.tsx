import { Link } from "react-router-dom";
import trustData from "../../data/marketing/trustCenter.json";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight, IconCheck } from "../../icons";

const SALES_EMAIL = trustData.requestPacketEmail;

function statusLabel(status: string): string {
  if (status === "roadmap") return "Roadmap";
  if (status === "review") return "Agency review";
  if (status === "partial") return "Supported";
  return status;
}

function statusClass(status: string): string {
  if (status === "roadmap") return "trust-status trust-status-roadmap";
  if (status === "review") return "trust-status trust-status-review";
  return "trust-status trust-status-ok";
}

export function TrustPage() {
  const packetMailto = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(trustData.requestPacketSubject)}`;

  return (
    <MarketingLayout
      title="Trust Center"
      description="Security, privacy, compliance, and reliability documentation for safeT PTT public safety deployments."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-kicker">Trust Center</span>
            <h1>Security built for public safety procurement</h1>
            <p>{trustData.overview}</p>
            <div className="android-setup-hero-links">
              <a href={packetMailto} className="lp-btn lp-btn-primary lp-btn-lg">
                Request security packet <IconArrowRight size={16} />
              </a>
              <Link to="/security" className="lp-btn lp-btn-ghost lp-btn-lg">
                Security overview
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">At a glance</span>
          <h2>Reliability &amp; security highlights</h2>
        </div>
        <div className="trust-stats-grid">
          {trustData.reliabilityStats.map((stat) => (
            <article className="trust-stat-card" key={stat.label}>
              <div className="trust-stat-value">{stat.value}</div>
              <p>{stat.label}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Architecture</span>
          <h2>How we protect your agency</h2>
        </div>
        <div className="trust-pillars">
          {trustData.pillars.map((pillar) => (
            <article className="trust-pillar-card" key={pillar.id} id={pillar.id}>
              <h3>{pillar.title}</h3>
              <p>{pillar.summary}</p>
              <ul>
                {pillar.details.map((detail) => (
                  <li key={detail}>
                    <IconCheck size={14} /> {detail}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">Compliance</span>
          <h2>{trustData.compliance.title}</h2>
          <p>{trustData.compliance.intro}</p>
        </div>
        <div className="trust-compliance-grid">
          {trustData.compliance.items.map((item) => (
            <article className="trust-compliance-card" key={item.name}>
              <div className="trust-compliance-head">
                <h3>{item.name}</h3>
                <span className={statusClass(item.status)}>{statusLabel(item.status)}</span>
              </div>
              <p>{item.note}</p>
            </article>
          ))}
        </div>
        <p className="lp-section-cta">
          Need a questionnaire completed?{" "}
          <a href={packetMailto}>Email {SALES_EMAIL}</a> with your agency name and deadline.
        </p>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Operations</span>
          <h2>{trustData.operations.title}</h2>
          <p>{trustData.operations.intro}</p>
        </div>
        <div className="trust-ops-grid">
          {trustData.operations.items.map((item) => (
            <article className="trust-ops-card" key={item.label}>
              <h3>{item.label}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <h2>Industry-specific guidance</h2>
          <p>See how safeT maps to your agency type.</p>
        </div>
        <div className="industry-link-grid">
          <Link to="/industries/law-enforcement" className="support-link-card">
            <h3>Law enforcement</h3>
            <p>CJIS review, plate lookup, audit logs, and dispatch oversight.</p>
          </Link>
          <Link to="/industries/fire-ems" className="support-link-card">
            <h3>Fire &amp; EMS</h3>
            <p>Tone-outs, multi-channel dispatch, and incident comms.</p>
          </Link>
          <Link to="/industries/healthcare-security" className="support-link-card">
            <h3>Healthcare security</h3>
            <p>Hospital campus safety, emergency workflow, and retention.</p>
          </Link>
          <Link to="/industries/search-rescue-cert" className="support-link-card">
            <h3>Search &amp; rescue / CERT</h3>
            <p>Volunteer SAR and disaster response on rugged LTE handsets.</p>
          </Link>
          <Link to="/interoperability" className="support-link-card">
            <h3>Interoperability</h3>
            <p>LMR bridges, P25 ingest, stream feeds, and IMBE codec.</p>
          </Link>
        </div>
        <p className="lp-section-cta">
          Also see <Link to="/security">Security overview</Link> · <Link to="/faq">FAQ</Link>
        </p>
      </section>
    </MarketingLayout>
  );
}
