import { Link } from "react-router-dom";
import steps from "../../data/marketing/setupSteps.json";
import { MarketingLayout } from "./MarketingLayout";
import { DeviceFrame } from "./DeviceFrame";
import { IconArrowRight } from "../../icons";

export function SetupPage() {
  return (
    <MarketingLayout title="Setup guide" description="Step-by-step guide to deploying safeT PTT.">
      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Setup</span>
          <h1>From signup to first transmission</h1>
          <p>Follow these steps to put your agency on the air.</p>
          <p className="setup-android-callout">
            Installing on Android phones or Inrico IRC590 / TM-7 Plus radios?{" "}
            <Link to="/setup/android" className="lp-inline-link">
              Open the detailed Android setup guide <IconArrowRight size={14} />
            </Link>
          </p>
        </div>
        <ol className="setup-steps">
          {steps.map((step) => {
            const variant = step.imageVariant === "phone" ? "phone" : "browser";
            return (
              <li
                key={step.step}
                className={`setup-step setup-step--media setup-step--${variant}`}
              >
                <div className="setup-step-copy">
                  <span className="lp-step-num">{step.step}</span>
                  <h2>{step.title}</h2>
                  <p>{step.body}</p>
                </div>
                <div className="setup-step-visual">
                  <DeviceFrame variant={variant} src={step.image} alt={step.title} />
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </MarketingLayout>
  );
}
