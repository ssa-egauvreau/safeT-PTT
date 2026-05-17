import { useEffect } from "react";
import { Link } from "react-router-dom";
import { SafetMark } from "../../icons";
import { Markdown } from "./Markdown";
// The legal documents live at the repo root and are the single source of truth;
// they are imported as raw markdown and rendered client-side.
import termsSource from "../../../../../legal/TERMS_OF_SERVICE.md?raw";
import privacySource from "../../../../../legal/PRIVACY_POLICY.md?raw";
import eulaSource from "../../../../../legal/EULA.md?raw";

export type LegalDocId = "terms" | "privacy" | "eula";

interface LegalDoc {
  label: string;
  path: string;
  file: string;
  source: string;
}

const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  terms: { label: "Terms of Service", path: "/legal/terms", file: "TERMS_OF_SERVICE.md", source: termsSource },
  privacy: { label: "Privacy Policy", path: "/legal/privacy", file: "PRIVACY_POLICY.md", source: privacySource },
  eula: { label: "EULA", path: "/legal/eula", file: "EULA.md", source: eulaSource },
};

const LEGAL_ORDER: LegalDocId[] = ["terms", "privacy", "eula"];

// The documents reference one another by filename; map those to their routes
// so the renderer turns the references into in-app links.
const LEGAL_XREFS: Record<string, string> = Object.fromEntries(
  LEGAL_ORDER.map((id) => [LEGAL_DOCS[id].file, LEGAL_DOCS[id].path]),
);

export function LegalPage({ doc }: { doc: LegalDocId }) {
  const entry = LEGAL_DOCS[doc];

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [doc]);

  return (
    <div className="lp lp-legal">
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
            {LEGAL_ORDER.map((id) => (
              <Link key={id} to={LEGAL_DOCS[id].path} className={id === doc ? "is-active" : undefined}>
                {LEGAL_DOCS[id].label}
              </Link>
            ))}
          </nav>
          <div className="lp-nav-cta">
            <Link to="/" className="lp-btn lp-btn-ghost">
              Back to home
            </Link>
          </div>
        </div>
      </header>

      <main className="lp-legal-main">
        <article className="lp-legal-doc">
          <Markdown source={entry.source} links={LEGAL_XREFS} />
        </article>
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
            <Link to="/">Home</Link>
            {LEGAL_ORDER.map((id) => (
              <Link key={id} to={LEGAL_DOCS[id].path}>
                {LEGAL_DOCS[id].label}
              </Link>
            ))}
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
        <div className="lp-footer-fine">
          © {new Date().getFullYear()} safeT PTT — Private enterprise push-to-talk for public safety.
        </div>
      </footer>
    </div>
  );
}
