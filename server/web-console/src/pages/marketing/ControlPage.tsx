import { Link } from "react-router-dom";
import { FeatureShowcase } from "./FeatureShowcase";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight } from "../../icons";

export function ControlPage() {
  return (
    <MarketingLayout
      title="safeT Control"
      description="Agency admin panel for users, channels, integrations, and billing."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">Admin panel</span>
            <h1>Provision and govern your network</h1>
            <p>
              Create accounts, build channel plans, manage integrations, review audit logs, and
              handle billing — all from safeT Control.
            </p>
            <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">
              Start free trial <IconArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>
      <FeatureShowcase
        kicker="Administration"
        title="Users, channels &amp; billing"
        body="Add radio and dispatcher accounts, assign channel permissions, upload custom tones, and manage your subscription from one place."
        bullets={[
          "Per-channel permission templates",
          "Ten-8 CAD & webhook integrations",
          "APK downloads for field deployment",
        ]}
        imageSrc="/marketing/control-admin.svg"
        imageAlt="safeT Control admin"
        variant="browser"
      />
    </MarketingLayout>
  );
}
