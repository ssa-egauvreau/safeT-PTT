import steps from "../../data/marketing/setupSteps.json";
import { MarketingLayout } from "./MarketingLayout";
import { DeviceFrame } from "./DeviceFrame";

export function SetupPage() {
  return (
    <MarketingLayout title="Setup guide" description="Step-by-step guide to deploying safeT PTT.">
      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Setup</span>
          <h1>From signup to first transmission</h1>
          <p>Follow these steps to put your agency on the air.</p>
        </div>
        <ol className="setup-steps">
          {steps.map((step) => (
            <li key={step.step} className="setup-step">
              <div className="setup-step-copy">
                <span className="lp-step-num">{step.step}</span>
                <h2>{step.title}</h2>
                <p>{step.body}</p>
              </div>
              <DeviceFrame variant="browser" src={step.image} alt={step.title} />
            </li>
          ))}
        </ol>
      </section>
    </MarketingLayout>
  );
}
