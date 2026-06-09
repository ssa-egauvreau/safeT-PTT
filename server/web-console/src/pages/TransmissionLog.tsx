import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, fetchTransmissionAudio, type Transmission, type UserChannel } from "../api";
import { useUnitAliasResolver } from "../unitAliases";
import { formatUnitSpeakerLabel } from "./consoleShared";
import { imbeRoundtripPcm16k, pcm16ToWavBlob } from "../voice/imbeRoundtrip";
import { pcm16kFromTransmissionWav } from "../voice/wavPcm";

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : `${seconds}s`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

export function transcriptOf(tx: Transmission): { text: string; muted: boolean } {
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

/** Snippet around the first case-insensitive match of `query` in `text`, with
 *  the match position returned. When `query` is empty or doesn't match, returns
 *  the head of the text and `matchStart = -1`. The snippet length is bounded by
 *  `maxLen` so the highlighted transcript row stays the same shape whether or
 *  not the operator is searching. */
export function highlightTranscriptSnippet(
  text: string,
  query: string,
  maxLen = 120,
): { snippet: string; matchStart: number; matchEnd: number; truncatedLead: boolean; truncatedTail: boolean } {
  const trimmedQuery = query.trim();
  // No query → straight head-of-text with the cap. The match indices stay at
  // -1 so the renderer skips the <mark> wrapper entirely.
  if (trimmedQuery === "") {
    if (text.length <= maxLen) {
      return { snippet: text, matchStart: -1, matchEnd: -1, truncatedLead: false, truncatedTail: false };
    }
    return {
      snippet: text.slice(0, maxLen),
      matchStart: -1,
      matchEnd: -1,
      truncatedLead: false,
      truncatedTail: true,
    };
  }
  const idx = text.toLowerCase().indexOf(trimmedQuery.toLowerCase());
  if (idx < 0) {
    // Match absent (the row matched on a different filter, or the search
    // ran ahead of the transcript poll). Fall back to the head-of-text path.
    return highlightTranscriptSnippet(text, "", maxLen);
  }
  const matchLen = trimmedQuery.length;
  // Centre the window around the match: spend a third of the cap before it,
  // the match itself, then the remainder after. Truncation flags drive the
  // leading/trailing ellipsis so the operator knows the row was clipped.
  const leadBudget = Math.floor((maxLen - matchLen) / 2);
  const startMax = Math.max(0, idx - leadBudget);
  const snippetStart = Math.max(0, Math.min(startMax, text.length - maxLen));
  const snippetEnd = Math.min(text.length, snippetStart + maxLen);
  const snippet = text.slice(snippetStart, snippetEnd);
  return {
    snippet,
    matchStart: idx - snippetStart,
    matchEnd: idx - snippetStart + matchLen,
    truncatedLead: snippetStart > 0,
    truncatedTail: snippetEnd < text.length,
  };
}

const SORTS: { value: string; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest first" },
  { value: "shortest", label: "Shortest first" },
  { value: "speaker", label: "Speaker A–Z" },
];

/** Rows visible per page in the scrollable list area. */
const TX_PAGE_SIZE = 5;

// "All" maps to the server's hard cap on a single response.
const VIEW_CAPS: { value: number; label: string }[] = [
  { value: 10, label: "10" },
  { value: 25, label: "25" },
  { value: 50, label: "50" },
  { value: 500, label: "All" },
];

/** A timestamp slug for export file names, e.g. 2026-05-16-14-03-22. */
function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(rows: Transmission[]): string {
  const header = [
    "ID",
    "Started",
    "Channel",
    "Speaker",
    "Unit",
    "Duration (s)",
    "Transcript status",
    "Transcript",
  ];
  const lines = [header.join(",")];
  for (const tx of rows) {
    lines.push(
      [
        tx.id,
        tx.started_at,
        tx.channel_name,
        tx.display_name ?? "",
        tx.unit_id ?? "",
        Math.round(tx.duration_ms / 1000),
        tx.transcript_status,
        tx.transcript ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Transcodes a WAV blob to MP3 in the browser (lamejs loaded on demand). */
async function wavToMp3(wav: Blob): Promise<Blob> {
  const { Mp3Encoder } = await import("lamejs");
  const ctx = new AudioContext();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await wav.arrayBuffer());
  } finally {
    void ctx.close();
  }
  const channel = buffer.getChannelData(0);
  const samples = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) {
    const s = Math.max(-1, Math.min(1, channel[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const encoder = new Mp3Encoder(1, buffer.sampleRate, 96);
  const chunks: Int8Array[] = [];
  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const part = encoder.encodeBuffer(samples.subarray(i, i + block));
    if (part.length > 0) {
      chunks.push(part);
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) {
    chunks.push(tail);
  }
  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}

/** "pcm" = original clear PCM from the recorder. "vocoder" = in-browser
 *  IMBE encode/decode roundtrip of that same PCM (what listeners heard). */
type PlayMode = "pcm" | "vocoder";

export function TransmissionLog() {
  const [items, setItems] = useState<Transmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Each transmission has two playable forms — the clean PCM the speaker's
  // mic captured (always stored), and what listeners actually heard over the
  // air (IMBE roundtrip, rendered on demand). Track which combination is
  // active so the buttons can show "Pause" vs "Play" correctly.
  const [playing, setPlaying] = useState<{ id: number; mode: PlayMode } | null>(null);
  const [busy, setBusy] = useState<{ id: number; mode: PlayMode } | null>(null);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [user, setUser] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState("newest");
  const [cap, setCap] = useState(25);
  const [page, setPage] = useState(0);
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const aliasFor = useUnitAliasResolver();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // One cache per playback mode — vocoder URLs are derived from the PCM blob
  // via an in-browser IMBE roundtrip, so the two are independent.
  const urlCache = useRef<Map<number, string>>(new Map());
  const vocodedUrlCache = useRef<Map<number, string>>(new Map());

  // Latest filters reachable from the polling timer without re-arming it.
  const filtersRef = useRef({ search, channelFilter, user, fromDate, toDate, sort, cap });
  filtersRef.current = { search, channelFilter, user, fromDate, toDate, sort, cap };

  const refresh = useCallback(async () => {
    try {
      const f = filtersRef.current;
      const res = await api.transmissions({
        search: f.search,
        channel: f.channelFilter,
        user: f.user,
        from: f.fromDate,
        to: f.toDate,
        sort: f.sort,
        limit: f.cap,
      });
      setItems(res.transmissions);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => setChannels(res.channels))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const cache = urlCache.current;
    const vocodedCache = vocodedUrlCache.current;
    return () => {
      window.clearInterval(timer);
      audioRef.current?.pause();
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
      vocodedCache.forEach((url) => URL.revokeObjectURL(url));
      vocodedCache.clear();
    };
  }, [refresh]);

  // Re-query (debounced) whenever any filter, sort, or the view cap changes.
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 250);
    return () => window.clearTimeout(timer);
  }, [search, channelFilter, user, fromDate, toDate, sort, cap, refresh]);

  useEffect(() => {
    setPage(0);
  }, [search, channelFilter, user, fromDate, toDate, sort, cap]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / TX_PAGE_SIZE));
    if (page > totalPages - 1) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [items.length, page]);

  const totalPages = Math.max(1, Math.ceil(items.length / TX_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * TX_PAGE_SIZE;
  const pageItems = items.slice(pageStart, pageStart + TX_PAGE_SIZE);

  // Keep the selection limited to rows still visible after a list change.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const visible = new Set(items.map((tx) => tx.id));
      const next = new Set<number>();
      prev.forEach((id) => visible.has(id) && next.add(id));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

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

  /**
   * Returns an object URL for the IMBE-roundtripped (vocoded) version of the
   * recording. Generated on first request by decoding the stored WAV, feeding
   * the PCM through {@link imbeRoundtripPcm16k}, and wrapping the result as
   * a fresh WAV blob. Cached so repeated playback doesn't re-encode.
   */
  const vocodedUrlFor = useCallback(async (id: number): Promise<string> => {
    const cached = vocodedUrlCache.current.get(id);
    if (cached) {
      return cached;
    }
    const blob = await fetchTransmissionAudio(id);
    // Parse the WAV header directly — decodeAudioData often reports 48 kHz
    // even for 16 kHz files from the recorder.
    const pcm16 = pcm16kFromTransmissionWav(await blob.arrayBuffer());
    const vocoded = await imbeRoundtripPcm16k(pcm16);
    const wav = pcm16ToWavBlob(vocoded, 16000);
    const url = URL.createObjectURL(wav);
    vocodedUrlCache.current.set(id, url);
    return url;
  }, []);

  /** Plays the requested mode for the given transmission. Clicking the active
   *  mode again pauses; clicking the other mode swaps. */
  async function play(id: number, mode: PlayMode) {
    if (playing && playing.id === id && playing.mode === mode && audioRef.current) {
      audioRef.current.pause();
      setPlaying(null);
      return;
    }
    setBusy({ id, mode });
    try {
      const url = mode === "vocoder" ? await vocodedUrlFor(id) : await objectUrlFor(id);
      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.onended = () => setPlaying(null);
        audioRef.current = audio;
      }
      audio.src = url;
      await audio.play();
      setPlaying({ id, mode });
    } catch (err) {
      setError(
        mode === "vocoder"
          ? `Could not render vocoder preview: ${describeError(err)}`
          : "Could not play that recording.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function download(id: number) {
    // Download is always the original PCM (matches the previous behaviour and
    // the on-disk format the recorder writes). The vocoder preview is a
    // playback-only A/B convenience, not an artifact users would archive.
    setBusy({ id, mode: "pcm" });
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
      setBusy(null);
    }
  }

  function clearFilters() {
    setSearch("");
    setChannelFilter("");
    setUser("");
    setFromDate("");
    setToDate("");
    setSort("newest");
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const selectedItems = items.filter((tx) => selected.has(tx.id));
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((tx) => tx.id)));
  }

  function exportCsv() {
    if (selectedItems.length === 0) {
      return;
    }
    downloadBlob(
      new Blob([buildCsv(selectedItems)], { type: "text/csv;charset=utf-8" }),
      `transmissions-${stamp()}.csv`,
    );
  }

  async function exportAudio(format: "wav" | "mp3") {
    const rows = selectedItems;
    if (rows.length === 0 || exportStatus) {
      return;
    }
    setError(null);
    try {
      const files: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < rows.length; i++) {
        setExportStatus(`Exporting audio… (${i + 1}/${rows.length})`);
        let blob = await fetchTransmissionAudio(rows[i].id);
        if (format === "mp3") {
          blob = await wavToMp3(blob);
        }
        files.push({ name: `transmission-${rows[i].id}.${format}`, blob });
      }
      if (files.length === 1) {
        downloadBlob(files[0].blob, files[0].name);
      } else {
        setExportStatus("Building archive…");
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        files.forEach((file) => zip.file(file.name, file.blob));
        downloadBlob(await zip.generateAsync({ type: "blob" }), `transmissions-${stamp()}.zip`);
      }
    } catch {
      setError("Audio export failed.");
    } finally {
      setExportStatus(null);
    }
  }

  const filtered =
    search.trim() !== "" ||
    channelFilter !== "" ||
    user.trim() !== "" ||
    fromDate !== "" ||
    toDate !== "" ||
    sort !== "newest";

  return (
    <div className="tx-log">
      <div className="tx-log-head">
        <h3>Transmission Log</h3>
        <span className="count">
          {items.length} loaded
          {items.length > TX_PAGE_SIZE
            ? ` · page ${safePage + 1} of ${totalPages}`
            : ""}
        </span>
      </div>

      <div className="tx-filters">
        <div className="tx-filter-row">
          <input
            className="tx-search"
            type="search"
            placeholder="Search transcripts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
            <option value="">All channels</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.name}>
                {channel.name}
              </option>
            ))}
          </select>
        </div>
        <div className="tx-filter-row">
          <input
            className="tx-search"
            type="text"
            placeholder="User or unit…"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="tx-filter-row tx-date-row">
          <label>
            From
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} />
          </label>
          {filtered && (
            <button className="btn sm" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {items.length > 0 && (
        <div className="tx-select-bar">
          <label className="tx-selectall">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
            {selectedItems.length > 0 ? `${selectedItems.length} selected` : "Select all"}
          </label>
          {selectedItems.length > 0 && (
            <div className="tx-export">
              <span className="tx-export-label">Export</span>
              <button className="btn sm" onClick={exportCsv} disabled={!!exportStatus}>
                CSV
              </button>
              <button className="btn sm" onClick={() => exportAudio("wav")} disabled={!!exportStatus}>
                WAV
              </button>
              <button className="btn sm" onClick={() => exportAudio("mp3")} disabled={!!exportStatus}>
                MP3
              </button>
              <button
                className="btn sm"
                onClick={() => setSelected(new Set())}
                disabled={!!exportStatus}
              >
                Clear
              </button>
            </div>
          )}
          {exportStatus && <span className="tx-export-status">{exportStatus}</span>}
        </div>
      )}

      <div className="tx-list">
        <div className="tx-list-scroll">
          {loading && <div className="empty">Loading…</div>}
          {!loading && items.length === 0 && (
            <div className="empty">
              {filtered ? "No transmissions match those filters." : "No recorded transmissions yet."}
            </div>
          )}
          {pageItems.map((tx) => {
          const transcript = transcriptOf(tx);
          const speaker = formatUnitSpeakerLabel(tx.unit_id, tx.display_name, aliasFor);
          return (
            <div className={selected.has(tx.id) ? "tx-card selected" : "tx-card"} key={tx.id}>
              <div className="tx-card-head">
                <input
                  type="checkbox"
                  className="tx-check"
                  checked={selected.has(tx.id)}
                  onChange={() => toggleSelect(tx.id)}
                />
                <span className="tx-speaker">{speaker}</span>
                <span className="tx-channel">{tx.channel_name}</span>
              </div>
              <div className="tx-card-sub">
                {formatTime(tx.started_at)} · {formatDuration(tx.duration_ms)}
              </div>
              <div className={transcript.muted ? "tx-transcript muted" : "tx-transcript"}>
                <TranscriptText text={transcript.text} query={transcript.muted ? "" : search} />
              </div>
              <div className="tx-card-actions">
                <PlayButton
                  id={tx.id}
                  mode="pcm"
                  label="Play PCM"
                  title="Clean PCM the speaker's mic captured (what the recorder stores)."
                  playing={playing}
                  busy={busy}
                  onClick={play}
                />
                <PlayButton
                  id={tx.id}
                  mode="vocoder"
                  label="Play vocoder"
                  title="What listeners heard over the air — IMBE encode/decode roundtrip of the same audio."
                  playing={playing}
                  busy={busy}
                  onClick={play}
                />
                <button
                  className="btn sm"
                  disabled={busy?.id === tx.id}
                  onClick={() => download(tx.id)}
                >
                  Download
                </button>
              </div>
            </div>
          );
          })}
        </div>
      </div>

      {items.length > TX_PAGE_SIZE && (
        <div className="tx-pagination" role="navigation" aria-label="Transmission log pages">
          <button
            type="button"
            className="btn sm"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Newer transmissions"
          >
            ‹ Newer
          </button>
          <span className="tx-page-indicator">
            Page {safePage + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            aria-label="Older transmissions"
          >
            Older ›
          </button>
        </div>
      )}

      <div className="tx-viewcap">
        <span>View</span>
        {VIEW_CAPS.map((option) => (
          <button
            key={option.value}
            className={cap === option.value ? "viewcap-btn active" : "viewcap-btn"}
            onClick={() => {
              setCap(option.value);
              setPage(0);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders a transcript line, optionally truncating to a snippet around the
 *  first match of `query` and wrapping that match in a styled span so the
 *  operator's eye lands on the hit. When `query` is empty the snippet falls
 *  back to the leading 120 chars — the existing visual shape stays unchanged
 *  for the non-search case. */
function TranscriptText({ text, query }: { text: string; query: string }) {
  const { snippet, matchStart, matchEnd, truncatedLead, truncatedTail } = highlightTranscriptSnippet(
    text,
    query,
  );
  const lead = truncatedLead ? "… " : "";
  const tail = truncatedTail ? " …" : "";
  if (matchStart < 0) {
    return (
      <>
        {lead}
        {snippet}
        {tail}
      </>
    );
  }
  return (
    <>
      {lead}
      {snippet.slice(0, matchStart)}
      <mark className="tx-transcript-hit">{snippet.slice(matchStart, matchEnd)}</mark>
      {snippet.slice(matchEnd)}
      {tail}
    </>
  );
}

/** Single per-row playback button used for both PCM and vocoder modes.
 *  Shows the right Pause / Play / … state given the current playing/busy
 *  selection so the user can see at a glance which version is active. */
function PlayButton({
  id,
  mode,
  label,
  title,
  playing,
  busy,
  onClick,
}: {
  id: number;
  mode: PlayMode;
  label: string;
  title: string;
  playing: { id: number; mode: PlayMode } | null;
  busy: { id: number; mode: PlayMode } | null;
  onClick: (id: number, mode: PlayMode) => void;
}) {
  const isPlaying = playing?.id === id && playing?.mode === mode;
  const isBusy = busy?.id === id && busy?.mode === mode;
  // Disable while a request for *this row* is in flight, no matter which mode
  // it's for — prevents the two buttons fighting over a shared <audio> element.
  const isRowBusy = busy?.id === id;
  return (
    <button
      className="btn sm"
      title={title}
      disabled={isRowBusy && !isBusy}
      onClick={() => onClick(id, mode)}
    >
      {isPlaying ? `Pause ${mode === "vocoder" ? "vocoder" : "PCM"}` : isBusy ? "…" : label}
    </button>
  );
}
