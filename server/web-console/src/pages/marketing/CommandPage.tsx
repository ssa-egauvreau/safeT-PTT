import { Link } from "react-router-dom";
import { FeatureShowcase } from "./FeatureShowcase";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight } from "../../icons";

export function CommandPage() {
  return (
    <MarketingLayout
      title="safeT Command"
      description="Web dispatch console with live map, transmission log, and tone-outs."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">Dispatch console</span>
            <h1>Run the air from one screen</h1>
            <p>
              Monitor every channel, see units on a live map, tone-out pages, scan with priority,
              and search the full transmission log with auto-transcripts.
            </p>
            <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">
              Start free trial <IconArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>
      <FeatureShowcase
        kicker="Situational awareness"
        title="Live map &amp; transmission log"
        body="GPS positions stream into the dispatch map. Every call is recorded and transcribed — replay any message or search history from the console."
        bullets={[
          "Channel roster with RX/TX indicators",
          "Emergency workflow with acknowledge & resolve",
          "Mission Control multi-channel dashboard",
        ]}
        imageSrc="/marketing/screenshots/command-console.webp"
        imageAlt="safeT Command dispatch console"
        variant="browser"
      />
    </MarketingLayout>
  );
}
