import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import {
  SafetMark,
  IconBolt,
  IconRadio,
  IconShield,
  IconBeacon,
  IconAlertTriangle,
  IconMapPin,
  IconWaveform,
  IconLock,
  IconHeadphones,
  IconUser,
  IconCheck,
  IconArrowRight,
  type IconProps,
} from "../icons";

const SALES_EMAIL = "sales@safetptt.com";
const DEMO_MAILTO = `mailto:${SALES_EMAIL}?subject=safeT%20PTT%20—%20Demo%20request`;

interface Surface {
  tag: string;
  name: string;
  blurb: string;
  Icon: (props: IconProps) => JSX.Element;
}

const SURFACES: Surface[] = [
  {
    tag: "Android handset",
    name: "safeT Mobile",
    blurb:
      "A rugged APX-style radio app for the field. Hardware PTT key, instant channel changes, and a one-press emergency button — on the phones your team already carries.",
    Icon: IconRadio,
  },
  {
    tag: "Dispatch console",
    name: "safeT Command",
    blurb:
      "The web console where dispatch lives: monitor every channel, see units on a live map, tone-out pages, and review the full transmission log.",
    Icon: IconBeacon,
  },
  {
    tag: "Admin panel",
    name: "safeT Control",
    blurb:
      "Provision accounts, build channel plans, assign units, and audit every action — all from one secured admin surface.",
    Icon: IconShield,
  },
];

interface Feature {
  name: string;
  blurb: string;
  Icon: (props: IconProps) => JSX.Element;
}

const FEATURES: Feature[] = [
  {
    name: "Instant push-to-talk",
    blurb: "Sub-second voice across your whole agency. Talkgroups, scan, and priority channels work the way radio teams expect.",
    Icon: IconBolt,
  },
  {
    name: "Encrypted voice",
    blurb: "Every transmission is carried over an authenticated, encrypted relay. Per-account sign-in — no shared passwords.",
    Icon: IconLock,
  },
  {
    name: "Live unit mapping",
    blurb: "GPS positions stream into the dispatch map so you always know where each unit is before you send help.",
    Icon: IconMapPin,
  },
  {
    name: "Emergency alerts",
    blurb: "A dedicated emergency button pushes a priority alert to dispatch and clears the channel for the unit in trouble.",
    Icon: IconAlertTriangle,
  },
  {
    name: "Recording & transcripts",
    blurb: "Calls are recorded and transcribed automatically, so the transmission log is searchable for review and reporting.",
    Icon: IconWaveform,
  },
  {
    name: "Dispatch tone-outs",
    blurb: "Page a channel with routine, priority, or status tones — the same workflow your dispatchers run on a real console.",
    Icon: IconHeadphones,
  },
];

interface Step {
  n: string;
  title: string;
  blurb: string;
}

const STEPS: Step[] = [
  {
    n: "01",
    title: "Request access",
    blurb: "Tell us about your agency and team size. We set up your private safeT PTT tenant — usually within a business day.",
  },
  {
    n: "02",
    title: "Build your channel plan",
    blurb: "An admin uses safeT Control to create channels, add accounts, and assign units to the people who need them.",
  },
  {
    n: "03",
    title: "Deploy to the field",
    blurb: "Install the safeT Mobile APK on your Android devices. Each member signs in with their own account — no radio hardware to buy.",
  },
  {
    n: "04",
    title: "Go live",
    blurb: "Dispatch opens safeT Command, units key up, and you're operating. Support stays with you as you scale.",
  },
];

interface Plan {
  name: string;
  price: string;
  unit: string;
  blurb: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}

const PLANS: Plan[] = [
  {
    name: "Patrol",
    price: "$18",
    unit: "per radio / month",
    blurb: "For small teams and single-site operations getting started with managed push-to-talk.",
    features: [
      "Up to 25 radios",
      "Unlimited talkgroups",
      "safeT Mobile + Command",
      "Emergency button & alerts",
      "30-day call recording",
      "Email support",
    ],
    cta: "Request access",
    href: DEMO_MAILTO,
  },
  {
    name: "Department",
    price: "$29",
    unit: "per radio / month",
    blurb: "For agencies running active dispatch that need mapping, history, and faster support.",
    features: [
      "Up to 250 radios",
      "Everything in Patrol",
      "Live GPS unit mapping",
      "Recording + auto-transcripts",
      "1-year searchable call history",
      "Priority support & onboarding",
    ],
    cta: "Request access",
    href: DEMO_MAILTO,
    highlight: true,
  },
  {
    name: "Agency",
    price: "Custom",
    unit: "volume pricing",
    blurb: "For multi-site agencies and enterprise security operations with compliance needs.",
    features: [
      "Unlimited radios",
      "Everything in Department",
      "SSO & dedicated infrastructure",
      "Audit log exports & retention controls",
      "Uptime SLA",
      "Named account manager",
    ],
    cta: "Talk to sales",
    href: DEMO_MAILTO,
  },
];

export function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <Link to="/" className="lp-brand" aria-label="safeT PTT home">
            <SafetMark size={30} />
            <span className="lp-brand-word">
              safe<b>T</b>
            </span>
            <span className="lp-brand-tag">PTT</span>
          </Link>
          <nav className="lp-nav-links">
            <a href="#platform">Platform</a>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="lp-nav-cta">
            {user ? (
              <Link to="/console" className="lp-btn lp-btn-primary">
                Open console <IconArrowRight size={15} />
              </Link>
            ) : (
              <>
                <Link to="/login" className="lp-btn lp-btn-ghost">
                  Sign in
                </Link>
                <a href="#pricing" className="lp-btn lp-btn-primary">
                  Get started
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
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
                safeT PTT turns the Android phones your officers already carry into a private,
                encrypted radio network. Dispatch monitors every channel, sees units on a live map,
                and answers emergencies from one console.
              </p>
              <div className="lp-hero-actions">
                <a href="#pricing" className="lp-btn lp-btn-primary lp-btn-lg">
                  Get started <IconArrowRight size={16} />
                </a>
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
            <div className="lp-hero-art" aria-hidden="true">
              <div className="lp-handset">
                <div className="lp-handset-strip">
                  <span className="lp-dot lp-dot-live" /> GREEN 1
                  <span className="lp-handset-rssi">
                    <i /> <i /> <i /> <i />
                  </span>
                </div>
                <div className="lp-handset-display">
                  <div className="lp-handset-channel">GREEN 1</div>
                  <div className="lp-handset-sub">Patrol — Citywide</div>
                  <div className="lp-handset-talker">
                    <IconUser size={14} /> Unit 412 · transmitting
                  </div>
                </div>
                <div className="lp-handset-keys">
                  <span>SCAN</span>
                  <span>ZONE</span>
                  <span>MENU</span>
                </div>
                <div className="lp-handset-ptt">
                  <IconBolt size={20} /> PUSH TO TALK
                </div>
                <div className="lp-handset-emerg">
                  <IconAlertTriangle size={15} /> EMERGENCY
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section" id="platform">
          <div className="lp-section-head">
            <span className="lp-kicker">The platform</span>
            <h2>Three surfaces, one radio network</h2>
            <p>
              safeT PTT is a private enterprise platform — not a consumer app. The handset, the
              dispatch console, and the admin panel all run on the same secure backbone.
            </p>
          </div>
          <div className="lp-surface-grid">
            {SURFACES.map((s) => (
              <article className="lp-surface-card" key={s.name}>
                <div className="lp-surface-icon">
                  <s.Icon size={24} />
                </div>
                <span className="lp-surface-tag">{s.tag}</span>
                <h3>{s.name}</h3>
                <p>{s.blurb}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-section lp-section-alt" id="features">
          <div className="lp-section-head">
            <span className="lp-kicker">Capabilities</span>
            <h2>Everything dispatch needs to run the air</h2>
            <p>
              Radio-grade workflows without radio-grade hardware budgets. Every feature is built for
              the field and for the console at the same time.
            </p>
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
            <h2>From request to live in four steps</h2>
            <p>
              There's no hardware to procure and no towers to lease. Most agencies are operating on
              safeT PTT within a week.
            </p>
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
        </section>

        <section className="lp-section lp-section-alt" id="pricing">
          <div className="lp-section-head">
            <span className="lp-kicker">Pricing</span>
            <h2>Simple per-radio pricing</h2>
            <p>
              Pay for the radios you deploy — billed annually. No setup fees, no hardware contracts.
              Every plan includes the Mobile app, the Command console, and the Control admin panel.
            </p>
          </div>
          <div className="lp-plan-grid">
            {PLANS.map((plan) => (
              <article
                className={plan.highlight ? "lp-plan-card lp-plan-featured" : "lp-plan-card"}
                key={plan.name}
              >
                {plan.highlight && <span className="lp-plan-badge">Most popular</span>}
                <h3>{plan.name}</h3>
                <div className="lp-plan-price">
                  <span className="lp-plan-amount">{plan.price}</span>
                  <span className="lp-plan-unit">{plan.unit}</span>
                </div>
                <p className="lp-plan-blurb">{plan.blurb}</p>
                <ul className="lp-plan-features">
                  {plan.features.map((feat) => (
                    <li key={feat}>
                      <IconCheck size={15} /> {feat}
                    </li>
                  ))}
                </ul>
                <a
                  href={plan.href}
                  className={
                    plan.highlight
                      ? "lp-btn lp-btn-primary lp-btn-block"
                      : "lp-btn lp-btn-ghost lp-btn-block"
                  }
                >
                  {plan.cta}
                </a>
              </article>
            ))}
          </div>
          <p className="lp-pricing-note">
            Already running safeT PTT?{" "}
            <Link to="/login">Sign in to your console</Link>.
          </p>
        </section>

        <section className="lp-cta">
          <div className="lp-cta-inner">
            <h2>Ready to put your team on the air?</h2>
            <p>
              Tell us about your agency and we'll stand up a private safeT PTT tenant for you to
              trial — typically within one business day.
            </p>
            <div className="lp-hero-actions">
              <a href={DEMO_MAILTO} className="lp-btn lp-btn-primary lp-btn-lg">
                Request access <IconArrowRight size={16} />
              </a>
              <a href={`mailto:${SALES_EMAIL}`} className="lp-btn lp-btn-ghost lp-btn-lg">
                Contact sales
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <SafetMark size={26} />
            <span className="lp-brand-word">
              safe<b>T</b>
            </span>
          </div>
          <p className="lp-footer-tag">Talk · Transmit · Together</p>
          <nav className="lp-footer-links">
            <a href="#platform">Platform</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link to="/login">Sign in</Link>
            <a href={`mailto:${SALES_EMAIL}`}>Contact</a>
          </nav>
        </div>
        <div className="lp-footer-fine">
          © {new Date().getFullYear()} safeT PTT — Private enterprise push-to-talk for public safety.
        </div>
      </footer>
    </div>
  );
}
