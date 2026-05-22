import { useEffect, useRef, useState } from "react";
import { fetchTransmissionAudio } from "../api";
import { useChannelLiveRx } from "../hooks/useChannelLiveRx";
import { useUnitAliasResolver } from "../unitAliases";
import { formatDuration, formatTime, transcriptOf } from "../pages/TransmissionLog";
import { IconWaveform } from "../icons";

export type LatestChannelTransmissionProps = {
  channelName: string | null;
  active: boolean;
  homeReceiving: boolean;
  scanRxChannel?: string | null;
  scanWatchList?: string;
  localUnitId?: string | null;
  /** `radio` = portal spacing; `console` = inside channel card */
  variant?: "radio" | "console";
  logHint?: string;
};

/**
 * One live talker line (while someone is keyed) plus the latest recorded transmission
 * with transcript and replay — full history stays in TransmissionLog.
 */
export function LatestChannelTransmission({
  channelName,
  active,
  homeReceiving,
  scanRxChannel = null,
  scanWatchList = "",
  localUnitId = null,
  variant = "console",
  logHint = "Open the transcript log below for full history.",
}: LatestChannelTransmissionProps) {
  const aliasFor = useUnitAliasResolver();
  const { liveTalker, latestTx, showLive } = useChannelLiveRx({
    channelName,
    active,
    homeReceiving,
    scanRxChannel,
    scanWatchList,
    localUnitId,
  });

  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCache = useRef<Map<number, string>>(new Map());

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

  const rootClass = variant === "radio" ? "live-tx live-tx-radio" : "live-tx live-tx-console";

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
    ? latestTx.display_name || aliasFor(latestTx.unit_id) || "Unknown"
    : null;

  return (
    <div className={rootClass}>
      {showLive && liveTalker && (
        <div className="live-tx-now" role="status" aria-live="polite">
          {liveTalker.scanChannel ? (
            <span className="live-tx-badge scan">SCAN RX · {liveTalker.scanChannel}</span>
          ) : (
            <span className="live-tx-badge rx">RECEIVING</span>
          )}
          <div className="live-tx-talker">
            <span className="live-tx-unit">{liveTalker.unitId}</span>
            {liveTalker.displayName ? (
              <span className="live-tx-name">{liveTalker.displayName}</span>
            ) : (
              <span className="live-tx-name muted">On the air</span>
            )}
          </div>
          <p className="live-tx-pending muted">
            Transcript appears here after they release the key.
          </p>
        </div>
      )}

      {latestTx ? (
        <div className="live-tx-card">
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
            disabled={busyId === latestTx.id}
            onClick={() => void play(latestTx.id)}
          >
            {playingId === latestTx.id
              ? "Pause"
              : busyId === latestTx.id
                ? "Loading…"
                : "Replay"}
          </button>
        </div>
      ) : !showLive ? (
        <div className="empty">No recorded transmissions on this channel yet.</div>
      ) : null}

      {logHint ? <p className="live-tx-log-hint muted">{logHint}</p> : null}
    </div>
  );
}
