import type { ChannelMember, PresenceStatus } from "../api";
import { useChannelRoster } from "../hooks/useChannelRoster";
import { useUnitAliasResolver } from "../unitAliases";
import { IconUser } from "../icons";

/** Label + colour class for each derived presence status. */
const STATUS_META: Record<PresenceStatus, { label: string; cls: string }> = {
  emergency: { label: "Emergency", cls: "emergency" },
  transmitting: { label: "On air", cls: "transmitting" },
  driving: { label: "Driving", cls: "driving" },
  idle: { label: "Idle", cls: "idle" },
};

function formatConnected(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Friendly label for a member's client platform. */
const CLIENT_LABEL: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  web: "Web",
  desktop: "Desktop",
  bridge: "Bridge",
};

/** Connection-age tier — drives the status dot colour. */
function tier(ms: number): string {
  if (ms < 60_000) {
    return "new";
  }
  if (ms < 60 * 60_000) {
    return "steady";
  }
  return "long";
}

/** Live list of radios/operators connected to a channel's voice stream. */
export function ChannelRoster({
  channelName,
  compact = false,
  members: membersProp,
}: {
  channelName: string;
  /** Tighter rows for Mission Control M/L widgets. */
  compact?: boolean;
  /** When provided, skips internal roster polling (parent shares one poll). */
  members?: ChannelMember[];
}) {
  const polled = useChannelRoster(channelName, membersProp === undefined);
  const members = membersProp ?? polled.members;
  const aliasFor = useUnitAliasResolver();

  return (
    <div className={`roster${compact ? " roster--compact" : ""}`}>
      <div className="roster-head">
        <IconUser size={compact ? 12 : 13} />
        <span>On this channel</span>
        <span className="count">{members.length}</span>
      </div>
      {members.length === 0 ? (
        <div className="roster-empty">No radios connected.</div>
      ) : (
        <ul className="roster-list">
          {members.map((member, index) => {
            const status = STATUS_META[member.status ?? "idle"];
            return (
              <li className="roster-row" key={`${member.unit_id}-${index}`}>
                <span className={`roster-dot ${tier(member.connected_ms)}`} title="Connected" />
                <span className="roster-name">{member.display_name || aliasFor(member.unit_id)}</span>
                <span className={`roster-status ${status.cls}`}>{status.label}</span>
                {member.kind === "legacy" && <span className="roster-tag">radio</span>}
                {CLIENT_LABEL[member.client] && (
                  <span className="roster-tag">{CLIENT_LABEL[member.client]}</span>
                )}
                <span className="roster-time">{formatConnected(member.connected_ms)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
