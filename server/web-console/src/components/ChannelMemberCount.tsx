import { useChannelRoster } from "../hooks/useChannelRoster";
import { IconUser } from "../icons";

/** Compact connected-user count for workspace channel widget headers. */
export function ChannelMemberCount({
  channelName,
  iconSize = 14,
  count: countProp,
}: {
  channelName: string;
  iconSize?: number;
  /** When provided, skips internal roster polling (parent shares one poll). */
  count?: number | null;
}) {
  const polled = useChannelRoster(channelName, countProp === undefined);
  const count = countProp !== undefined ? countProp : polled.loading ? null : polled.count;

  const label = count === null ? "…" : String(count);
  return (
    <span
      className="ch-member-count"
      title={count === null ? "Users on channel" : `${count} user${count === 1 ? "" : "s"} on channel`}
      aria-label={count === null ? "Users on channel" : `${count} on channel`}
    >
      <IconUser size={iconSize} />
      <span className="ch-member-count-num">{label}</span>
    </span>
  );
}
