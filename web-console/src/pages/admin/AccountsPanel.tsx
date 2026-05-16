import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type AdminUser, type Role } from "../../api";

const ROLES: Role[] = ["admin", "dispatcher", "radio"];

export function AccountsPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("radio");
  const [unitId, setUnitId] = useState("");
  const [creating, setCreating] = useState(false);

  async function reload() {
    try {
      const res = await api.listUsers();
      setUsers(res.users);
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
    try {
      await api.createUser({
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        role,
        unitId: unitId.trim() ? unitId.trim().toUpperCase() : null,
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("radio");
      setUnitId("");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  async function patch(user: AdminUser, change: Parameters<typeof api.updateUser>[1]) {
    setError(null);
    try {
      await api.updateUser(user.id, change);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove(user: AdminUser) {
    if (!window.confirm(`Delete account "${user.username}"? This cannot be undone.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteUser(user.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function rename(user: AdminUser) {
    const next = window.prompt("Display name", user.display_name);
    if (next != null && next.trim() && next.trim() !== user.display_name) {
      void patch(user, { displayName: next.trim() });
    }
  }

  function editUnit(user: AdminUser) {
    const next = window.prompt("Radio unit ID (blank to clear)", user.unit_id ?? "");
    if (next != null) {
      void patch(user, { unitId: next.trim() ? next.trim().toUpperCase() : null });
    }
  }

  function resetPassword(user: AdminUser) {
    const next = window.prompt(`New password for "${user.username}"`);
    if (next != null && next.length > 0) {
      void patch(user, { password: next });
    }
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Accounts</h2>
        <span className="count">{users.length} total</span>
      </div>
      <p className="panel-desc">
        Radio logins and console operators. Roles: <strong>admin</strong> manages this portal,{" "}
        <strong>dispatcher</strong> uses the console, <strong>radio</strong> is a handset account.
      </p>

      {error && <div className="banner error">{error}</div>}

      <form className="card" onSubmit={onCreate}>
        <h3>Create account</h3>
        <div className="form-row">
          <div className="field">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>Display name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Unit ID</label>
            <input value={unitId} onChange={(e) => setUnitId(e.target.value)} placeholder="optional" />
          </div>
          <button className="btn primary" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Display name</th>
              <th>Role</th>
              <th>Unit ID</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <code className="mono">{user.username}</code>
                </td>
                <td>{user.display_name}</td>
                <td>
                  <select value={user.role} onChange={(e) => patch(user, { role: e.target.value as Role })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{user.unit_id ?? <span className="empty" style={{ padding: 0 }}>—</span>}</td>
                <td>
                  <span className={user.disabled ? "pill off" : "pill on"}>
                    {user.disabled ? "Disabled" : "Active"}
                  </span>
                </td>
                <td>
                  <div className="cell-actions">
                    <button className="btn sm" onClick={() => rename(user)}>
                      Rename
                    </button>
                    <button className="btn sm" onClick={() => editUnit(user)}>
                      Unit
                    </button>
                    <button className="btn sm" onClick={() => resetPassword(user)}>
                      Password
                    </button>
                    <button className="btn sm" onClick={() => patch(user, { disabled: !user.disabled })}>
                      {user.disabled ? "Enable" : "Disable"}
                    </button>
                    <button className="btn sm danger" onClick={() => remove(user)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
