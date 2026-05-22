import { useEffect, useRef, useState } from "react";
import { api, type Transmission } from "../api";

const AIR_POLL_MS = 1200;
const TX_POLL_MS = 2000;

export type LiveTalker = {
  unitId: string;
  displayName: string;
  /** Set when attribution came from a scan side-channel. */
  scanChannel?: string;
};

export type UseChannelLiveRxOpts = {
  channelName: string | null;
  /** Poll air / talk-activity and latest transmission while true. */
  active: boolean;
  /** Inbound PCM on the tuned (home) channel. */
  homeReceiving: boolean;
  /** Scan client reports RX on this channel name (if any). */
  scanRxChannel?: string | null;
  /** Comma-separated scan list for talk-activity (excluding home). */
  scanWatchList?: string;
  /** Hide live attribution when this unit is the talker (handset self-RX). */
  localUnitId?: string | null;
};

/**
 * Polls `/v1/air` (or `/v1/talk-activity` when scan is enabled) for live talker identity
 * and `/v1/transmissions?limit=1` for the latest recorded message on the channel.
 */
export function useChannelLiveRx({
  channelName,
  active,
  homeReceiving,
  scanRxChannel = null,
  scanWatchList = "",
  localUnitId = null,
}: UseChannelLiveRxOpts) {
  const [liveTalker, setLiveTalker] = useState<LiveTalker | null>(null);
  const [latestTx, setLatestTx] = useState<Transmission | null>(null);
  const prevHomeReceiving = useRef(false);

  const localUnit = localUnitId?.trim().toUpperCase() || "";

  function applyTalker(unitId: string | null | undefined, displayName: string | null | undefined, scanChannel?: string) {
    const unit = unitId?.trim().toUpperCase() || "";
    if (!unit || (localUnit && unit === localUnit)) {
      setLiveTalker(null);
      return;
    }
    const name = displayName?.trim() || "";
    setLiveTalker({
      unitId: unit,
      displayName: name,
      scanChannel: scanChannel?.trim() || undefined,
    });
  }

  useEffect(() => {
    if (!active || !channelName) {
      setLiveTalker(null);
      return;
    }

    let cancelled = false;

    async function pollAir() {
      try {
        if (scanWatchList) {
          const ta = await api.talkActivity({ home: channelName!, scan: scanWatchList });
          if (cancelled) return;
          const preferScan =
            scanRxChannel &&
            ta.scan.active &&
            ta.scan.channel &&
            ta.scan.unit_id;
          if (preferScan) {
            applyTalker(ta.scan.unit_id, ta.scan.username, ta.scan.channel);
            return;
          }
          if (homeReceiving && ta.main.active && ta.main.unit_id) {
            applyTalker(ta.main.unit_id, ta.main.username);
            return;
          }
          if (ta.scan.active && ta.scan.unit_id) {
            applyTalker(ta.scan.unit_id, ta.scan.username, ta.scan.channel);
            return;
          }
          setLiveTalker(null);
          return;
        }

        const air = await api.air(channelName!);
        if (cancelled) return;
        if (homeReceiving && air.occupied && air.transmitting_unit_id) {
          applyTalker(air.transmitting_unit_id, air.transmitting_display_name);
        } else if (scanRxChannel) {
          const scanAir = await api.air(scanRxChannel);
          if (cancelled) return;
          if (scanAir.occupied && scanAir.transmitting_unit_id) {
            applyTalker(scanAir.transmitting_unit_id, scanAir.transmitting_display_name, scanRxChannel);
          } else {
            setLiveTalker(null);
          }
        } else {
          setLiveTalker(null);
        }
      } catch {
        /* transient — next poll retries */
      }
    }

    void pollAir();
    const id = window.setInterval(() => void pollAir(), AIR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, channelName, homeReceiving, scanRxChannel, scanWatchList, localUnit]);

  async function fetchLatestTx() {
    if (!channelName) return;
    try {
      const res = await api.transmissions({ channel: channelName, limit: 1, sort: "newest" });
      setLatestTx(res.transmissions[0] ?? null);
    } catch {
      /* transient */
    }
  }

  useEffect(() => {
    if (!active || !channelName) {
      setLatestTx(null);
      prevHomeReceiving.current = false;
      return;
    }

    let cancelled = false;

    async function load() {
      if (cancelled) return;
      await fetchLatestTx();
    }

    void load();
    const id = window.setInterval(() => void load(), TX_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, channelName]);

  // Refresh the latest transmission as soon as home RX ends (transcript lands shortly after).
  useEffect(() => {
    if (prevHomeReceiving.current && !homeReceiving && active && channelName) {
      void fetchLatestTx();
      const retry = window.setTimeout(() => void fetchLatestTx(), 2500);
      const retry2 = window.setTimeout(() => void fetchLatestTx(), 6000);
      return () => {
        window.clearTimeout(retry);
        window.clearTimeout(retry2);
      };
    }
    prevHomeReceiving.current = homeReceiving;
  }, [homeReceiving, active, channelName]);

  const showLive =
    (homeReceiving || !!scanRxChannel) && liveTalker !== null;

  return { liveTalker, latestTx, showLive, refreshLatestTx: fetchLatestTx };
}
