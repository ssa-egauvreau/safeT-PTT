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
        Values saved here apply only to <strong>your agency</strong>. Other agencies on this server
        use their own keys. License plate, VIN, and similar lookup tools will use slots under{" "}
        <strong>Lookups</strong> when those features ship in the portal.
      </p>

      {error && <p className="error">{error}</p>}

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
