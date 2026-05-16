import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type Alert, type UserChannel } from "../api";

type AlertKind = "page" | "emergency";

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AlertsPanel() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [kind, setKind] = useState<AlertKind>("page");
  const [channelName, setChannelName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function refresh() {
    try {
      const res = await api.alerts();
      setAlerts(res.alerts);
    } catch {
      /* keep last snapshot */
    }
  }

  useEffect(() => {
    api
      .myChannels()
      .then((res) => setChannels(res.channels))
      .catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (kind === "page" && !message.trim()) {
      setError("Enter a page message.");
      return;
    }
    setSending(true);
    try {
      await api.sendAlert({ kind, channelName: channelName || null, message: message.trim() || null });
      setMessage("");
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  async function clear(id: number) {
    setError(null);
    try {
      await api.clearAlert(id);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const activeEmergencies = alerts.filter((a) => a.kind === "emergency" && a.active);
  const history = alerts.filter((a) => !(a.kind === "emergency" && a.active));

  return (
    <div className="alerts-panel">
      <h3>Alerts &amp; Paging</h3>

      {activeEmergencies.map((alert) => (
        <div className="alert-row emergency" key={alert.id}>
          <div className="alert-body">
            <strong>EMERGENCY</strong> · {alert.from_unit || alert.from_name || "Unknown"}
            <div className="alert-sub">
              {alert.channel_name ?? "All channels"} · {formatTime(alert.created_at)}
            </div>
            {alert.message && <div className="alert-msg">{alert.message}</div>}
          </div>
          <button className="btn sm" onClick={() => clear(alert.id)}>
            Clear
          </button>
        </div>
      ))}

      <form className="alert-send" onSubmit={send}>
        {error && <div className="banner error">{error}</div>}
        <div className="alert-send-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
            <option value="page">Page</option>
            <option value="emergency">Emergency</option>
          </select>
          <select value={channelName} onChange={(e) => setChannelName(e.target.value)}>
            <option value="">All channels</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.name}>
                {channel.name}
              </option>
            ))}
          </select>
        </div>
        <input
          placeholder={kind === "page" ? "Page message" : "Note (optional)"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={sending}>
          {sending ? "Sending…" : kind === "emergency" ? "Broadcast emergency" : "Send page"}
        </button>
      </form>

      <div className="alert-history">
        {history.length === 0 && <div className="empty">No recent alerts.</div>}
        {history.map((alert) => (
          <div className={alert.active ? "alert-row" : "alert-row done"} key={alert.id}>
            <div className="alert-body">
              <strong>{alert.kind === "emergency" ? "Emergency" : "Page"}</strong> ·{" "}
              {alert.channel_name ?? alert.target_unit ?? "All channels"}
              <div className="alert-sub">
                {alert.from_name || alert.from_unit || "—"} · {formatTime(alert.created_at)}
                {!alert.active && alert.cleared_by ? ` · cleared by ${alert.cleared_by}` : ""}
              </div>
              {alert.message && <div className="alert-msg">{alert.message}</div>}
            </div>
            {alert.active && (
              <button className="btn sm" onClick={() => clear(alert.id)}>
                Clear
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
