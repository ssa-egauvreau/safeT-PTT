import { useEffect, useRef, useState } from "react";
import { api, describeError, fetchTransmissionAudio, type Transmission } from "../api";
import { useUnitAliasResolver } from "../unitAliases";
import { formatDuration, formatTime, transcriptOf } from "./TransmissionLog";
import { formatUnitSpeakerLabel } from "./consoleShared";
import { IconWaveform } from "../icons";

/** One latest transmission — full history is in the transcript log. */
const REPLAY_COUNT = 1;

/**
 * A compact "replay last transmission" strip for the channels-on-air column —
 * the most recent transmission with playback and transcript.
 */
export function QuickReplay() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Transmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const aliasFor = useUnitAliasResolver();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCache = useRef<Map<number, string>>(new Map());

  // Poll the most recent transmissions only while the strip is open.
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    async function load() {
      try {
        const res = await api.transmissions({ limit: REPLAY_COUNT, sort: "newest" });
        if (!cancelled) {
          setItems(res.transmissions);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(describeError(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  // Release audio and cached object URLs when the component goes away.
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
      setError("Could not play that recording.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="quick-replay">
      <button
        className={open ? "quick-replay-toggle open" : "quick-replay-toggle"}
        onClick={() => setOpen((v) => !v)}
      >
        <IconWaveform size={15} />
        Latest transmission (all channels)
        <span className="quick-replay-caret">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="quick-replay-body">
          {error && <div className="banner error">{error}</div>}
          {loading && items.length === 0 && <div className="empty">Loading…</div>}
          {!loading && items.length === 0 && !error && (
            <div className="empty">No recorded transmissions yet.</div>
          )}
          {items.map((tx) => {
            const transcript = transcriptOf(tx);
            const speaker = formatUnitSpeakerLabel(tx.unit_id, tx.display_name, aliasFor);
            return (
              <div className="quick-replay-card" key={tx.id}>
                <div className="quick-replay-card-head">
                  <span className="tx-speaker">{speaker}</span>
                  <span className="tx-channel">{tx.channel_name}</span>
                </div>
                <div className="tx-card-sub">
                  {formatTime(tx.started_at)} · {formatDuration(tx.duration_ms)}
                </div>
                <div className={transcript.muted ? "tx-transcript muted" : "tx-transcript"}>
                  {transcript.text}
                </div>
                <button
                  className="btn sm"
                  disabled={busyId === tx.id}
                  onClick={() => play(tx.id)}
                >
                  {playingId === tx.id ? "Pause" : busyId === tx.id ? "…" : "Play"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
