import { useEffect, useState } from "react";
import { api, describeError, type IntegrationItem, type IntegrationsPayload } from "../../api";

/** Per-agency API keys and webhooks. Platform AI dispatcher master switch lives in Railway env. */
export function IntegrationsPanel() {
  const [data, setData] = useState<IntegrationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getIntegrations();
      setData(res);
      setDrafts({});
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function saveItem(item: IntegrationItem) {
    if (item.availability !== "active") {
      return;
    }
    setBusyKey(item.key);
    setError(null);
    try {
      const value = drafts[item.key] ?? "";
      const res = await api.setIntegration(item.key, value);
      setData(res);
      setDrafts((d) => {
        const next = { ...d };
        delete next[item.key];
        return next;
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function clearItem(item: IntegrationItem) {
    if (!window.confirm(`Remove the saved value for "${item.label}"?`)) {
      return;
    }
    setBusyKey(item.key);
    setError(null);
    try {
      const res = await api.setIntegration(item.key, "");
      setData(res);
      setDrafts((d) => {
        const next = { ...d };
        delete next[item.key];
        return next;
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  }

  if (loading && !data) {
    return <p className="muted">Loading integrations…</p>;
  }

  const platform = data?.platform;

  return (
    <div className="integrations-panel">
      <h2>Integrations</h2>
      <p className="muted" style={{ maxWidth: "52rem" }}>
        Values saved here apply only to <strong>your agency</strong>. Plate/VIN keys power 912
        readbacks on the radio.
      </p>

      <section
        className="card-like"
        style={{ marginBottom: "1.25rem", maxWidth: "52rem", padding: "1rem 1.25rem" }}
      >
        <h3 style={{ marginTop: 0, fontSize: "1rem" }}>10-8 Systems — where each key goes</h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          If you migrated from the old <strong>10-8 alert dashboard</strong> Railway project, you
          likely have <strong>two API key pairs</strong> plus a <strong>webhook bearer</strong>.
          Paste them into the sections below (not Railway).
        </p>
        <table style={{ width: "100%", fontSize: "0.88rem", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #444" }}>
                Old Railway name
              </th>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #444" }}>
                Put it here (Integrations)
              </th>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #444" }}>
                Used for
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                <code>WEBHOOK_SECRET</code>
              </td>
              <td style={{ padding: "6px 8px" }}>
                <strong>Webhooks</strong> → 10-8 incident export bearer token
              </td>
              <td style={{ padding: "6px 8px" }}>
                10-8 pushes new/updated calls to safeT. In 10-8 admin, set URL to{" "}
                <code>/v1/webhooks/10-8?agency=YOUR_AGENCY_SLUG</code>
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                <code>TEN8_API_KEY</code> + <code>TEN8_API_SECRET</code>
              </td>
              <td style={{ padding: "6px 8px" }}>
                <strong>10-8 CAD API</strong> → key + secret (v1.0.8)
              </td>
              <td style={{ padding: "6px 8px" }}>
                Read pending/active calls, look up incidents, post AI comments to CAD
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                <code>TEN8_NEW_INCIDENT_API_KEY</code> + <code>TEN8_NEW_INCIDENT_API_SECRET</code>
              </td>
              <td style={{ padding: "6px 8px" }}>
                <strong>10-8 New Incident API</strong> → key + secret
              </td>
              <td style={{ padding: "6px 8px" }}>
                Create brand-new CAD incidents (self-dispatch / CFS). Different host than the v1.0.8
                pair.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {error && <p className="error">{error}</p>}

      <LocationKeyCard />

      {data?.prompt_source === "sunset_bundled" && (
        <p className="muted" style={{ marginBottom: "1rem", maxWidth: "52rem" }}>
          Your agency uses the <strong>built-in Sunset Safety dispatcher prompt</strong> from the
          10-8 AI dashboard. Leave the system prompt box empty to keep it, or paste a custom prompt
          to override.
        </p>
      )}

      {platform && (
        <section className="integrations-platform card-like" style={{ marginBottom: "1.25rem" }}>
          <h3>AI dispatcher (this server)</h3>
          <p className="muted">{data?.platform_note}</p>
          <ul className="integrations-status-list">
            <li>
              Master switch:{" "}
              <strong>{platform.enabled ? "ON (Railway)" : "OFF (Railway)"}</strong>
            </li>
            <li>
              LLM API key: <strong>{platform.llmConfigured ? "Configured" : "Not set"}</strong>
            </li>
            <li>
              Model: <code>{platform.model}</code>
            </li>
            <li>
              Radio unit ID for AI traffic: <code>{platform.dispatchUnitId}</code>
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            Your hosting operator sets variables such as <code>AI_DISPATCH_ENABLED</code>,{" "}
            <code>AI_DISPATCH_LLM_API_KEY</code>, and <code>AI_DISPATCH_LLM_MODEL</code> on Railway.
            ElevenLabs keys below are per agency.
          </p>
        </section>
      )}

      {data?.groups.map((group) => (
        <section key={group.id} className="integrations-group" style={{ marginBottom: "1.5rem" }}>
          <h3>{group.label}</h3>
          {group.items.map((item) => (
            <IntegrationRow
              key={item.key}
              item={item}
              draft={drafts[item.key]}
              busy={busyKey === item.key}
              onDraftChange={(v) => setDrafts((d) => ({ ...d, [item.key]: v }))}
              onSave={() => void saveItem(item)}
              onClear={() => void clearItem(item)}
            />
          ))}
        </section>
      ))}

      <button type="button" className="btn secondary" onClick={() => void reload()} disabled={loading}>
        Refresh
      </button>
    </div>
  );
}

/**
 * Read-only location-feed key for external map integrations (e.g. a parking /
 * patrol console plotting radio positions). The key authenticates only the
 * GET /locations + /locations/history endpoints — never PTT, admin, or any
 * write — so it's safe to hand to a third-party server.
 */
function LocationKeyCard() {
  const [key, setKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .getLocationKey()
      .then((res) => {
        if (alive) {
          setKey(res.location_read_key);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(describeError(err));
        }
      })
      .finally(() => {
        if (alive) {
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  async function rotate() {
    const verb = key ? "Rotate" : "Generate";
    if (key && !window.confirm("Rotate the location key? The current key stops working immediately.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.rotateLocationKey();
      setKey(res.location_read_key);
      setReveal(true);
    } catch (err) {
      setError(`${verb} failed: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke the location key? Any external map using it loses access. Handsets are unaffected.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.revokeLocationKey();
      setKey(null);
      setReveal(false);
    } catch (err) {
      setError(`Revoke failed: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!key) {
      return;
    }
    void navigator.clipboard?.writeText(key).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }

  return (
    <section className="card-like" style={{ marginBottom: "1.5rem", maxWidth: "52rem", padding: "1rem 1.25rem" }}>
      <h3 style={{ marginTop: 0, fontSize: "1rem" }}>Location feed key (external maps)</h3>
      <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}>
        A <strong>read-only</strong> key an outside system (e.g. a patrol / parking map) uses to pull
        your radios' live GPS positions server-side. It unlocks only the location endpoints —{" "}
        <strong>never PTT, admin, or any change</strong> — and is separate from your handset radio
        key, so revoking it here never disturbs handsets. The consumer sends it as the{" "}
        <code>X-SafeT-Location-Key</code> header against{" "}
        <code>/v1/locations</code> and <code>/v1/locations/history</code>.
      </p>

      {error && <p className="error">{error}</p>}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : key ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              type={reveal ? "text" : "password"}
              className="input"
              readOnly
              value={key}
              style={{ width: "100%", maxWidth: "28rem", fontFamily: "monospace" }}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn secondary" onClick={() => setReveal((v) => !v)}>
              {reveal ? "Hide" : "Reveal"}
            </button>
            <button type="button" className="btn secondary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void rotate()}>
              {busy ? "Working…" : "Rotate"}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void revoke()}>
              Revoke
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => void rotate()}>
          {busy ? "Generating…" : "Generate key"}
        </button>
      )}
    </section>
  );
}

function IntegrationRow(props: {
  item: IntegrationItem;
  draft: string | undefined;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const { item, draft, busy, onDraftChange, onSave, onClear } = props;
  const comingSoon = item.availability === "coming_soon";
  const inputType = item.kind === "secret" ? "password" : item.kind === "url" ? "url" : "text";
  const isMultiline = item.kind === "multiline";

  return (
    <div
      className="integration-row"
      style={{
        border: "1px solid var(--border, #333)",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
        opacity: comingSoon ? 0.65 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong>{item.label}</strong>
        {comingSoon && <span className="muted">Coming soon</span>}
        {!comingSoon && item.configured && (
          <span className="muted">
            Saved {item.display_value ? `(${item.display_value})` : ""}
          </span>
        )}
      </div>
      <p className="muted" style={{ margin: "0.35rem 0 0.6rem", fontSize: "0.9rem" }}>
        {item.description}
      </p>
      {!comingSoon && (
        <>
          {isMultiline ? (
            <textarea
              className="input"
              rows={10}
              style={{ width: "100%", maxWidth: "42rem", fontFamily: "inherit" }}
              placeholder={item.placeholder ?? "Agency-specific 10-codes, call signs, tone…"}
              value={draft ?? ""}
              onChange={(e) => onDraftChange(e.target.value)}
              autoComplete="off"
            />
          ) : (
            <input
              type={inputType}
              className="input"
              style={{ width: "100%", maxWidth: "32rem" }}
              placeholder={
                item.configured && item.kind === "secret"
                  ? "Leave blank to keep current; paste new value to replace"
                  : item.placeholder ?? ""
              }
              value={draft ?? ""}
              onChange={(e) => onDraftChange(e.target.value)}
              autoComplete="off"
            />
          )}
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={busy} onClick={onSave}>
              {busy ? "Saving…" : "Save"}
            </button>
            {item.configured && (
              <button type="button" className="btn secondary" disabled={busy} onClick={onClear}>
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
