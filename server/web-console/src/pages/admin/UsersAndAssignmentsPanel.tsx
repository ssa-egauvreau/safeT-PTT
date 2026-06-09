import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  describeError,
  DEVICE_TYPE_OPTIONS,
  type AdminUser,
  type Channel,
  type Membership,
  type Permission,
  type Role,
} from "../../api";
import { ChannelPermissionsModal } from "./ChannelPermissionsModal";

const ROLES: Role[] = ["admin", "dispatcher", "radio"];

type CellValue = Permission | "none";

type SortDir = "asc" | "desc";

type UserSortKey = "username" | "display_name" | "role" | "unit_id" | "device_type" | "status";

function membershipKey(userId: number, channelId: number): string {
  return `${userId}:${channelId}`;
}

function compareText(a: string, b: string, dir: SortDir): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return dir === "asc" ? cmp : -cmp;
}

function sortActiveSuffix(key: UserSortKey, dir: SortDir): string {
  switch (key) {
    case "username":
    case "display_name":
    case "unit_id":
      return dir === "asc" ? " A→Z" : " Z→A";
    case "role":
      return dir === "asc" ? " · role ↑" : " · role ↓";
    case "device_type":
      return dir === "asc" ? " · device ↑" : " · device ↓";
    case "status":
      return dir === "asc" ? " · status ↑" : " · status ↓";
    default:
      return dir === "asc" ? " A→Z" : " Z→A";
  }
}

function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onClick,
}: {
  label: string;
  sortKey: UserSortKey;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th>
      <button type="button" className={`th-sort${active ? " active" : ""}`} onClick={onClick}>
        {label}
        {active ? sortActiveSuffix(sortKey, dir) : ""}
      </button>
    </th>
  );
}

/** Accounts plus per-channel permissions in one table (replaces separate Accounts + Assignments tabs). */
export function UsersAndAssignmentsPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [grid, setGrid] = useState<Map<string, Permission>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("radio");
  const [unitId, setUnitId] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [creating, setCreating] = useState(false);

  const [userSortKey, setUserSortKey] = useState<UserSortKey>("username");
  const [userSortDir, setUserSortDir] = useState<SortDir>("asc");
  const [permissionsUser, setPermissionsUser] = useState<AdminUser | null>(null);

  async function reload() {
    try {
      const [u, c, m] = await Promise.all([api.listUsers(), api.listChannels(), api.listMemberships()]);
      setUsers(u.users);
      setChannels(c.channels);
      const next = new Map<string, Permission>();
      m.memberships.forEach((row: Membership) =>
        next.set(membershipKey(row.user_id, row.channel_id), row.permission),
      );
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

  const sortedUsers = useMemo(() => {
    const keyFn = (u: AdminUser): string => {
      switch (userSortKey) {
        case "username":
          return u.username;
        case "display_name":
          return u.display_name;
        case "role":
          return u.role;
        case "unit_id":
          return u.unit_id ?? "";
        case "device_type":
          return u.device_type ?? "";
        case "status":
          return u.disabled ? "disabled" : "active";
        default:
          return u.display_name;
      }
    };
    return [...users].sort((a, b) => compareText(keyFn(a), keyFn(b), userSortDir));
  }, [users, userSortKey, userSortDir]);

  function toggleUserSort(key: UserSortKey) {
    if (userSortKey === key) {
      setUserSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setUserSortKey(key);
      setUserSortDir("asc");
    }
  }

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
        deviceType: deviceType || null,
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("radio");
      setUnitId("");
      setDeviceType("");
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

  async function changeMembership(user: AdminUser, channel: Channel, value: CellValue) {
    setError(null);
    const k = membershipKey(user.id, channel.id);
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

  return (
    <div className="users-assignments-panel">
      <div className="panel-head">
        <h2>Users &amp; channel access</h2>
        <span className="count">
          {users.length} users · {channels.length} channels
        </span>
      </div>
      <p className="panel-desc">
        One row per account: edit login details, unit, and device here. Use{" "}
        <strong>Channel permissions</strong> on each row to assign access without scrolling sideways.
        Click a column heading to sort (username and unit ID use A→Z; role, device, and status sort by
        that field).
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
          <div className="field">
            <label>Device</label>
            <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
              {DEVICE_TYPE_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : users.length === 0 || channels.length === 0 ? (
        <div className="empty">Create at least one account and one channel first.</div>
      ) : (
        <div className="users-table-wrap">
          <table className="users-assignments-table">
            <thead>
              <tr>
                <SortableTh
                  label="Username"
                  sortKey="username"
                  active={userSortKey === "username"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("username")}
                />
                <SortableTh
                  label="Display name"
                  sortKey="display_name"
                  active={userSortKey === "display_name"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("display_name")}
                />
                <SortableTh
                  label="Role"
                  sortKey="role"
                  active={userSortKey === "role"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("role")}
                />
                <SortableTh
                  label="Unit ID"
                  sortKey="unit_id"
                  active={userSortKey === "unit_id"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("unit_id")}
                />
                <SortableTh
                  label="Device"
                  sortKey="device_type"
                  active={userSortKey === "device_type"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("device_type")}
                />
                <SortableTh
                  label="Status"
                  sortKey="status"
                  active={userSortKey === "status"}
                  dir={userSortDir}
                  onClick={() => toggleUserSort("status")}
                />
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.map((user) => (
                <tr key={user.id}>
                  <td>
                    <code className="mono">{user.username}</code>
                  </td>
                  <td>
                    <input
                      className="inline-edit"
                      value={user.display_name}
                      onChange={(e) => {
                        const v = e.target.value;
                        setUsers((prev) =>
                          prev.map((u) => (u.id === user.id ? { ...u, display_name: v } : u)),
                        );
                      }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== user.display_name) {
                          void patch(user, { displayName: v });
                        }
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={user.role}
                      onChange={(e) => patch(user, { role: e.target.value as Role })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="inline-edit mono"
                      value={user.unit_id ?? ""}
                      placeholder="—"
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase();
                        setUsers((prev) =>
                          prev.map((u) => (u.id === user.id ? { ...u, unit_id: v || null } : u)),
                        );
                      }}
                      onBlur={(e) => {
                        const v = e.target.value.trim().toUpperCase();
                        const cur = (user.unit_id ?? "").toUpperCase();
                        if (v !== cur) {
                          void patch(user, { unitId: v || null });
                        }
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={user.device_type ?? ""}
                      onChange={(e) => patch(user, { deviceType: e.target.value || null })}
                    >
                      {DEVICE_TYPE_OPTIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={user.disabled ? "pill off" : "pill on"}>
                      {user.disabled ? "Disabled" : "Active"}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions compact">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setPermissionsUser(user)}
                      >
                        Channel permissions
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => patch(user, { disabled: !user.disabled })}
                      >
                        {user.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => {
                          const next = window.prompt(`New password for "${user.username}"`);
                          if (next?.length) {
                            void patch(user, { password: next });
                          }
                        }}
                      >
                        Password
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
        </div>
      )}

      {permissionsUser && (
        <ChannelPermissionsModal
          user={permissionsUser}
          channels={channels}
          grid={grid}
          onClose={() => setPermissionsUser(null)}
          onChange={(channel, value) => changeMembership(permissionsUser, channel, value)}
        />
      )}
    </div>
  );
}
