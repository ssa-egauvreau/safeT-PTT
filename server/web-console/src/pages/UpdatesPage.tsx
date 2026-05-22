import { useEffect } from "react";
import { Link } from "react-router-dom";
import { SafetMark } from "../icons";
import updatesJson from "../data/productUpdates.json";

export type ProductUpdate = {
  version: string;
  date: string;
  title: string;
  changes: string[];
};

const UPDATES = updatesJson as ProductUpdate[];

function formatUpdateDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function UpdatesPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="lp lp-updates">
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
            <Link to="/updates" className="is-active">
              Updates
            </Link>
            <Link to="/legal/terms">Legal</Link>
          </nav>
          <div className="lp-nav-cta">
            <Link to="/login" className="lp-btn lp-btn-ghost">
              Sign in
            </Link>
            <Link to="/" className="lp-btn lp-btn-primary">
              Home
            </Link>
          </div>
        </div>
      </header>

      <main className="lp-updates-main">
        <header className="lp-updates-intro">
          <h1>Product updates</h1>
          <p>
            Each release lists a <strong>version</strong>, <strong>date</strong>, and what changed in
            plain language. Newest updates are first.
          </p>
        </header>

        <ol className="lp-updates-list">
          {UPDATES.map((entry) => (
            <li key={`${entry.version}-${entry.date}`} className="lp-update-card">
              <div className="lp-update-meta">
                <span className="lp-update-version">Version {entry.version}</span>
                <time className="lp-update-date" dateTime={entry.date}>
                  {formatUpdateDate(entry.date)}
                </time>
              </div>
              <h2 className="lp-update-title">{entry.title}</h2>
              <ul className="lp-update-changes">
                {entry.changes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
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
            <Link to="/updates">Updates</Link>
            <Link to="/legal/terms">Terms</Link>
            <Link to="/legal/privacy">Privacy</Link>
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
