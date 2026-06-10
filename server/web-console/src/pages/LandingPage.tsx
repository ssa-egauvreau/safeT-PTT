import { Link } from "react-router-dom";
import {
  IconBolt,
  IconRadio,
  IconShield,
  IconBeacon,
  IconAlertTriangle,
  IconMapPin,
  IconWaveform,
  IconLock,
  IconHeadphones,
  IconCheck,
  IconArrowRight,
  type IconProps,
} from "../icons";
import { LOGS_ADDON, PLANS, ANNUAL_BILLING } from "../data/marketing/pricing";
import trustData from "../data/marketing/trustCenter.json";
import customerStories from "../data/marketing/customerStories.json";
import { MarketingLayout } from "./marketing/MarketingLayout";
import { ScreenshotTabs } from "./marketing/ScreenshotTabs";

const SALES_EMAIL = "sales@safetptt.com";
const DEMO_MAILTO = `mailto:${SALES_EMAIL}?subject=safeT%20PTT%20—%20Demo%20request`;

const HERO_TABS = [
  {
    id: "mobile",
    label: "Mobile",
    variant: "phone" as const,
    src: "/marketing/screenshots/mobile-radio-portal.webp",
    alt: "Screenshot of safeT radio screen in mobile browser",
  },
  {
    id: "command",
    label: "Command",
    variant: "browser" as const,
    src: "/marketing/screenshots/command-console.webp",
    alt: "Screenshot of safeT Command dispatch console",
  },
  {
    id: "control",
    label: "Control",
    variant: "browser" as const,
    src: "/marketing/screenshots/control-users.webp",
    alt: "Screenshot of safeT Control admin panel",
  },
];

interface Surface {
  tag: string;
  name: string;
  blurb: string;
  href: string;
  Icon: (props: IconProps) => JSX.Element;
}

const SURFACES: Surface[] = [
  {
    tag: "Android handset",
    name: "safeT Mobile",
    href: "/mobile",
    blurb:
      "APX-style PTT for Android phones and rugged Inrico IRC590 / TM7 handsets with hardware PTT and emergency button.",
    Icon: IconRadio,
  },
  {
    tag: "Dispatch console",
    name: "safeT Command",
    href: "/command",
    blurb:
      "Monitor channels, live map, tone-outs, scan with priority, and searchable transmission log with transcripts.",
    Icon: IconBeacon,
  },
  {
    tag: "Admin",
    name: "safeT Control",
    href: "/control",
    blurb: "Users, channels, integrations, billing, audit log, and APK downloads for your agency.",
    Icon: IconShield,
  },
];

const FEATURES = [
  {
    name: "Instant push-to-talk",
    blurb: "Sub-second voice with per-channel talk-priority enforced server-side.",
    Icon: IconBolt,
  },
  {
    name: "Encrypted voice",
    blurb: "Authenticated encrypted relay. Newest sign-in wins so a lost phone cannot keep listening.",
    Icon: IconLock,
  },
  {
    name: "Live unit mapping",
    blurb: "GPS positions stream into the dispatch map before you send help.",
    Icon: IconMapPin,
  },
  {
    name: "Emergency alerts",
    blurb: "Priority alert to dispatch, channel flash, and air cleared for the unit in trouble.",
    Icon: IconAlertTriangle,
  },
  {
    name: "Searchable call history",
    blurb: "Recorded and auto-transcribed. Replay from the handset or search from the console.",
    Icon: IconWaveform,
  },
  {
    name: "Dispatch tone-outs",
    blurb: "Page a channel with routine, priority, or status tones.",
    Icon: IconHeadphones,
  },
];

const STEPS = [
  {
    n: "01",
    title: "Start your free trial",
    blurb: "Create your agency in minutes — 7 days free, no credit card required.",
  },
  {
    n: "02",
    title: "Build your channel plan",
    blurb: "Use safeT Control to create channels, add accounts, and assign units.",
  },
  {
    n: "03",
    title: "Deploy to the field",
    blurb: "Sideload safeT Mobile on Android or Inrico handsets. Soft radio in any browser.",
  },
  {
    n: "04",
    title: "Go live",
    blurb: "Dispatch opens Command, units key up, and you are operating.",
  },
];

export function LandingPage() {
  return (
    <MarketingLayout>
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">
              <IconBolt size={13} /> Push-to-talk for public safety
            </span>
            <h1>
              Your whole team on one channel — <span className="lp-accent">instantly.</span>
            </h1>
            <p className="lp-lede">
              safeT PTT turns Android phones and rugged handsets into a private encrypted radio
              network. Dispatch monitors every channel from one console. Start with a 7-day free
              trial.
            </p>
            <div className="lp-hero-actions">
              <Link to="/signup" className="lp-btn lp-btn-primary lp-btn-lg">
                Start free trial <IconArrowRight size={16} />
              </Link>
              <a href={DEMO_MAILTO} className="lp-btn lp-btn-ghost lp-btn-lg">
                Book a demo
              </a>
            </div>
            <div className="lp-hero-trust">
              <span>Built for</span>
              <strong>Police</strong>
              <i aria-hidden="true">·</i>
              <strong>Fire &amp; EMS</strong>
              <i aria-hidden="true">·</i>
              <strong>Private security</strong>
              <i aria-hidden="true">·</i>
              <strong>Campus safety</strong>
            </div>
          </div>
          <div className="lp-hero-art">
            <ScreenshotTabs tabs={HERO_TABS} />
            <p className="muted marketing-shot-note">
              Product screenshots from the live console. Mobile tab shows the browser soft radio;
              the native Android app uses the same talkgroups and PTT flow.
            </p>
          </div>
        </div>
      </section>

      <section className="lp-section lp-section-alt lp-stats-strip">
        <div className="trust-stats-grid trust-stats-home">
          {trustData.reliabilityStats.map((stat) => (
            <article className="trust-stat-card" key={stat.label}>
              <div className="trust-stat-value">{stat.value}</div>
              <p>{stat.label}</p>
            </article>
          ))}
        </div>
        <p className="lp-stats-footnote">
          <Link to="/trust">Trust Center</Link> — security packet available for procurement review.
        </p>
      </section>

      <section className="lp-section" id="stories">
        <div className="lp-section-head">
          <span className="lp-kicker">Agencies on safeT</span>
          <h2>What teams are saying</h2>
          <p className="muted">{customerStories.disclaimer}</p>
        </div>
        <div className="customer-stories-grid">
          {customerStories.stories.map((story) => (
            <blockquote className="customer-story-card" key={story.id}>
              <p className="customer-story-quote">&ldquo;{story.quote}&rdquo;</p>
              <footer>
                <strong>{story.role}</strong>
                <span>
                  {story.organization} · {story.vertical}
                </span>
                <span className="customer-story-highlight">{story.highlight}</span>
              </footer>
            </blockquote>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt" id="platform">
        <div className="lp-section-head">
          <span className="lp-kicker">The platform</span>
          <h2>Three surfaces, one radio network</h2>
        </div>
        <div className="lp-surface-grid">
          {SURFACES.map((s) => (
            <Link to={s.href} className="lp-surface-card lp-surface-card-link" key={s.name}>
              <div className="lp-surface-icon">
                <s.Icon size={24} />
              </div>
              <span className="lp-surface-tag">{s.tag}</span>
              <h3>{s.name}</h3>
              <p>{s.blurb}</p>
            </Link>
          ))}
        </div>
        <p className="lp-section-cta">
          <Link to="/industries/law-enforcement">Law enforcement</Link>
          {" · "}
          <Link to="/industries/fire-ems">Fire &amp; EMS</Link>
          {" · "}
          <Link to="/industries/healthcare-security">Healthcare security</Link>
          {" · "}
          <Link to="/industries/search-rescue-cert">SAR / CERT</Link>
          {" · "}
          <Link to="/interoperability">LMR interoperability</Link>
        </p>
      </section>

      <section className="lp-section lp-section-alt" id="features">
        <div className="lp-section-head">
          <span className="lp-kicker">Capabilities</span>
          <h2>Everything dispatch needs</h2>
        </div>
        <div className="lp-feature-grid">
          {FEATURES.map((f) => (
            <article className="lp-feature-card" key={f.name}>
              <div className="lp-feature-icon">
                <f.Icon size={20} />
              </div>
              <h3>{f.name}</h3>
              <p>{f.blurb}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section" id="how">
        <div className="lp-section-head">
          <span className="lp-kicker">Getting started</span>
          <h2>Live in four steps</h2>
        </div>
        <ol className="lp-steps">
          {STEPS.map((step) => (
            <li className="lp-step" key={step.n}>
              <span className="lp-step-num">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.blurb}</p>
            </li>
          ))}
        </ol>
        <p className="lp-section-cta">
          <Link to="/setup">Read the full setup guide →</Link>
        </p>
        <p className="lp-section-cta">
          <Link to="/devices">See supported devices &amp; platforms →</Link>
        </p>
      </section>

      <section className="lp-section lp-section-alt" id="pricing">
        <div className="lp-section-head">
          <span className="lp-kicker">Pricing</span>
          <h2>Simple per-radio pricing</h2>
          <p>Monthly billing. Dispatchers and admins included free. 7-day trial, no card required.</p>
          <p className="pricing-annual-banner pricing-annual-banner-compact">
            Save {ANNUAL_BILLING.discountPercent}% with annual billing —{" "}
            <Link to="/pricing">see pricing</Link>
          </p>
        </div>
        <div className="lp-plan-grid">
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              className={plan.highlight ? "lp-plan-card lp-plan-featured" : "lp-plan-card"}
            >
              {plan.highlight && <span className="lp-plan-badge">AI dispatch</span>}
              <h3>{plan.name}</h3>
              <div className="lp-plan-price">
                <span className="lp-plan-amount">{plan.price}</span>
                <span className="lp-plan-unit">{plan.unit}</span>
              </div>
              <p className="lp-plan-blurb">{plan.blurb}</p>
              <ul className="lp-plan-features">
                {plan.features.slice(0, 6).map((feat) => (
                  <li key={feat}>
                    <IconCheck size={15} /> {feat}
                  </li>
                ))}
              </ul>
              <Link
                to={`/signup?plan=${plan.id}`}
                className={
                  plan.highlight
                    ? "lp-btn lp-btn-primary lp-btn-block"
                    : "lp-btn lp-btn-ghost lp-btn-block"
                }
              >
                Start free trial
              </Link>
            </article>
          ))}
        </div>
        <p className="lp-pricing-addon">
          {LOGS_ADDON.name}: {LOGS_ADDON.price} {LOGS_ADDON.unit} — {LOGS_ADDON.blurb}
        </p>
        <p className="lp-pricing-note">
          <Link to="/pricing">See full pricing</Link> · <Link to="/login">Sign in</Link>
        </p>
      </section>

      <section className="lp-cta">
        <div className="lp-cta-inner">
          <h2>Ready to put your team on the air?</h2>
          <p>Start your 7-day free trial today — no credit card required.</p>
          <div className="lp-hero-actions">
            <p className="muted marketing-shot-note">
              Screenshots show the live product interface. The mobile view above is the browser soft
              radio; the native Android APK uses the same channels and PTT workflow on handsets.
            </p>
            <a href={`mailto:${SALES_EMAIL}`} className="lp-btn lp-btn-ghost lp-btn-lg">
              Contact sales
            </a>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
