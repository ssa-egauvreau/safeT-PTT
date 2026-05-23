import { useEffect, useState } from "react";
import { api } from "../api";
import { IconUser } from "../icons";

/** Compact connected-user count for small/medium workspace channel widgets. */
export function ChannelMemberCount({
  channelName,
  iconSize = 14,
}: {
  channelName: string;
  iconSize?: number;
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.channelRoster(channelName);
        if (!cancelled) {
          setCount(res.members.length);
        }
      } catch {
        /* keep last count */
      }
    }
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channelName]);

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
