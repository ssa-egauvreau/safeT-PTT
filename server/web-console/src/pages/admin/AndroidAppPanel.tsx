import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError, type AndroidAppRelease } from "../../api";

/** Admin: download link and version info for the fleet Android radio app. */
export function AndroidAppPanel() {
  const [release, setRelease] = useState<AndroidAppRelease | null>(null);
  const [unpublished, setUnpublished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    setUnpublished(false);
    try {
      const res = await api.getAndroidAppRelease();
      setRelease(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setRelease(null);
        setUnpublished(true);
      } else {
        setError(describeError(err));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const apkUrl = useMemo(() => {
    if (!release?.url) return "";
    const path = release.url.startsWith("/") ? release.url : `/${release.url}`;
    return `${window.location.origin}${path}`;
  }, [release?.url]);

  async function copyLink() {
    if (!apkUrl) return;
    try {
      await navigator.clipboard.writeText(apkUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link and copy manually.");
    }
  }

  return (
    <div className="android-app-panel">
      <h2>Android radio app</h2>
      <p className="muted android-app-lead">
        Download the latest <strong>safeT</strong> APK for IRC590, TM-7 Plus, and other fleet
        handsets. Radios that already have a release-signed build will also pick this up
        automatically when they open the app.
      </p>

      {loading && <p className="muted">Checking for a published build…</p>}
      {error && <div className="banner error">{error}</div>}

      {!loading && unpublished && (
        <div className="card-like android-app-card">
          <p className="muted">No APK is published on this server yet.</p>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            After an Android build is published to Railway, refresh this page.
          </p>
          <button type="button" className="btn sm" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
      )}

      {!loading && release && (
        <section className="card-like android-app-card">
          <div className="android-app-version">
            <span className="android-app-version-label">Published version</span>
            <strong className="android-app-version-name">
              {release.versionName}
            </strong>
            <span className="muted">(build {release.versionCode})</span>
          </div>

          {release.notes && (
            <p className="android-app-notes">
              <span className="muted">Release notes: </span>
              {release.notes}
            </p>
          )}

          <div className="android-app-download">
            <a className="btn primary android-app-dl-btn" href={apkUrl} download>
              Download APK
            </a>
            <button type="button" className="btn sm" onClick={() => void copyLink()}>
              {copied ? "Copied" : "Copy download link"}
            </button>
          </div>

          <p className="android-app-url muted">
            <span>Link for the radio browser: </span>
            <a href={apkUrl} className="android-app-url-link">
              {apkUrl}
            </a>
          </p>

          <details className="android-app-install">
            <summary>Install steps on the handset</summary>
            <ol>
              <li>Open Chrome (or any browser) on the radio.</li>
              <li>Paste the download link above, or tap <strong>Download APK</strong> on a PC and transfer the file.</li>
              <li>When the download finishes, open the file and allow install if Android asks.</li>
              <li>Reboot the radio once after installing.</li>
            </ol>
            <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.75rem" }}>
              First time switching to a release-signed APK: uninstall the old app, then install
              this one. After that, updates install over the air.
            </p>
          </details>

          <button type="button" className="btn sm" style={{ marginTop: "12px" }} onClick={() => void reload()}>
            Refresh version
          </button>
        </section>
      )}
    </div>
  );
}
