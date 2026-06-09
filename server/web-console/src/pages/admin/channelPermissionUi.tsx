import { useMemo, useState, type CSSProperties } from "react";
import type { Channel, Permission } from "../../api";

export type CellValue = Permission | "none";

export const PERM_OPTIONS: { value: CellValue; label: string; short: string }[] = [
  { value: "none", label: "Disabled", short: "Off" },
  { value: "listen_only", label: "Listen only", short: "Listen" },
  { value: "talk", label: "Normal", short: "Normal" },
  { value: "talk_priority", label: "Talk priority", short: "Priority" },
];

export function channelRowStyle(color: string | null): CSSProperties | undefined {
  if (!color) {
    return undefined;
  }
  return {
    borderLeft: `3px solid ${color}`,
    background: `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
  };
}

export function ChannelPermissionList({
  channels,
  valueForChannel,
  onChange,
}: {
  channels: Channel[];
  valueForChannel: (channelId: number) => CellValue;
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
    () => channels.filter((ch) => valueForChannel(ch.id) !== "none").length,
    [channels, valueForChannel],
  );

  return (
    <>
      <p className="panel-desc compact">
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
          const value = valueForChannel(channel.id);
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
    </>
  );
}
