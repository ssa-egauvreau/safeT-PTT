import { useEffect, useState } from "react";
import { api, describeError, type AuditEntry } from "../../api";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatDetail(detail: unknown): string {
  if (detail == null) {
    return "";
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const res = await api.listAudit(300);
      setEntries(res.entries);
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

  return (
    <div>
      <div className="panel-head">
        <h2>Audit Log</h2>
        <span className="count">{entries.length} recent events</span>
      </div>
      <p className="panel-desc">
        Breadcrumbs for sign-ins and every administrative change. Newest first.
      </p>

      <div style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => void reload()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="empty">No audit events recorded yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Detail</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatTime(entry.ts)}</td>
                <td>{entry.actor_name ?? "—"}</td>
                <td>
                  <code className="mono">{entry.action}</code>
                </td>
                <td>{entry.target ?? "—"}</td>
                <td>
                  <code className="mono">{formatDetail(entry.detail)}</code>
                </td>
                <td>
                  <code className="mono">{entry.ip ?? "—"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
