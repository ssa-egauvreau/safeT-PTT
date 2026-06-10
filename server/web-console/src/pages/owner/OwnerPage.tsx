import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Topbar } from "../../Topbar";
import { api, describeError, type Agency } from "../../api";
import { AgencyUsersPanel } from "./AgencyUsersPanel";

/** Platform owner portal — provision agencies (tenants) and their first admins. */
export function OwnerPage() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealed, setRevealed] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function reload() {
    try {
      const res = await api.listAgencies();
      setAgencies(res.agencies);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createAgency({
        name: name.trim(),
        adminUsername: adminUsername.trim(),
        adminDisplayName: adminDisplayName.trim() || adminUsername.trim(),
        adminPassword,
      });
      setNotice(
        `Agency "${res.agency.name}" created. Radio key for handsets: ${res.agency.radio_key ?? "—"}`,
      );
      setName("");
      setAdminUsername("");
      setAdminDisplayName("");
      setAdminPassword("");
      setRevealed(res.agency.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  async function rename(agency: Agency) {
    const next = window.prompt("Agency name", agency.name);
    if (next == null || !next.trim() || next.trim() === agency.name) {
      return;
    }
    setError(null);
    try {
      await api.updateAgency(agency.id, { name: next.trim() });
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function toggleDisabled(agency: Agency) {
    setError(null);
    try {
      await api.updateAgency(agency.id, { disabled: !agency.disabled });
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function regenerateKey(agency: Agency) {
    if (
      !window.confirm(
        `Issue a new radio key for "${agency.name}"? Handsets using the old key will stop connecting until updated.`,
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateAgency(agency.id, { regenerateRadioKey: true });
      setRevealed(agency.id);
      setNotice(`New radio key for "${agency.name}": ${res.agency.radio_key ?? "—"}`);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function removeAgency(agency: Agency) {
    if (
      !window.confirm(
        `Delete agency "${agency.name}"? This permanently removes its users, channels, recordings and history. This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.deleteAgency(agency.id);
      if (expanded === agency.id) {
        setExpanded(null);
      }
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function copyKey(key: string) {
    void navigator.clipboard?.writeText(key);
    setNotice("Radio key copied to clipboard.");
  }

  return (
    <div className="app-shell">
      <Topbar section="owner" />

      <div className="admin-body">
        <main className="panel">
          <div className="panel-head">
            <h2>Agencies</h2>
            <span className="count">{agencies.length} total</span>
          </div>
          <p className="panel-desc">
            Each <strong>agency</strong> is an isolated tenant — its own users, channels, recordings and radio
            handsets. Create an agency here, then its administrator manages the rest from the Control portal.
          </p>

          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}

          <form className="card" onSubmit={onCreate}>
            <h3>Create agency</h3>
            <div className="form-row">
              <div className="field">
                <label>Agency name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="field">
                <label>Admin username</label>
                <input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} required />
              </div>
              <div className="field">
                <label>Admin display name</label>
                <input value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)} />
              </div>
              <div className="field">
                <label>Admin password</label>
                <input
                  type="text"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                />
              </div>
              <button className="btn primary" type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>

          {loading ? (
            <div className="empty">Loading…</div>
          ) : agencies.length === 0 ? (
            <div className="empty">No agencies yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Agency</th>
                  <th>Slug</th>
                  <th>Radio key</th>
                  <th>Plan</th>
                  <th>Billing</th>
                  <th>Users</th>
                  <th>Channels</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agencies.map((agency) => (
                  <Fragment key={agency.id}>
                    <tr>
                      <td>{agency.name}</td>
                      <td>
                        <code className="mono">{agency.slug}</code>
                      </td>
                      <td>
                        {agency.radio_key == null ? (
                          <span className="empty" style={{ padding: 0 }}>
                            —
                          </span>
                        ) : revealed === agency.id ? (
                          <span className="cell-actions">
                            <code className="mono">{agency.radio_key}</code>
                            <button className="btn sm" onClick={() => copyKey(agency.radio_key!)}>
                              Copy
                            </button>
                            <button className="btn sm" onClick={() => setRevealed(null)}>
                              Hide
                            </button>
                          </span>
                        ) : (
                          <span className="cell-actions">
                            <code className="mono">••••••••</code>
                            <button className="btn sm" onClick={() => setRevealed(agency.id)}>
                              Reveal
                            </button>
                          </span>
                        )}
                      </td>
                      <td>{agency.plan_tier ?? "—"}</td>
                      <td>
                        <span className="pill">{agency.subscription_status ?? "—"}</span>
                        {agency.trial_ends_at && (
                          <span className="muted" style={{ display: "block", fontSize: "0.75rem" }}>
                            trial {new Date(agency.trial_ends_at).toLocaleDateString()}
                          </span>
                        )}
                      </td>
                      <td>{agency.user_count ?? 0}</td>
                      <td>{agency.channel_count ?? 0}</td>
                      <td>
                        <span className={agency.disabled ? "pill off" : "pill on"}>
                          {agency.disabled ? "Disabled" : "Active"}
                        </span>
                      </td>
                      <td>
                        <div className="cell-actions">
                          <button className="btn sm" onClick={() => rename(agency)}>
                            Rename
                          </button>
                          <button className="btn sm" onClick={() => toggleDisabled(agency)}>
                            {agency.disabled ? "Enable" : "Disable"}
                          </button>
                          <button className="btn sm" onClick={() => regenerateKey(agency)}>
                            New key
                          </button>
                          <button
                            className="btn sm"
                            onClick={() => setExpanded(expanded === agency.id ? null : agency.id)}
                          >
                            {expanded === agency.id ? "Hide users" : "Users"}
                          </button>
                          <button className="btn sm danger" onClick={() => removeAgency(agency)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === agency.id && (
                      <tr>
                        <td colSpan={7}>
                          <AgencyUsersPanel agencyId={agency.id} agencyName={agency.name} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </main>
      </div>
    </div>
  );
}
