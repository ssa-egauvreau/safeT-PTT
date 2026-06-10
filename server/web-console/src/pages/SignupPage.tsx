import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, describeError, type PlanTier } from "../api";
import { MarketingLayout } from "./marketing/MarketingLayout";
import { SafetMark, IconArrowRight } from "../icons";

export function SignupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"email" | "form">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [planTier, setPlanTier] = useState<PlanTier>("basic");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onVerifyEmail(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifySignupEmail(email.trim());
      setNotice("Check your email for a 6-digit verification code.");
      setStep("form");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSignup(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.signup({
        agency_name: agencyName.trim(),
        admin_username: adminUsername.trim(),
        admin_display_name: adminDisplayName.trim() || adminUsername.trim(),
        admin_password: adminPassword,
        email: email.trim(),
        verification_code: code.trim(),
        plan_tier: planTier,
        accept_terms: acceptTerms,
      });
      setNotice(`Agency created! Sign in with agency "${res.agencySlug}" and username "${res.adminUsername}".`);
      navigate("/login", {
        state: { agencySlug: res.agencySlug, username: res.adminUsername },
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <MarketingLayout title="Start your free trial" description="Create your safeT PTT agency in minutes.">
      <section className="lp-section lp-signup">
        <div className="lp-signup-card">
          <div className="lp-signup-brand">
            <SafetMark size={36} />
            <h1>Start your 7-day free trial</h1>
            <p>No credit card required. Full access to safeT Mobile, Command, and Control.</p>
          </div>

          {error && <p className="lp-signup-error">{error}</p>}
          {notice && <p className="lp-signup-notice">{notice}</p>}

          {step === "email" ? (
            <form onSubmit={onVerifyEmail} className="lp-signup-form">
              <label>
                Work email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="chief@youragency.gov"
                  autoComplete="email"
                />
              </label>
              <button type="submit" className="lp-btn lp-btn-primary lp-btn-block" disabled={busy}>
                Send verification code <IconArrowRight size={15} />
              </button>
            </form>
          ) : (
            <form onSubmit={onSignup} className="lp-signup-form">
              <label>
                Verification code
                <input
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                />
              </label>
              <label>
                Agency name
                <input
                  required
                  value={agencyName}
                  onChange={(e) => setAgencyName(e.target.value)}
                  placeholder="Metro Police Department"
                />
              </label>
              <label>
                Admin username
                <input
                  required
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                />
              </label>
              <label>
                Display name
                <input
                  value={adminDisplayName}
                  onChange={(e) => setAdminDisplayName(e.target.value)}
                  placeholder="Radio Administrator"
                />
              </label>
              <label>
                Admin password
                <input
                  type="password"
                  required
                  minLength={8}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <fieldset className="lp-signup-plans">
                <legend>Plan</legend>
                <label className="lp-signup-plan">
                  <input
                    type="radio"
                    name="plan"
                    checked={planTier === "basic"}
                    onChange={() => setPlanTier("basic")}
                  />
                  <span>
                    <strong>Basic — $6.50/radio/mo</strong>
                    <small>PTT, dispatch console, admin panel</small>
                  </span>
                </label>
                <label className="lp-signup-plan">
                  <input
                    type="radio"
                    name="plan"
                    checked={planTier === "pro"}
                    onChange={() => setPlanTier("pro")}
                  />
                  <span>
                    <strong>Pro — $8.50/radio/mo</strong>
                    <small>Everything in Basic + AI dispatch</small>
                  </span>
                </label>
              </fieldset>
              <label className="lp-signup-terms">
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                />
                <span>
                  I agree to the{" "}
                  <Link to="/legal/terms" target="_blank">
                    Terms of Service
                  </Link>
                  ,{" "}
                  <Link to="/legal/privacy" target="_blank">
                    Privacy Policy
                  </Link>
                  , and{" "}
                  <Link to="/legal/eula" target="_blank">
                    EULA
                  </Link>
                  .
                </span>
              </label>
              <button type="submit" className="lp-btn lp-btn-primary lp-btn-block" disabled={busy || !acceptTerms}>
                Create agency <IconArrowRight size={15} />
              </button>
            </form>
          )}

          <p className="lp-signup-foot">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </MarketingLayout>
  );
}
