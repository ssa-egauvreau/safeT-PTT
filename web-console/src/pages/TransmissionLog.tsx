import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, fetchTransmissionAudio, type Transmission } from "../api";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : `${seconds}s`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

function transcriptOf(tx: Transmission): { text: string; muted: boolean } {
  switch (tx.transcript_status) {
    case "done":
      return tx.transcript && tx.transcript.length > 0
        ? { text: tx.transcript, muted: false }
        : { text: "(no speech detected)", muted: true };
    case "pending":
      return { text: "Transcribing…", muted: true };
    case "failed":
      return { text: "Transcript unavailable", muted: true };
    case "disabled":
      return { text: "Transcription disabled", muted: true };
    default:
      return { text: tx.transcript ?? "—", muted: true };
  }
}

export function TransmissionLog() {
  const [items, setItems] = useState<Transmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCache = useRef<Map<number, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const res = await api.transmissions(100);
      setItems(res.transmissions);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const cache = urlCache.current;
    return () => {
      window.clearInterval(timer);
      audioRef.current?.pause();
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, [refresh]);

  const objectUrlFor = useCallback(async (id: number): Promise<string> => {
    const cached = urlCache.current.get(id);
    if (cached) {
      return cached;
    }
    const blob = await fetchTransmissionAudio(id);
    const url = URL.createObjectURL(blob);
    urlCache.current.set(id, url);
    return url;
  }, []);

  async function play(id: number) {
    if (playingId === id && audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
      return;
    }
    setBusyId(id);
    try {
      const url = await objectUrlFor(id);
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

  async function download(id: number) {
    setBusyId(id);
    try {
      const url = await objectUrlFor(id);
      const link = document.createElement("a");
      link.href = url;
      link.download = `transmission-${id}.wav`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setError("Could not download that recording.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="tx-log">
      <h3>Transmission Log</h3>
      {error && <div className="banner error">{error}</div>}
      {loading && <div className="empty">Loading…</div>}
      {!loading && items.length === 0 && <div className="empty">No recorded transmissions yet.</div>}
      {items.map((tx) => {
        const transcript = transcriptOf(tx);
        const speaker = tx.display_name || tx.unit_id || "Unknown";
        return (
          <div className="tx-card" key={tx.id}>
            <div className="tx-card-head">
              <span className="tx-speaker">{speaker}</span>
              <span className="tx-channel">{tx.channel_name}</span>
            </div>
            <div className="tx-card-sub">
              {formatTime(tx.started_at)} · {formatDuration(tx.duration_ms)}
              {tx.display_name && tx.unit_id ? ` · ${tx.unit_id}` : ""}
            </div>
            <div className={transcript.muted ? "tx-transcript muted" : "tx-transcript"}>
              {transcript.text}
            </div>
            <div className="tx-card-actions">
              <button className="btn sm" disabled={busyId === tx.id} onClick={() => play(tx.id)}>
                {playingId === tx.id ? "Pause" : busyId === tx.id ? "…" : "Play"}
              </button>
              <button className="btn sm" disabled={busyId === tx.id} onClick={() => download(tx.id)}>
                Download
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
