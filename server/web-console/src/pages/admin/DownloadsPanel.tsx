import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError, type AndroidAppRelease } from "../../api";

// Where the Windows installer for the desktop console (safeT Command) is
// published as a GitHub Actions artifact. See .github/workflows/desktop-build.yml
// — every push under desktop-console/** (and any manual workflow_dispatch)
// produces a `safeT-Command-Windows-Installer` artifact attached to the run.
// Linking to the workflow page lets an admin grab the latest installer
// without us having to mirror the binary on the server.
const DESKTOP_DOWNLOADS_URL =
  "https://github.com/ssa-egauvreau/safeT-PTT/actions/workflows/desktop-build.yml";

/** Admin: download links for the Android handset app and the desktop console. */
export function DownloadsPanel() {
  return (
    <div className="android-app-panel">
      <h2>Downloads</h2>
      <p className="muted android-app-lead">
        Installers for the safeT apps. The Android build is published by the server
        and updates handsets automatically; the desktop console is built by CI and
        downloaded from GitHub.
      </p>

      <AndroidDownloadSection />
      <DesktopDownloadSection />
    </div>
  );
}

/** Android APK section — was the old AndroidAppPanel. Behaviour unchanged. */
function AndroidDownloadSection() {
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
    <section className="downloads-section">
      <h3 className="downloads-section-title">Android handset app</h3>
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
        <div className="card-like android-app-card">
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
        </div>
      )}
    </section>
  );
}

/** Desktop console download — links out to the GitHub Actions workflow page
 *  where the Windows installer is published as an artifact. We don't mirror
 *  the installer on the server (yet), so the link goes directly to where
 *  CI puts it. */
function DesktopDownloadSection() {
  return (
    <section className="downloads-section">
      <h3 className="downloads-section-title">Desktop console (safeT Command)</h3>
      <p className="muted android-app-lead">
        The desktop console is the same web dispatcher wrapped in a native
        window — useful on dispatch workstations that need it pinned, audio
        permissions persisted, and no browser tab to lose. A Windows installer
        is built automatically by CI and published to GitHub.
      </p>

      <div className="card-like android-app-card">
        <div className="android-app-version">
          <span className="android-app-version-label">Latest CI build</span>
          <strong className="android-app-version-name">Windows installer (.exe)</strong>
        </div>

        <p className="android-app-notes muted" style={{ fontSize: "0.92rem" }}>
          Click below to open the build page on GitHub, then download the
          installer attached to the most recent successful run. Sign in to
          GitHub first if you're prompted.
        </p>

        <div className="android-app-download">
          <a
            className="btn primary android-app-dl-btn"
            href={DESKTOP_DOWNLOADS_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open desktop downloads page
          </a>
        </div>

        <details className="android-app-install">
          <summary>Where the installer is on the GitHub page</summary>
          <ol>
            <li>Click the topmost workflow run with a green check mark.</li>
            <li>Scroll to the bottom of that run page until you see <strong>Artifacts</strong>.</li>
            <li>Click <strong>safeT-Command-Windows-Installer</strong> to download a zip.</li>
            <li>Unzip it and double-click the <strong>.exe</strong> inside to install.</li>
          </ol>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.75rem" }}>
            macOS and Linux builds are not yet published by CI — run
            <code> npm run dist:mac </code>or<code> npm run dist:linux </code>
            inside <code>desktop-console/</code> to build them locally.
          </p>
        </details>
      </div>
    </section>
  );
}
