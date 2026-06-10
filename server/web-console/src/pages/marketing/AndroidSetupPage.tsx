import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import androidSetup from "../../data/marketing/androidSetup.json";
import { MarketingLayout } from "./MarketingLayout";
import { DeviceFrame } from "./DeviceFrame";
import { IconArrowRight, IconCheck } from "../../icons";

type SetupStep = {
  title: string;
  body: string;
  image?: string | null;
  imageAlt?: string | null;
  imageVariant?: "phone" | "browser";
  code?: string;
};

type SetupSection = {
  id: string;
  title: string;
  intro: string;
  device?: string;
  roadmap?: boolean;
  steps: SetupStep[];
};

function isExternalUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable */
    }
  }, [code]);

  return (
    <div className="setup-code-block">
      <div className="setup-code-block-head">
        <span>Command Prompt</span>
        <button type="button" className="lp-btn lp-btn-ghost setup-code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function StepBody({ step }: { step: SetupStep }) {
  const paragraphs = step.body.split(/\n\n+/);

  return (
    <>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 40)}>{paragraph}</p>
      ))}
      {step.code ? <CodeBlock code={step.code} /> : null}
    </>
  );
}

export function AndroidSetupPage() {
  const { software, sections } = androidSetup as {
    software: Array<{
      name: string;
      purpose: string;
      url: string;
      platforms: string;
      notes: string;
    }>;
    sections: SetupSection[];
  };

  const toc = sections.filter((section) => section.id !== "before-you-start");

  return (
    <MarketingLayout
      title="Android & Inrico setup guide"
      description="Step-by-step safeT Mobile install for Android phones, Inrico IRC590, and TM-7 Plus — with Vysor, ADB, and illustrated instructions."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-kicker">Handset setup</span>
            <h1>Install safeT Mobile on Android &amp; Inrico radios</h1>
            <p>
              This guide walks you through downloading the APK, sideloading the app, signing in, and
              configuring hardware keys on the Inrico IRC590 and TM-7 Plus. Every step includes a
              picture so you can match what you see on screen.
            </p>
            <div className="android-setup-hero-links">
              <a href="#software" className="lp-btn lp-btn-primary lp-btn-lg">
                Download links <IconArrowRight size={16} />
              </a>
              <Link to="/setup" className="lp-btn lp-btn-ghost lp-btn-lg">
                Agency setup guide
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-section-alt" id="software">
        <div className="lp-section-head">
          <span className="lp-kicker">Software you may need</span>
          <h2>Download links</h2>
          <p>
            Standard Android phones only need the safeT APK. Inrico radios benefit from Vysor or
            scrcpy for first-time login, and TM-7 Plus units often need Android Platform Tools (ADB)
            for hardware-key setup.
          </p>
        </div>
        <div className="software-grid">
          {software.map((item) => (
            <article className="software-card" key={item.name}>
              <h3>{item.name}</h3>
              <p className="software-purpose">{item.purpose}</p>
              <p className="software-platforms">
                <strong>Platforms:</strong> {item.platforms}
              </p>
              <p className="software-notes muted">{item.notes}</p>
              {isExternalUrl(item.url) ? (
                <a
                  href={item.url}
                  className="lp-btn lp-btn-primary"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download <IconArrowRight size={14} />
                </a>
              ) : (
                <Link to={item.url} className="lp-btn lp-btn-primary">
                  Get APK <IconArrowRight size={14} />
                </Link>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">On this page</span>
          <h2>Jump to a section</h2>
        </div>
        <nav className="android-setup-toc" aria-label="Setup sections">
          {toc.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
        </nav>
      </section>

      {sections.map((section) => (
        <section
          className={`lp-section android-setup-section${section.device ? ` android-setup-section-${section.device}` : ""}`}
          id={section.id}
          key={section.id}
        >
          <div className="lp-section-head">
            {section.device === "irc590" ? (
              <span className="lp-kicker device-kicker-irc590">Inrico IRC590</span>
            ) : section.device === "tm7" ? (
              <span className="lp-kicker device-kicker-tm7">Inrico TM-7 Plus</span>
            ) : section.roadmap ? (
              <span className="lp-kicker">
                Enterprise · <span className="trust-status trust-status-roadmap">In development</span>
              </span>
            ) : (
              <span className="lp-kicker">Setup</span>
            )}
            <h2>{section.title}</h2>
            <p>{section.intro}</p>
          </div>

          {section.steps.length > 0 ? (
            <ol className="setup-steps android-setup-steps">
              {section.steps.map((step, index) => {
                const variant =
                  step.imageVariant === "browser"
                    ? "browser"
                    : step.image
                      ? "phone"
                      : null;
                return (
                  <li
                    key={step.title}
                    className={
                      step.image
                        ? `setup-step android-setup-step setup-step--media setup-step--${variant}`
                        : "setup-step android-setup-step setup-step--copy-only"
                    }
                  >
                    <div className="setup-step-copy">
                      <span className="lp-step-num">{index + 1}</span>
                      <h3>{step.title}</h3>
                      <StepBody step={step} />
                    </div>
                    {step.image ? (
                      <div className="setup-step-visual">
                        <DeviceFrame
                          variant={variant === "browser" ? "browser" : "phone"}
                          src={step.image}
                          alt={step.imageAlt ?? step.title}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}

          {section.id === "before-you-start" ? (
            <ul className="android-setup-checklist">
              <li>
                <IconCheck size={16} /> Agency slug, username, and password from your administrator
              </li>
              <li>
                <IconCheck size={16} /> safeT Mobile APK file or download link
              </li>
              <li>
                <IconCheck size={16} /> USB cable (Inrico radios — for Vysor and TM-7 ADB setup)
              </li>
            </ul>
          ) : null}
        </section>
      ))}

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <h2>Need more help?</h2>
          <p>
            See <Link to="/devices">supported devices</Link>, browse the{" "}
            <Link to="/faq">FAQ</Link>, or visit <Link to="/support">support</Link>.
          </p>
        </div>
      </section>
    </MarketingLayout>
  );
}
