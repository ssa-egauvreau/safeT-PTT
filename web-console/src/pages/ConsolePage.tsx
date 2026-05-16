import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { api, describeError, type UserChannel } from "../api";

const PERMISSION_LABEL: Record<string, string> = {
  talk_priority: "Priority",
  talk: "Talk",
  listen_only: "Listen only",
};

export function ConsolePage() {
  const { user, logout } = useAuth();
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => setChannels(res.channels))
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          SECURITY RADIO <span>· Console</span>
        </div>
        <nav className="topnav">
          {user?.role === "admin" && <Link to="/admin">Admin Portal</Link>}
        </nav>
        <div className="who">
          <span className="role-chip">{user?.role}</span>
          <span>{user?.displayName}</span>
          <button className="btn sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <div className="console-grid">
        <div className="console-col">
          <h3>Channels</h3>
          {loading && <div className="empty">Loading…</div>}
          {error && <div className="banner error">{error}</div>}
          {!loading && !error && channels.length === 0 && (
            <div className="empty">No channels assigned to this account.</div>
          )}
          {channels.map((channel) => (
            <div className="chan-item" key={channel.id}>
              <span>{channel.name}</span>
              <span className="perm">{PERMISSION_LABEL[channel.permission] ?? channel.permission}</span>
            </div>
          ))}
        </div>

        <div className="console-col">
          <h3>Live Audio</h3>
          <div className="placeholder-box">
            <strong>Phase 2</strong>
            Listen to a channel and transmit from the browser. Per-user talk priority and listen-only
            permissions will be enforced on the relay.
          </div>
          <h3 style={{ marginTop: 24 }}>Transmission Log</h3>
          <div className="placeholder-box">
            <strong>Phase 3</strong>
            Recorded transmissions with user, time, channel, duration, playback/download, and a text
            transcript previewed before you hit play.
          </div>
        </div>

        <div className="console-col">
          <h3>Map &amp; Alerts</h3>
          <div className="placeholder-box">
            <strong>Phase 4</strong>
            Live GPS positions for every radio, plus emergency-alert and paging controls.
          </div>
        </div>
      </div>
    </div>
  );
}
