import type { ChannelMember, PresenceStatus } from "../api";
import { ClientPlatformBadge, PresenceStatusBadge } from "../components/RosterBadges";
import { useChannelRoster } from "../hooks/useChannelRoster";
import { useUnitAliasResolver } from "../unitAliases";
import { IconUser } from "../icons";

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
  const iconSize = compact ? 12 : 14;

  return (
    <div className={`roster${compact ? " roster--compact" : ""}`}>
      <div className="roster-head">
        <IconUser size={compact ? 12 : 13} />
        <span>On this channel</span>
        <span className="count" title={`${members.length} connected`}>
          {members.length}
        </span>
      </div>
      {members.length === 0 ? (
        <div className="roster-empty">No radios connected.</div>
      ) : (
        <ul className="roster-list">
          {members.map((member, index) => {
            const status = (member.status ?? "idle") as PresenceStatus;
            return (
              <li className="roster-row" key={`${member.unit_id}-${index}`}>
                <span className={`roster-dot ${tier(member.connected_ms)}`} title="Connected" />
                <span className="roster-name">{member.display_name || aliasFor(member.unit_id)}</span>
                <PresenceStatusBadge status={status} size={iconSize} />
                {member.kind === "legacy" && (
                  <span className="roster-tag" title="Hardware radio">
                    radio
                  </span>
                )}
                <ClientPlatformBadge client={member.client} size={iconSize - 1} />
                <span className="roster-time" title="Time on channel">
                  {formatConnected(member.connected_ms)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
