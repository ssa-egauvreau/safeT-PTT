import { useMemo, useState, type CSSProperties } from "react";
import type { AdminUser, Channel, Permission } from "../../api";

type CellValue = Permission | "none";

const PERM_OPTIONS: { value: CellValue; label: string; short: string }[] = [
  { value: "none", label: "Disabled", short: "Off" },
  { value: "listen_only", label: "Listen only", short: "Listen" },
  { value: "talk", label: "Normal", short: "Normal" },
  { value: "talk_priority", label: "Talk priority", short: "Priority" },
];

function membershipKey(userId: number, channelId: number): string {
  return `${userId}:${channelId}`;
}

function channelRowStyle(color: string | null): CSSProperties | undefined {
  if (!color) {
    return undefined;
  }
  return {
    borderLeft: `3px solid ${color}`,
    background: `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
  };
}

export function ChannelPermissionsModal({
  user,
  channels,
  grid,
  onClose,
  onChange,
}: {
  user: AdminUser;
  channels: Channel[];
  grid: Map<string, Permission>;
  onClose: () => void;
  onChange: (channel: Channel, value: CellValue) => void | Promise<void>;
}) {
  const [channelSortDir, setChannelSortDir] = useState<"asc" | "desc">("asc");

  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      return channelSortDir === "asc" ? cmp : -cmp;
    });
  }, [channels, channelSortDir]);

  const enabledCount = useMemo(
    () => channels.filter((ch) => grid.has(membershipKey(user.id, ch.id))).length,
    [channels, grid, user.id],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal channel-permissions-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="channel-permissions-title"
      >
        <div className="panel-head">
          <h2 id="channel-permissions-title">Channel permissions</h2>
          <button type="button" className="cp-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <p className="panel-desc">
          <code className="mono">{user.username}</code>
          {user.display_name ? ` · ${user.display_name}` : ""}
          {" · "}
          {enabledCount} of {channels.length} channels enabled
        </p>

        <div className="channel-permissions-toolbar">
          <button
            type="button"
            className="btn sm"
            onClick={() => setChannelSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          >
            Sort {channelSortDir === "asc" ? "A→Z" : "Z→A"}
          </button>
        </div>

        <ul className="channel-permissions-list">
          {sortedChannels.map((channel) => {
            const value: CellValue = grid.get(membershipKey(user.id, channel.id)) ?? "none";
            return (
              <li
                key={channel.id}
                className="channel-permissions-row"
                style={channelRowStyle(channel.color)}
              >
                <span className="channel-permissions-name" title={channel.name}>
                  {channel.name}
                </span>
                <div className="channel-perm-btn-group" role="group" aria-label={`${channel.name} access`}>
                  {PERM_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={value === opt.value ? "channel-perm-btn active" : "channel-perm-btn"}
                      onClick={() => void onChange(channel, opt.value)}
                      title={opt.label}
                      aria-pressed={value === opt.value}
                    >
                      {opt.short}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
