import { useEffect, useMemo, useState } from "react";
import {
  api,
  describeError,
  type Channel,
  type VoiceLinkCodecEntry,
  type VoiceLinkTimeseriesPoint,
  type VoiceLinkUnitSummary,
} from "../../api";
import {
  EmptyState,
  ErrorState,
  LineChart,
  LoadingState,
  TimeRangeSelector,
  type AnalyticsRange,
  ANALYTICS_RANGES,
} from "../../components/ui";
import { mergeLinkHealthRows, type LinkHealthRow } from "./linkHealthMerge";

/**
 * "Link Health" admin panel — surfaces per-unit inbound voice link quality from
 * `/v1/admin/voice-link-telemetry`, merged with live voice channel rosters so
 * every handset currently on a channel appears even before its first stats
 * report (~30 s). Map/GPS "online" counts can be higher — only units on voice
 * show here.
 *
 * Layout follows the same pattern as ChannelsPanel / AudioLabPanel:
 *   - Panel head with title + count.
 *   - Filter card: time range, channel filter, unit-id search.
 *   - Units table: row per unit with last-seen, PLC ratio, underruns, codec
 *     mix, health badge.
 *   - Selecting a row reveals the per-unit time-series detail (three small
 *     line charts: PLC %, buffer underruns, decoded frames per window).
 *
 * Charts reuse the shared `LineChart` primitive — no new chart library.
 */

type LoadState = "idle" | "loading" | "ready" | "error";

interface HealthClassification {
  badge: "green" | "yellow" | "orange" | "red" | "unknown";
  label: string;
  description: string;
}

function rangeToMs(range: AnalyticsRange): number {
  const entry = ANALYTICS_RANGES.find((r) => r.value === range);
  return (entry?.days ?? 1) * 24 * 60 * 60 * 1000;
}

function plcRatio(plc: number, decoded: number): number {
  if (!Number.isFinite(plc) || plc <= 0) return 0;
  if (!Number.isFinite(decoded) || decoded <= 0) return plc > 0 ? 1 : 0;
  return Math.min(1, plc / (plc + decoded));
}

/** Mirrors the server-side `classifyHealth` thresholds so the badge stays
 *  consistent whether the aggregate is rendered server-side or fresh from a
 *  re-derived client view. The duplicate is small; the consistency is worth
 *  it.
 *
 *  Badge basis: the unit's most recent HOUR of reports (hidden-tab console
 *  windows excluded), when the server provides those counters — so the badge
 *  answers "how is this link right now", not "did anything bad happen in the
 *  whole range". Older servers omit the recent fields; we fall back to the
 *  range totals. */
function classifyTelemetry(u: VoiceLinkUnitSummary): HealthClassification {
  const hasRecent = typeof u.recent_reports === "number";
  const reports = hasRecent ? u.recent_reports! : u.reports;
  const decoded = hasRecent ? u.recent_frames_decoded ?? 0 : u.frames_decoded;
  const plc = hasRecent ? u.recent_plc_frames_synthesized ?? 0 : u.plc_frames_synthesized;
  const underruns = hasRecent ? u.recent_buffer_underruns ?? 0 : u.buffer_underruns;
  const hiddenReports = u.recent_hidden_reports ?? 0;

  // A console whose recent windows ALL came from a hidden tab isn't degraded —
  // browsers throttle background-tab timers, which starves the jitter buffer
  // and manufactures PLC. Label it for what it is.
  if (hasRecent && reports === 0 && hiddenReports > 0) {
    return {
      badge: "unknown",
      label: "Background tab",
      description:
        "Console tab was in the background for its recent reports. Browsers throttle hidden tabs, " +
        "so quality counters from those windows reflect throttling, not the network.",
    };
  }
  if (decoded === 0 && plc === 0) {
    return {
      badge: "unknown",
      label: "Idle",
      description: "No audio frames received in the last hour of reports — unit connected but silent.",
    };
  }
  const ratio = plcRatio(plc, decoded);
  const underrunsPerWindow = reports > 0 ? underruns / reports : underruns;
  if (ratio < 0.01 && underruns === 0) {
    return {
      badge: "green",
      label: "Good",
      description: "Clean link — under 1 % PLC and no buffer underruns in the last hour of reports.",
    };
  }
  if (ratio < 0.05 && underrunsPerWindow < 3) {
    return {
      badge: "yellow",
      label: "Fair",
      description: "Some smoothing — under 5 % PLC and occasional underruns in the last hour. Watch.",
    };
  }
  if (ratio < 0.15 && underrunsPerWindow < 15) {
    return {
      badge: "orange",
      label: "Marginal",
      description:
        "Audible smoothing — 5–15 % PLC in the last hour of reports. Usable but check coverage " +
        "if it persists.",
    };
  }
  return {
    badge: "red",
    label: "Degraded",
    description: "Operator-noticeable cutout — over 15 % PLC or frequent underruns in the last hour.",
  };
}

function classifyRow(row: LinkHealthRow): HealthClassification {
  if (row.telemetry) {
    return classifyTelemetry(row.telemetry);
  }
  if (row.connected_now) {
    return {
      badge: "unknown",
      label: "On channel",
      description:
        "Unit is on a voice channel now. Link stats appear after the app sends its first ~30 s report " +
        "(update the handset app if this stays empty for several minutes).",
    };
  }
  return {
    badge: "unknown",
    label: "No data",
    description: "No stats in this time range and the unit is not on a voice channel right now.",
  };
}

function lastSeenLabel(row: LinkHealthRow): string {
  if (row.connected_now && !row.telemetry) {
    return "On channel now";
  }
  if (row.connected_now && row.telemetry) {
    return `On channel · stats ${formatRelative(row.telemetry.last_seen)}`;
  }
  if (row.telemetry) {
    return formatRelative(row.telemetry.last_seen);
  }
  return "—";
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function codecMixLabel(mix: Record<string, VoiceLinkCodecEntry> | null | undefined): string {
  if (!mix) return "—";
  const entries = Object.entries(mix);
  if (entries.length === 0) return "—";
  const total = entries.reduce((acc, [, v]) => acc + (v.framesDecoded ?? 0), 0);
  if (total <= 0) return entries.map(([k]) => k).join(", ");
  return entries
    .map(([k, v]) => `${k}: ${Math.round(((v.framesDecoded ?? 0) / total) * 100)}%`)
    .join(", ");
}

function bucketLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "512 B" / "3.4 KB" / "12.7 MB" / "1.2 GB" — for the per-unit data-usage column. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Voice data used over the window: app-level voice bytes down + up. Older
 *  handset builds report only the download side (`bytes_sent` arrives as 0),
 *  so the cell shows the split rather than a single total that would silently
 *  under-count for them. */
function dataUsedLabel(t: VoiceLinkUnitSummary): string {
  return `↓ ${formatBytes(t.bytes_received)} · ↑ ${formatBytes(t.bytes_sent ?? 0)}`;
}

export function VoiceLinkPanel() {
  const [range, setRange] = useState<AnalyticsRange>("24h");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [rows, setRows] = useState<LinkHealthRow[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [windows, setWindows] = useState<VoiceLinkTimeseriesPoint[] | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Published Android build, for the "out of date" flag in the App column. */
  const [publishedVersionCode, setPublishedVersionCode] = useState<number | null>(null);
  /** Per-unit OTA push state: in-flight unit ids and last result message. */
  const [pushingUnit, setPushingUnit] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<Record<string, string>>({});

  async function pushUpdate(unitId: string) {
    setPushingUnit(unitId);
    setPushResult((prev) => ({ ...prev, [unitId]: "" }));
    try {
      const res = await api.sendDeviceCommand(unitId, "check_update");
      setPushResult((prev) => ({
        ...prev,
        [unitId]: res.reached > 0 ? "Update pushed — radio is checking & installing" : "Radio offline",
      }));
    } catch (err) {
      setPushResult((prev) => ({ ...prev, [unitId]: describeError(err) }));
    } finally {
      setPushingUnit(null);
    }
  }

  // --- top-level fetch -----------------------------------------------------

  async function reload() {
    setState("loading");
    setError(null);
    try {
      const [chRes, telemetryRes, rosterRes] = await Promise.all([
        api.listChannels().catch(() => ({ channels: [] as Channel[] })),
        api.listVoiceLinkTelemetry({
          sinceMs: rangeToMs(range),
          channel: channelFilter || undefined,
        }),
        api.channelRosters().catch(() => ({ channels: [] as { channel: string; members: [] }[] })),
      ]);
      setChannels(chRes.channels);
      setRows(mergeLinkHealthRows(telemetryRes.units, rosterRes.channels, channelFilter));
      api
        .getAndroidAppRelease()
        .then((r) => setPublishedVersionCode(r.versionCode ?? null))
        .catch(() => undefined);
      setState("ready");
    } catch (err) {
      setError(describeError(err));
      setState("error");
    }
  }

  useEffect(() => {
    void reload();
    // Refresh every 30 s so the dashboard stays close to live without forcing
    // operators to keep hitting reload — same cadence as the client reporter.
    const id = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, channelFilter]);

  // --- detail fetch --------------------------------------------------------

  useEffect(() => {
    if (!selectedUnit) {
      setWindows(null);
      setDetailState("idle");
      return;
    }
    let cancelled = false;
    async function go() {
      setDetailState("loading");
      setDetailError(null);
      try {
        const res = await api.getVoiceLinkUnitTimeseries(selectedUnit!, {
          sinceMs: rangeToMs(range),
          channel: channelFilter || undefined,
        });
        if (cancelled) return;
        setWindows(res.windows);
        setDetailState("ready");
      } catch (err) {
        if (cancelled) return;
        setDetailError(describeError(err));
        setDetailState("error");
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [selectedUnit, range, channelFilter]);

  // --- derived view --------------------------------------------------------

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.unit_id.toLowerCase().includes(q));
  }, [rows, search]);

  const headCounts = useMemo(() => {
    const onVoice = rows.filter((r) => r.connected_now).length;
    const withStats = rows.filter((r) => r.telemetry != null).length;
    return { total: rows.length, onVoice, withStats };
  }, [rows]);

  const selected = useMemo(
    () => (selectedUnit ? filteredRows.find((r) => r.unit_id === selectedUnit) ?? null : null),
    [selectedUnit, filteredRows],
  );

  // Charts — three series derived from the per-window points. Sized down to
  // ~32 buckets so a 24 h × 30 s = 2880-point series doesn't render a wall of
  // 2880 SVG nodes. Each bucket sums underruns / PLC / decoded across the
  // windows that fall into it.
  const chartSeries = useMemo(() => {
    if (!windows || windows.length === 0) {
      return null;
    }
    const buckets = 32;
    const t0 = Date.parse(windows[0]!.server_ts);
    const tN = Date.parse(windows[windows.length - 1]!.server_ts);
    if (!Number.isFinite(t0) || !Number.isFinite(tN) || tN <= t0) {
      // Fall back to point-per-window when timestamps are unusable.
      return {
        plc: windows.map((w) => ({
          label: bucketLabel(w.server_ts),
          value: Math.round(plcRatio(w.plc_frames_synthesized, w.frames_decoded) * 1000),
        })),
        underruns: windows.map((w) => ({
          label: bucketLabel(w.server_ts),
          value: w.buffer_underruns,
        })),
        decoded: windows.map((w) => ({
          label: bucketLabel(w.server_ts),
          value: w.frames_decoded,
        })),
      };
    }
    const stepMs = (tN - t0) / buckets;
    const acc: { plcN: number; plcD: number; underruns: number; decoded: number; iso: string }[] =
      Array.from({ length: buckets }, () => ({
        plcN: 0,
        plcD: 0,
        underruns: 0,
        decoded: 0,
        iso: "",
      }));
    for (const w of windows) {
      const t = Date.parse(w.server_ts);
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((t - t0) / stepMs)));
      const slot = acc[idx]!;
      slot.plcN += w.plc_frames_synthesized;
      slot.plcD += w.frames_decoded;
      slot.underruns += w.buffer_underruns;
      slot.decoded += w.frames_decoded;
      // First non-empty server_ts in the bucket labels it.
      if (!slot.iso) slot.iso = w.server_ts;
    }
    // Carry forward a bucket label so empty buckets still get a sensible
    // X-axis hint even when no window fell in them.
    let lastIso = windows[0]!.server_ts;
    for (const slot of acc) {
      if (!slot.iso) slot.iso = lastIso;
      else lastIso = slot.iso;
    }
    return {
      plc: acc.map((s) => ({
        label: bucketLabel(s.iso),
        // Scaled to per-mille so a 1 % PLC reads as "10" — keeps the integer
        // axis labels in `LineChart` readable.
        value: Math.round(plcRatio(s.plcN, s.plcD) * 1000),
      })),
      underruns: acc.map((s) => ({ label: bucketLabel(s.iso), value: s.underruns })),
      decoded: acc.map((s) => ({ label: bucketLabel(s.iso), value: s.decoded })),
    };
  }, [windows]);

  return (
    <div>
      <div className="panel-head">
        <h2>Link Health</h2>
        <span className="count">
          {filteredRows.length} shown
          {headCounts.total > 0
            ? ` · ${headCounts.onVoice} on voice · ${headCounts.withStats} with stats`
            : ""}
        </span>
      </div>
      <p className="panel-desc">
        Inbound voice quality per unit — jitter buffer underruns, PLC frames synthesised,
        decode failures, frames received per codec, and voice data usage (downloaded /
        uploaded) over the range. The table lists everyone currently
        on a voice channel plus any unit that posted stats in the time range (about every
        30 s from the handset app). This is not the same as GPS/map &ldquo;online&rdquo; —
        a radio must be tuned to a channel here. The <strong>Health</strong> badge reflects the
        unit&rsquo;s most recent hour of reports (Good &lt;1% PLC · Fair &lt;5% · Marginal &lt;15% ·
        Degraded above), and console windows from background browser tabs are excluded — hidden
        tabs are timer-throttled and report phantom packet loss. Click a unit for trend charts
        when stats exist.
      </p>

      <div className="card">
        <div className="form-row">
          <div className="field">
            <label>Time range</label>
            <TimeRangeSelector value={range} onChange={setRange} disabled={state === "loading"} />
          </div>
          <div className="field">
            <label>Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              disabled={state === "loading"}
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Unit search</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by unit id…"
            />
          </div>
          <button className="btn sm" onClick={() => void reload()} disabled={state === "loading"}>
            {state === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {state === "loading" && rows.length === 0 ? (
        <LoadingState label="Loading link health" />
      ) : state === "error" && rows.length === 0 ? (
        <ErrorState title="Couldn't load link health" detail={error ?? undefined} onRetry={() => void reload()} />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title="No units in this view"
          description={
            search
              ? "No units match the current search. Try clearing the filter."
              : "No handsets are on a voice channel right now, and none posted link stats in this time range. Open a channel on a radio and wait ~30 s for the first stats row."
          }
        />
      ) : (
        <table className="vlt-units">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Status</th>
              <th>App</th>
              <th>PLC ratio</th>
              <th>Underruns</th>
              <th>Decode fail</th>
              <th>Decoded</th>
              <th>Data used</th>
              <th>Codec mix</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const t = row.telemetry;
              const ratio = t
                ? plcRatio(t.plc_frames_synthesized, t.frames_decoded)
                : null;
              const h = classifyRow(row);
              const selectedRow = row.unit_id === selectedUnit;
              const channelHint =
                row.connected_channels.length > 0
                  ? row.connected_channels.join(", ")
                  : t?.channels?.join(", ") ?? "";
              return (
                <tr
                  key={row.unit_id}
                  className={selectedRow ? "selected" : undefined}
                  onClick={() =>
                    setSelectedUnit((prev) => (prev === row.unit_id ? null : row.unit_id))
                  }
                  style={{ cursor: "pointer" }}
                  title={channelHint ? `Channels: ${channelHint}` : undefined}
                >
                  <td>
                    <code className="mono">{row.unit_id}</code>
                    {row.roster_client ? (
                      <span className="muted small" style={{ display: "block" }}>
                        {row.roster_client}
                      </span>
                    ) : null}
                  </td>
                  <td>{lastSeenLabel(row)}</td>
                  <td>
                    {t?.app_version_name ? (
                      <>
                        <span className="mono small">{t.app_version_name}</span>
                        {publishedVersionCode != null &&
                        t.app_version_code != null &&
                        t.app_version_code < publishedVersionCode ? (
                          <>
                            <span
                              className="pill off small"
                              style={{ marginLeft: 6 }}
                              title={`Latest published build is ${publishedVersionCode}`}
                            >
                              OUT OF DATE
                            </span>
                            {row.connected_now ? (
                              <button
                                className="btn sm"
                                style={{ marginLeft: 6 }}
                                disabled={pushingUnit === row.unit_id}
                                title="Push the latest build to this online radio (it installs touchlessly)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void pushUpdate(row.unit_id);
                                }}
                              >
                                {pushingUnit === row.unit_id ? "Pushing…" : "Push update"}
                              </button>
                            ) : null}
                            {pushResult[row.unit_id] ? (
                              <span className="muted small" style={{ display: "block" }}>
                                {pushResult[row.unit_id]}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{ratio != null ? `${(ratio * 100).toFixed(2)}%` : "—"}</td>
                  <td>{t != null ? t.buffer_underruns : "—"}</td>
                  <td>{t != null ? t.decode_failures : "—"}</td>
                  <td>{t != null ? t.frames_decoded.toLocaleString() : "—"}</td>
                  <td title="Voice data over the selected range — ↓ received by the device, ↑ transmitted from it (app-level voice frames + recorder sideband, not total cellular usage).">
                    {t != null ? dataUsedLabel(t) : "—"}
                  </td>
                  <td>{t != null ? codecMixLabel(t.codec_mix) : "—"}</td>
                  <td>
                    <span
                      className={`vlt-badge vlt-badge-${h.badge}`}
                      title={h.description}
                    >
                      {h.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="card">
          <div className="panel-head" style={{ marginTop: 0 }}>
            <h3>
              Detail — <code className="mono">{selected.unit_id}</code>
            </h3>
            <button className="btn sm" onClick={() => setSelectedUnit(null)}>
              Close
            </button>
          </div>
          {detailState === "loading" ? (
            <LoadingState label="Loading time series" />
          ) : detailState === "error" ? (
            <ErrorState
              title="Couldn't load detail"
              detail={detailError ?? undefined}
              onRetry={() => setSelectedUnit(selected.unit_id)}
            />
          ) : !selected.telemetry ? (
            <EmptyState
              title={
                selected.connected_now
                  ? "On channel — stats not in yet"
                  : "No stats in this time range"
              }
              description={
                selected.connected_now
                  ? "This unit is on voice now. Wait one or two ~30 s reporter intervals, or update the handset app if nothing appears after a few minutes."
                  : "This unit is not on a voice channel now and did not post link telemetry during the selected time range."
              }
            />
          ) : !chartSeries ? (
            <EmptyState
              title="No windows reported for this unit yet"
              description="Wait one or two reporter intervals (~30 s each) for the first data points."
            />
          ) : (
            <div className="vlt-charts">
              <div className="vlt-chart">
                <div className="vlt-chart-title">PLC ratio (per mille — 10 = 1 %)</div>
                <LineChart points={chartSeries.plc} area />
              </div>
              <div className="vlt-chart">
                <div className="vlt-chart-title">Buffer underruns (count per bucket)</div>
                <LineChart points={chartSeries.underruns} area />
              </div>
              <div className="vlt-chart">
                <div className="vlt-chart-title">Frames decoded</div>
                <LineChart points={chartSeries.decoded} area />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
