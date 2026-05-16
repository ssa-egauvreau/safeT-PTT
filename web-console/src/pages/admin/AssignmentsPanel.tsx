import { useEffect, useState } from "react";
import { api, describeError, type AdminUser, type Channel, type Membership, type Permission } from "../../api";

type CellValue = Permission | "none";

const OPTIONS: { value: CellValue; label: string }[] = [
  { value: "none", label: "— none —" },
  { value: "listen_only", label: "Listen only" },
  { value: "talk", label: "Talk" },
  { value: "talk_priority", label: "Talk priority" },
];

function key(userId: number, channelId: number): string {
  return `${userId}:${channelId}`;
}

export function AssignmentsPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [grid, setGrid] = useState<Map<string, Permission>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      const [u, c, m] = await Promise.all([api.listUsers(), api.listChannels(), api.listMemberships()]);
      setUsers(u.users);
      setChannels(c.channels);
      const next = new Map<string, Permission>();
      m.memberships.forEach((row: Membership) => next.set(key(row.user_id, row.channel_id), row.permission));
      setGrid(next);
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

  async function change(user: AdminUser, channel: Channel, value: CellValue) {
    setError(null);
    const k = key(user.id, channel.id);
    const previous = grid.get(k);
    const next = new Map(grid);
    if (value === "none") {
      next.delete(k);
    } else {
      next.set(k, value);
    }
    setGrid(next);
    try {
      if (value === "none") {
        await api.removeMembership(user.id, channel.id);
      } else {
        await api.setMembership(user.id, channel.id, value);
      }
    } catch (err) {
      setError(describeError(err));
      const rollback = new Map(grid);
      if (previous) {
        rollback.set(k, previous);
      } else {
        rollback.delete(k);
      }
      setGrid(rollback);
    }
  }

  if (loading) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Channel Assignments</h2>
        <span className="count">
          {users.length} accounts × {channels.length} channels
        </span>
      </div>
      <p className="panel-desc">
        Grant each account access to channels and set its permission. <strong>Talk priority</strong> may
        transmit and override others; <strong>Talk</strong> may transmit; <strong>Listen only</strong> can
        monitor but never key up.
      </p>

      {error && <div className="banner error">{error}</div>}

      {users.length === 0 || channels.length === 0 ? (
        <div className="empty">Create at least one account and one channel first.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              {channels.map((channel) => (
                <th key={channel.id}>{channel.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.display_name}
                  <br />
                  <code className="mono">{user.username}</code>
                </td>
                {channels.map((channel) => {
                  const value: CellValue = grid.get(key(user.id, channel.id)) ?? "none";
                  return (
                    <td key={channel.id}>
                      <select value={value} onChange={(e) => change(user, channel, e.target.value as CellValue)}>
                        {OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
