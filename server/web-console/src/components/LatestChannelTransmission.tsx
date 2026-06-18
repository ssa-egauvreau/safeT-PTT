import { useEffect, useRef, useState } from "react";
import { fetchTransmissionAudio } from "../api";
import type { WorkspaceWidgetSize } from "../consoleStore";
import { useChannelLiveRx, type PushedTalker } from "../hooks/useChannelLiveRx";
import { useUnitAliasResolver } from "../unitAliases";
import { formatDuration, formatTime, transcriptOf } from "../pages/TransmissionLog";
import { formatUnitSpeakerLabel } from "../pages/consoleShared";
import { IconPause, IconPlay, IconWaveform } from "../icons";

export type LatestChannelTransmissionProps = {
  channelName: string | null;
  active: boolean;
  homeReceiving: boolean;
  /** Relay-pushed talker (`air_claimed` / `air_released`) for instant attribution. */
  pushedTalker?: PushedTalker | null;
  scanRxChannel?: string | null;
  scanWatchList?: string;
  localUnitId?: string | null;
  /** `radio` = portal spacing; `console` = inside channel card */
  variant?: "radio" | "console";
  logHint?: string;
  /** Mission Control widget density (S / M / L). */
  workspaceSize?: WorkspaceWidgetSize;
  /**
   * Suppress the live "Receiving" talker block. The Mission Control card shows
   * the receiving state inside the XMIT button instead, so rendering it here too
   * would resize the whole card every time someone keys/un-keys the channel.
   */
  hideLiveBadge?: boolean;
};

/**
 * One live talker line (while someone is keyed) plus the latest recorded transmission
 * with transcript and replay — full history stays in TransmissionLog.
 */
export function LatestChannelTransmission({
  channelName,
  active,
  homeReceiving,
  pushedTalker,
  scanRxChannel = null,
  scanWatchList = "",
  localUnitId = null,
  variant = "console",
  logHint = "Open the transcript log below for full history.",
  workspaceSize,
  hideLiveBadge = false,
}: LatestChannelTransmissionProps) {
  const aliasFor = useUnitAliasResolver();
  const { liveTalker, latestTx, showLive } = useChannelLiveRx({
    channelName,
    active,
    homeReceiving,
    pushedTalker,
    scanRxChannel,
    scanWatchList,
    localUnitId,
  });

  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCache = useRef<Map<number, string>>(new Map());

  const ws = workspaceSize;
  /** Compact card layout for Mission Control tiles (not “hide live talker”). */
  const wsCardLayout = ws === "small" || ws === "medium" || ws === "large";

  useEffect(() => {
    const cache = urlCache.current;
    return () => {
      audioRef.current?.pause();
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  async function play(id: number) {
    if (playingId === id && audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
      return;
    }
    setBusyId(id);
    try {
      let url = urlCache.current.get(id);
      if (!url) {
        url = URL.createObjectURL(await fetchTransmissionAudio(id));
        urlCache.current.set(id, url);
      }
      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.onended = () => setPlayingId(null);
        audioRef.current = audio;
      }
      audio.src = url;
      await audio.play();
      setPlayingId(id);
    } catch {
      /* ignore — operator can retry */
    } finally {
      setBusyId(null);
    }
  }

  const rootClass = [
    variant === "radio" ? "live-tx live-tx-radio" : "live-tx live-tx-console",
    ws ? `live-tx-ws live-tx-ws--${ws}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!active || !channelName) {
    const emptyMsg =
      variant === "radio" && !channelName
        ? "Pick a channel to see who is talking and the latest transcript."
        : !channelName
          ? "Select a channel."
          : "Connecting to voice…";
    return (
      <div className={rootClass}>
        <div className="empty">{emptyMsg}</div>
      </div>
    );
  }

  const transcript = latestTx ? transcriptOf(latestTx) : null;
  const recordedSpeaker = latestTx
    ? formatUnitSpeakerLabel(latestTx.unit_id, latestTx.display_name, aliasFor)
    : null;
  const isPlaying = latestTx != null && playingId === latestTx.id;
  const isBusy = latestTx != null && busyId === latestTx.id;

  const liveNow = showLive && liveTalker && !hideLiveBadge ? (
    <div
      className={ws ? "live-tx-now live-tx-now--ws" : "live-tx-now"}
      role="status"
      aria-live="polite"
    >
      {liveTalker.scanChannel ? (
        <span className="live-tx-badge scan">SCAN · {liveTalker.scanChannel}</span>
      ) : (
        <span className="live-tx-badge rx">Receiving</span>
      )}
      <div className="live-tx-talker">
        <span className="live-tx-unit">{liveTalker.unitId}</span>
        {liveTalker.displayName ? (
          <span className="live-tx-name">{liveTalker.displayName}</span>
        ) : (
          <span className="live-tx-name muted">On the air</span>
        )}
      </div>
      {!ws && (
        <p className="live-tx-pending muted">
          Transcript appears here after they release the key.
        </p>
      )}
    </div>
  ) : null;

  return (
    <div className={rootClass}>
      {liveNow}

      {latestTx ? (
        <div className={`live-tx-card${wsCardLayout ? " live-tx-card--ws" : ""}`}>
          {wsCardLayout ? (
            <>
              <div className="live-tx-card-top">
                <div className="live-tx-card-title-row">
                  <IconWaveform size={ws === "small" ? 11 : 12} />
                  <span className="live-tx-card-title">
                    {showLive ? "Last" : "Latest"}
                  </span>
                </div>
                <span className="live-tx-time">
                  {formatTime(latestTx.started_at)} · {formatDuration(latestTx.duration_ms)}
                </span>
              </div>
              <div className="live-tx-card-body">
                <span className="live-tx-speaker">{recordedSpeaker}</span>
                <div
                  className={
                    transcript?.muted ? "live-tx-transcript muted" : "live-tx-transcript"
                  }
                >
                  {transcript?.text ?? "—"}
                </div>
                <button
                  type="button"
                  className="live-tx-play-btn"
                  disabled={isBusy}
                  onClick={() => void play(latestTx.id)}
                  aria-label={isPlaying ? "Pause replay" : "Play replay"}
                  title={isPlaying ? "Pause" : isBusy ? "Loading…" : "Play"}
                >
                  {isPlaying ? (
                    <IconPause size={ws === "small" ? 13 : 15} />
                  ) : (
                    <IconPlay size={ws === "small" ? 13 : 15} />
                  )}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="live-tx-card-head">
                <IconWaveform size={15} />
                <span className="live-tx-card-title">
                  {showLive ? "Last recorded" : "Latest on channel"}
                </span>
              </div>
              <div className="live-tx-meta-row">
                <span className="live-tx-speaker">{recordedSpeaker}</span>
                <span className="live-tx-time">
                  {formatTime(latestTx.started_at)} · {formatDuration(latestTx.duration_ms)}
                </span>
              </div>
              <div
                className={
                  transcript?.muted ? "live-tx-transcript muted" : "live-tx-transcript"
                }
              >
                {transcript?.text ?? "—"}
              </div>
              <button
                type="button"
                className="btn sm live-tx-replay"
                disabled={isBusy}
                onClick={() => void play(latestTx.id)}
              >
                {isPlaying ? "Pause" : isBusy ? "Loading…" : "Replay"}
              </button>
            </>
          )}
        </div>
      ) : !showLive ? (
        <div className="empty">No recorded transmissions on this channel yet.</div>
      ) : null}

      {logHint ? <p className="live-tx-log-hint muted">{logHint}</p> : null}
    </div>
  );
}
