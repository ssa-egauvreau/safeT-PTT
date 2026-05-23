import { useEffect, useState } from "react";
import { api, type ChannelMember } from "../api";

/** Polls connected radios/operators on a channel (shared by roster list and header count). */
export function useChannelRoster(channelName: string, enabled = true) {
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.channelRoster(channelName);
        if (!cancelled) {
          setMembers(res.members);
          setLoading(false);
        }
      } catch {
        /* keep last snapshot */
      }
    }
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channelName, enabled]);

  return { members, count: members.length, loading };
}
