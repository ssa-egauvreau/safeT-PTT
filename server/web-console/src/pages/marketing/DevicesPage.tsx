import { Link } from "react-router-dom";
import devicesData from "../../data/marketing/supportedDevices.json";
import { MarketingLayout } from "./MarketingLayout";
import { DeviceFrame } from "./DeviceFrame";
import { IconArrowRight, IconCheck } from "../../icons";

type DeviceStatus = "available" | "beta" | "coming_soon";

const STATUS_LABEL: Record<DeviceStatus, string> = {
  available: "Available",
  beta: "Beta / early access",
  coming_soon: "Coming soon",
};

function statusClass(status: string): string {
  if (status === "beta") return "device-status device-status-beta";
  if (status === "coming_soon") return "device-status device-status-soon";
  return "device-status device-status-ok";
}

export function DevicesPage() {
  const { hardware, platforms, browserMatrix } = devicesData;

  return (
    <MarketingLayout
      title="Supported devices & platforms"
      description="Android phones, Inrico IRC590 and TM7 Plus radios, iOS, Windows, macOS, Linux, and web browsers supported by safeT PTT."
    >
      <section className="lp-hero lp-hero-compact">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-kicker">Compatibility</span>
            <h1>Run safeT on the gear you have</h1>
            <p>
              Field units use safeT Mobile on Android phones and rugged Inrico handsets. Dispatch
              and admin run in any modern browser — or install the desktop shell on Windows, macOS,
              or Linux. iOS is in beta.
            </p>
            <Link to="/setup" className="lp-btn lp-btn-primary lp-btn-lg">
              Setup guide <IconArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Hardware</span>
          <h2>Rugged radios &amp; smartphones</h2>
          <p>One app — safeT Mobile — on every handset below.</p>
        </div>
        <div className="device-grid">
          {hardware.map((device) => (
            <article className="device-card" key={device.id}>
              <div className="device-card-visual">
                <DeviceFrame
                  variant={device.imageVariant === "phone" ? "phone" : "browser"}
                  src={device.image}
                  alt={device.name}
                />
              </div>
              <div className="device-card-body">
                <div className="device-card-head">
                  <h3>{device.name}</h3>
                  <span className={statusClass(device.status)}>{STATUS_LABEL[device.status as DeviceStatus] ?? device.status}</span>
                </div>
                {device.vendor && <p className="device-vendor">{device.vendor}</p>}
                <p>{device.summary}</p>
                <h4>Requirements</h4>
                <ul>
                  {device.requirements.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <h4>Highlights</h4>
                <ul className="device-features">
                  {device.features.map((f) => (
                    <li key={f}>
                      <IconCheck size={14} /> {f}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <span className="lp-kicker">Software platforms</span>
          <h2>Console, admin &amp; desktop</h2>
        </div>
        <div className="platform-grid">
          {platforms.map((platform) => (
            <article className="platform-card" key={platform.id}>
              <div className="platform-card-head">
                <h3>{platform.name}</h3>
                <span className={statusClass(platform.status)}>
                  {STATUS_LABEL[platform.status as DeviceStatus] ?? platform.status}
                </span>
              </div>
              <p className="platform-roles">{platform.roles.join(" · ")}</p>
              <p>{platform.summary}</p>
              <p className="platform-note muted">{platform.notes}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">Web browsers</span>
          <h2>Browser compatibility matrix</h2>
          <p>All web surfaces require a secure (HTTPS) connection to your safeT server.</p>
        </div>
        <div className="browser-matrix-wrap">
          <table className="browser-matrix">
            <thead>
              <tr>
                <th>Browser</th>
                <th>safeT Command</th>
                <th>safeT Control</th>
                <th>Soft radio</th>
              </tr>
            </thead>
            <tbody>
              {browserMatrix.map((row) => (
                <tr key={row.browser}>
                  <td>{row.browser}</td>
                  <td>{row.command ? "Yes" : "—"}</td>
                  <td>{row.control ? "Yes" : "Limited"}</td>
                  <td>{row.softRadio ? "Yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="lp-section-cta">
          Questions about a specific device? <Link to="/support">Visit support</Link> or{" "}
          <a href="mailto:sales@safetptt.com">contact sales</a>.
        </p>
      </section>
    </MarketingLayout>
  );
}
