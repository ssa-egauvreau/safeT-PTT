import { Link } from "react-router-dom";
import interoperability from "../../data/marketing/interoperability.json";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight, IconCheck } from "../../icons";

export function InteroperabilityPage() {
  return (
    <MarketingLayout
      title="Interoperability & LMR integration"
      description="How safeT PTT works alongside Land Mobile Radio — stream bridges, audio bridges, P25 ingest tooling, and IMBE codec support."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-kicker">Interoperability</span>
            <h1>Works alongside your existing radio system</h1>
            <p>{interoperability.overview}</p>
            <p className="muted">{interoperability.disclaimer}</p>
            <div className="android-setup-hero-links">
              <Link to="/trust" className="lp-btn lp-btn-primary lp-btn-lg">
                Trust Center <IconArrowRight size={16} />
              </Link>
              <a href="mailto:sales@safetptt.com?subject=safeT%20PTT%20%E2%80%94%20Bridge%20consultation" className="lp-btn lp-btn-ghost lp-btn-lg">
                Bridge consultation
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">Signal path</span>
          <h2>How traffic flows</h2>
        </div>
        <ol className="interop-flow">
          {interoperability.diagram.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Bridge options</span>
          <h2>Three ways to connect LMR to safeT</h2>
        </div>
        <div className="interop-path-grid">
          {interoperability.paths.map((path) => (
            <article className="interop-path-card" key={path.id} id={path.id}>
              <h3>{path.title}</h3>
              <p>{path.summary}</p>
              <ul>
                {path.details.map((detail) => (
                  <li key={detail}>
                    <IconCheck size={14} /> {detail}
                  </li>
                ))}
              </ul>
              <p className="interop-audience">
                <strong>Best for:</strong> {path.audience}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt" id="codecs">
        <div className="lp-section-head">
          <span className="lp-kicker">Codecs</span>
          <h2>{interoperability.codecs.title}</h2>
          <p>{interoperability.codecs.intro}</p>
        </div>
        <div className="interop-codec-grid">
          {interoperability.codecs.items.map((codec) => (
            <article className="interop-codec-card" key={codec.id}>
              <h3>{codec.name}</h3>
              <p>{codec.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Roadmap</span>
          <h2>{interoperability.notYet.title}</h2>
        </div>
        <div className="trust-compliance-grid">
          {interoperability.notYet.items.map((item) => (
            <article className="trust-compliance-card" key={item.name}>
              <div className="trust-compliance-head">
                <h3>{item.name}</h3>
                <span className="trust-status trust-status-roadmap">In development</span>
              </div>
              <p>{item.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <h2>Related guides</h2>
        </div>
        <div className="industry-link-grid">
          <Link to="/devices" className="support-link-card">
            <h3>Supported devices</h3>
            <p>Android, Inrico IRC590, TM-7 Plus, and dispatch platforms.</p>
          </Link>
          <Link to="/setup/android" className="support-link-card">
            <h3>Android setup</h3>
            <p>Field handset install with pictures.</p>
          </Link>
          <Link to="/industries/fire-ems" className="support-link-card">
            <h3>Fire &amp; EMS</h3>
            <p>Tone-outs and multi-channel dispatch.</p>
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
