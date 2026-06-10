import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useAuth } from "../../auth";
import { SafetMark, IconArrowRight } from "../../icons";

const SALES_EMAIL = "sales@safetptt.com";

interface MarketingLayoutProps {
  children: React.ReactNode;
  title?: string;
  description?: string;
}

export function MarketingLayout({
  children,
  title = "safeT PTT — Push-to-talk for public safety",
  description = "Private, encrypted push-to-talk for police, fire, EMS, and security teams.",
}: MarketingLayoutProps) {
  const { user } = useAuth();
  const pageTitle = title.includes("safeT") ? title : `${title} — safeT PTT`;

  return (
    <div className="lp">
      <Helmet>
        <title>{pageTitle}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
      </Helmet>

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
            <Link to="/mobile">Mobile</Link>
            <Link to="/command">Command</Link>
            <Link to="/control">Control</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/faq">FAQ</Link>
            <Link to="/setup">Setup</Link>
            <Link to="/support">Support</Link>
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
                <Link to="/signup" className="lp-btn lp-btn-primary">
                  Start free trial
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main>{children}</main>

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
            <Link to="/mobile">Mobile</Link>
            <Link to="/command">Command</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/faq">FAQ</Link>
            <Link to="/setup">Setup</Link>
            <Link to="/support">Support</Link>
            <Link to="/security">Security</Link>
            <Link to="/updates">Updates</Link>
            <Link to="/legal/terms">Terms</Link>
            <Link to="/legal/privacy">Privacy</Link>
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
