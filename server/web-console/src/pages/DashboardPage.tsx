import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Topbar } from "../Topbar";
import {
  api,
  type Alert,
  type AiDispatchActivityEntry,
  type RadioPosition,
  type Transmission,
} from "../api";
import { useUnitAliasResolver } from "../unitAliases";
import { IconBolt, IconRadio, IconAlertTriangle, IconMapPin, IconShield } from "../icons";

const POLL_MS = 8000;
/** A radio that reported within this window counts as online. */
const ONLINE_MS = 5 * 60_000;
/** GPS speed (m/s) above which an online unit is "driving" (~11 km/h). */
const DRIVING_SPEED_MPS = 3;

type FeedKind = "emergency" | "page" | "transmission" | "ai";

interface FeedItem {
  key: string;
  ts: number;
  kind: FeedKind;
  title: string;
  detail: string | null;
  channel: string | null;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 45_000) {
    return "now";
  }
  const min = Math.floor(ms / 60_000);
  if (min < 60) {
    return `${min}m`;
  }
  const hrs = Math.floor(min / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
}

function clamp(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Mission-control overview: status cards, active incidents, and a live activity feed. */
export function DashboardPage() {
  const aliasFor = useUnitAliasResolver();
  const [positions, setPositions] = useState<RadioPosition[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [aiEntries, setAiEntries] = useState<AiDispatchActivityEntry[]>([]);
  const [channelCount, setChannelCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => setChannelCount(res.channels.length))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const [loc, alr, tx, ai] = await Promise.allSettled([
        api.locations(),
        api.alerts(),
        api.transmissions({ limit: 40, sort: "newest" }),
        api.getAiDispatchActivity(30),
      ]);
      if (cancelled) {
        return;
      }
      if (loc.status === "fulfilled") setPositions(loc.value.positions);
      if (alr.status === "fulfilled") setAlerts(alr.value.alerts);
      if (tx.status === "fulfilled") setTransmissions(tx.value.transmissions);
      if (ai.status === "fulfilled") setAiEntries(ai.value.entries);
      setError(loc.status === "rejected" ? "Could not load live data." : null);
    }
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const now = Date.now();
  const online = positions.filter((p) => now - new Date(p.updated_at).getTime() < ONLINE_MS);
  const driving = online.filter((p) => (p.speed_mps ?? 0) >= DRIVING_SPEED_MPS);
  const incidents = alerts.filter((a) => a.kind === "emergency" && a.active);
  const txLastHour = transmissions.filter(
    (t) => now - new Date(t.started_at).getTime() < 3_600_000,
  );

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const a of alerts) {
      items.push({
        key: `alert-${a.id}`,
        ts: new Date(a.created_at).getTime(),
        kind: a.kind === "emergency" ? "emergency" : "page",
        title:
          a.kind === "emergency"
            ? `Emergency — ${a.from_unit ? aliasFor(a.from_unit) : a.from_name ?? "unit"}`
            : `Page${a.target_unit ? ` → ${aliasFor(a.target_unit)}` : ""}`,
        detail: a.message ? clamp(a.message) : a.active ? "Active" : "Cleared",
        channel: a.channel_name,
      });
    }
    for (const t of transmissions) {
      items.push({
        key: `tx-${t.id}`,
        ts: new Date(t.started_at).getTime(),
        kind: "transmission",
        title: t.display_name || (t.unit_id ? aliasFor(t.unit_id) : "Transmission"),
        detail: t.transcript ? clamp(t.transcript) : null,
        channel: t.channel_name,
      });
    }
    for (const e of aiEntries) {
      items.push({
        key: `ai-${e.id}`,
        ts: new Date(e.created_at).getTime(),
        kind: "ai",
        title: `AI dispatch${e.unit_id ? ` · ${aliasFor(e.unit_id)}` : ""}`,
        detail: clamp(e.summary || e.dispatcher_response || e.intent || e.transcript || ""),
        channel: e.channel_name,
      });
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 50);
  }, [alerts, transmissions, aiEntries, aliasFor]);

  return (
    <div className="app-shell">
      <Topbar section="console" />

      <div className="dash">
        <div className="dash-head">
          <h1>Mission Control</h1>
          <Link className="btn sm" to="/console">
            Open channel console
          </Link>
        </div>

        {error && <div className="banner error">{error}</div>}

        <div className="dash-cards">
          <div className={`dash-card incidents${incidents.length > 0 ? " alarm" : ""}`}>
            <span className="dash-card-icon">
              <IconAlertTriangle size={20} />
            </span>
            <span className="dash-card-value">{incidents.length}</span>
            <span className="dash-card-label">Active incidents</span>
          </div>
          <div className="dash-card online">
            <span className="dash-card-icon">
              <IconRadio size={20} />
            </span>
            <span className="dash-card-value">{online.length}</span>
            <span className="dash-card-label">Units online</span>
          </div>
          <div className="dash-card driving">
            <span className="dash-card-icon">
              <IconMapPin size={20} />
            </span>
            <span className="dash-card-value">{driving.length}</span>
            <span className="dash-card-label">Driving now</span>
          </div>
          <div className="dash-card">
            <span className="dash-card-icon">
              <IconBolt size={20} />
            </span>
            <span className="dash-card-value">{txLastHour.length}</span>
            <span className="dash-card-label">Transmissions / hr</span>
          </div>
          <div className="dash-card">
            <span className="dash-card-icon">
              <IconShield size={20} />
            </span>
            <span className="dash-card-value">{channelCount ?? "—"}</span>
            <span className="dash-card-label">Channels</span>
          </div>
        </div>

        <div className="dash-grid">
          <section className="dash-panel">
            <div className="dash-panel-head">
              <h2>Active incidents</h2>
              <span className="count">{incidents.length}</span>
            </div>
            {incidents.length === 0 ? (
              <div className="dash-empty">All clear — no active emergencies.</div>
            ) : (
              <div className="incident-list">
                {incidents.map((a) => (
                  <div className="incident-card" key={a.id}>
                    <div className="incident-top">
                      <span className="incident-unit">
                        {a.from_unit ? aliasFor(a.from_unit) : a.from_name ?? "Unit"}
                      </span>
                      <span className="incident-time">{ago(a.created_at)}</span>
                    </div>
                    <div className="incident-msg">{a.message || "Emergency activation"}</div>
                    {a.channel_name && <div className="incident-chan">{a.channel_name}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <h2>Live activity</h2>
            </div>
            {feed.length === 0 ? (
              <div className="dash-empty">No recent activity.</div>
            ) : (
              <ul className="feed">
                {feed.map((item) => (
                  <li className={`feed-item ${item.kind}`} key={item.key}>
                    <span className="feed-dot" />
                    <div className="feed-body">
                      <div className="feed-line">
                        <span className="feed-title">{item.title}</span>
                        {item.channel && <span className="feed-chan">{item.channel}</span>}
                        <span className="feed-time">{ago(new Date(item.ts).toISOString())}</span>
                      </div>
                      {item.detail && <div className="feed-detail">{item.detail}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
