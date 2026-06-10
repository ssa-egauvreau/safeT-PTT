import type { ChannelMember, PresenceStatus } from "../api";
import { ClientPlatformBadge, PresenceStatusBadge } from "../components/RosterBadges";
import { useChannelRoster } from "../hooks/useChannelRoster";
import { useUnitAliasResolver } from "../unitAliases";
import { IconUser } from "../icons";
import { formatUnitSpeakerLabel } from "./consoleShared";

function formatConnected(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
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

/** Short device-category label for a roster row (full name in the tooltip). */
const DEVICE_SHORT: Record<string, { short: string; full: string }> = {
  unit_radio: { short: "Mobile", full: "Unit radio (in-car)" },
  handheld: { short: "Portable", full: "Handheld (pacset)" },
  dispatch_console: { short: "Console", full: "Dispatch console" },
  phone: { short: "Phone", full: "Phone" },
  radio_bridge: { short: "Bridge", full: "Radio bridge" },
};

function deviceShort(member: ChannelMember): { short: string; full: string } | null {
  if (member.device_type && DEVICE_SHORT[member.device_type]) {
    return DEVICE_SHORT[member.device_type]!;
  }
  if (member.kind === "legacy") {
    return { short: "Radio", full: "Hardware radio" };
  }
  return null;
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
            const device = deviceShort(member);
            const label = formatUnitSpeakerLabel(member.unit_id, member.display_name, aliasFor);
            return (
              <li className="roster-row" key={`${member.unit_id}-${index}`}>
                <span
                  className={`roster-dot ${tier(member.connected_ms)}`}
                  title={`Connected ${formatConnected(member.connected_ms)}`}
                />
                <span className="roster-name" title={label}>
                  {label}
                </span>
                {device && (
                  <span className="roster-device" title={device.full}>
                    {device.short}
                  </span>
                )}
                <span className="roster-badges">
                  <PresenceStatusBadge status={status} size={iconSize} />
                  <ClientPlatformBadge client={member.client} size={iconSize - 1} />
                </span>
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
