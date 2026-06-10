import { Link, Navigate, useParams } from "react-router-dom";
import industriesData from "../../data/marketing/industries.json";
import { MarketingLayout } from "./MarketingLayout";
import { DeviceFrame } from "./DeviceFrame";
import { IconArrowRight, IconCheck } from "../../icons";

type IndustryPage = (typeof industriesData.pages)[number];

function findIndustry(slug: string | undefined): IndustryPage | undefined {
  return industriesData.pages.find((page) => page.slug === slug);
}

export function IndustryPage() {
  const { slug } = useParams<{ slug: string }>();
  const page = findIndustry(slug);

  if (!page) {
    return <Navigate to="/devices" replace />;
  }

  const mailto = `mailto:sales@safetptt.com?subject=${encodeURIComponent(`safeT PTT — ${page.title} demo`)}`;

  return (
    <MarketingLayout title={page.title} description={page.metaDescription}>
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner industry-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-kicker">{page.kicker}</span>
            <h1>{page.headline}</h1>
            <p>{page.intro}</p>
            <div className="android-setup-hero-links">
              <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">
                Start free trial <IconArrowRight size={16} />
              </Link>
              <a href={mailto} className="lp-btn lp-btn-ghost lp-btn-lg">
                Book a demo
              </a>
            </div>
          </div>
          <div className="industry-hero-visual">
            <DeviceFrame
              variant={page.heroImageVariant === "phone" ? "phone" : "browser"}
              src={page.heroImage}
              alt={page.headline}
            />
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Use cases</span>
          <h2>Built for {page.title.toLowerCase()} workflows</h2>
        </div>
        <div className="industry-use-grid">
          {page.useCases.map((useCase) => (
            <article className="industry-use-card" key={useCase.title}>
              <h3>{useCase.title}</h3>
              <p>{useCase.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">Capabilities</span>
          <h2>What you get</h2>
        </div>
        <ul className="industry-feature-list">
          {page.features.map((feature) => (
            <li key={feature}>
              <IconCheck size={16} /> {feature}
            </li>
          ))}
        </ul>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Compliance</span>
          <h2>Before you deploy</h2>
        </div>
        <p className="industry-compliance-note">{page.complianceNote}</p>
        <p className="lp-section-cta">
          <Link to="/trust">Visit the Trust Center</Link> ·{" "}
          <a href="mailto:sales@safetptt.com?subject=safeT%20PTT%20%E2%80%94%20Security%20packet%20request">
            Request security packet
          </a>
        </p>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <h2>{page.cta}</h2>
        </div>
        <div className="android-setup-hero-links industry-cta-row">
          <Link to="/signup" className="lp-btn lp-btn-primary">
            Start free trial
          </Link>
          <Link to="/devices" className="lp-btn lp-btn-ghost">
            Supported devices
          </Link>
          <Link to="/setup/android" className="lp-btn lp-btn-ghost">
            Android setup guide
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
