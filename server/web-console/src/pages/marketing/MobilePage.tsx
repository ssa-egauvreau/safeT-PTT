import { Link } from "react-router-dom";
import { FeatureShowcase } from "./FeatureShowcase";
import { MarketingLayout } from "./MarketingLayout";
import { IconArrowRight } from "../../icons";

export function MobilePage() {
  return (
    <MarketingLayout
      title="safeT Mobile"
      description="APX-style push-to-talk for Android phones and rugged Inrico handsets."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">Android handset</span>
            <h1>Radio-grade PTT in your pocket</h1>
            <p>
              safeT Mobile turns the phones your team already carries — or rugged Inrico IRC590 and
              TM7 handsets — into a private encrypted radio.
            </p>
            <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">
              Start free trial <IconArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>
      <FeatureShowcase
        kicker="Field operations"
        title="Instant push-to-talk"
        body="Sub-second voice with per-channel talk priority, scan lists, and emergency button that clears the air and alerts dispatch."
        bullets={[
          "Hardware PTT on Inrico IRC590 & TM7",
          "Encrypted voice over cellular or Wi-Fi",
          "Replay recent transmissions on the handset",
        ]}
        imageSrc="/marketing/screenshots/mobile-radio-portal.webp"
        imageAlt="Screenshot of safeT radio screen in mobile browser"
        variant="phone"
      />
      <p className="muted marketing-shot-note lp-section-note">
        Screenshot shows the browser soft radio at phone size. The native safeT Mobile APK on
        Android and Inrico handsets uses the same channels, scan lists, and PTT controls.
      </p>
      <FeatureShowcase
        reverse
        kicker="Live config"
        title="Changes push to every radio"
        body="Update channels, assignments, or talk priority from Control and every handset picks it up live — no reboot required."
        imageSrc="/marketing/screenshots/control-users.webp"
        imageAlt="Admin panel"
        variant="browser"
      />
    </MarketingLayout>
  );
}
