import { useCallback, useEffect, useState } from "react";
import { api, describeError, type AiDispatchActivityEntry } from "../api";
import { Topbar } from "../Topbar";

function outcomeLabel(outcome: string | null | undefined): { text: string; className: string } {
  switch (outcome) {
    case "processed":
      return { text: "AI replied on radio", className: "ai-outcome-processed" };
    case "no_on_air_reply":
      return { text: "Processed — no voice", className: "ai-outcome-skip" };
    case "tts_failed":
      return { text: "Reply failed (TTS/play)", className: "ai-outcome-skip" };
    case "followup_info":
      return { text: "Follow-up answer", className: "ai-outcome-followup" };
    case "skipped_channel_off":
      return { text: "Skipped — AI OFF on channel", className: "ai-outcome-skip" };
    case "skipped_supervised_no_keyword":
      return { text: "Skipped — supervised, no “AI” wake word", className: "ai-outcome-skip" };
    case "skipped_no_speech":
      return { text: "Skipped — no speech", className: "ai-outcome-skip" };
    case "skipped_duplicate":
      return { text: "Skipped — duplicate/simulcast", className: "ai-outcome-skip" };
    case "skipped_dispatch_unit":
      return { text: "Skipped — AI voice TX", className: "ai-outcome-skip" };
    case "skipped_stale":
      return { text: "Logged only — too old to air", className: "ai-outcome-skip" };
    default:
      return { text: outcome ?? "Unknown", className: "ai-outcome-skip" };
  }
}

/** Full VIN with the last six characters bold, monospaced (operators scan the
 * last six). */
function VinDisplay({ vin }: { vin: string }) {
  const v = vin.toUpperCase();
  const head = v.length > 6 ? v.slice(0, -6) : "";
  const tail = v.length > 6 ? v.slice(-6) : v;
  return (
    <span style={{ fontFamily: "monospace", marginLeft: "0.4rem" }}>
      <span className="muted">VIN </span>
      {head}
      <strong>{tail}</strong>
    </span>
  );
}

function EntryCard({ entry }: { entry: AiDispatchActivityEntry }) {
  const badge = outcomeLabel(entry.outcome);
  const isSkip = entry.outcome?.startsWith("skipped_") === true;

  return (
    <article
      className={`ai-activity-entry${isSkip ? " ai-activity-entry--skip" : ""}`}
      style={{
        border: "1px solid var(--border, #333)",
        borderRadius: 8,
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
        opacity: isSkip ? 0.85 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>
          {entry.unit_id ?? "—"} · {entry.channel_name ?? "—"}
        </strong>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {new Date(entry.created_at).toLocaleString()}
        </span>
      </div>
      <p style={{ margin: "0.35rem 0 0.5rem" }}>
        <span
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            padding: "0.15rem 0.45rem",
            borderRadius: 4,
            background: isSkip ? "rgba(255, 180, 77, 0.15)" : "rgba(100, 200, 120, 0.15)",
          }}
        >
          {badge.text}
        </span>
        {entry.transmission_id != null && (
          <span className="muted" style={{ marginLeft: 8, fontSize: "0.8rem" }}>
            TX #{entry.transmission_id}
          </span>
        )}
      </p>
      <p style={{ margin: "0.5rem 0", fontStyle: "italic" }}>&ldquo;{entry.transcript}&rdquo;</p>
      {entry.intent && (
        <p style={{ margin: "0.25rem 0" }}>
          <span className="muted">Intent:</span> {entry.intent}
          {entry.trigger_emergency_tone && (
            <span style={{ color: "var(--warn, #ffb84d)", marginLeft: 8 }}>10-33</span>
          )}
        </p>
      )}
      {entry.summary && (
        <p style={{ margin: "0.25rem 0" }}>
          <span className="muted">Summary:</span> {entry.summary}
        </p>
      )}
      {entry.dispatcher_response && (
        <p style={{ margin: "0.25rem 0" }}>
          <span className="muted">On air:</span> {entry.dispatcher_response}
        </p>
      )}
      {entry.plate_lookup && (
        <p style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
          <span className="muted">Plate lookup:</span>{" "}
          {entry.plate_lookup.plate && (
            <strong style={{ fontFamily: "monospace" }}>
              {entry.plate_lookup.plate}
              {entry.plate_lookup.state ? ` (${entry.plate_lookup.state})` : ""}{" "}
            </strong>
          )}
          {entry.plate_lookup.ok
            ? [
                entry.plate_lookup.year,
                entry.plate_lookup.make,
                entry.plate_lookup.model,
                entry.plate_lookup.color,
              ]
                .filter(Boolean)
                .join(" ") || "valid, no details on file"
            : entry.plate_lookup.reason === "no_record"
              ? "no record on file"
              : entry.plate_lookup.reason ?? "failed"}
          {entry.plate_lookup.vin && <VinDisplay vin={entry.plate_lookup.vin} />}
        </p>
      )}
      {entry.error && (
        <p className={isSkip ? "muted" : "error"} style={{ margin: "0.25rem 0" }}>
          {entry.error}
        </p>
      )}
    </article>
  );
}

export function AiActivityPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getAiDispatchActivity>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getAiDispatchActivity(150);
      setData(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const processed =
    data?.entries.filter((e) => e.outcome === "processed" || e.outcome === "followup_info").length ?? 0;
  const skipped = (data?.entries.length ?? 0) - processed;

  return (
    <div className="app-shell">
      <Topbar section="console" />
      <main className="ai-activity-page" style={{ padding: "1rem 1.25rem", maxWidth: "56rem" }}>
        <h1 style={{ margin: "0 0 0.35rem" }}>AI dispatch activity</h1>
        <p className="muted" style={{ margin: "0 0 0.5rem" }}>
          Every transmission the AI dispatch engine <strong>looked at</strong> on channels with AI enabled.
          Refreshes every 5 seconds.
        </p>
        <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
          The <strong>transmission log</strong> on the dispatch console shows <em>all</em> recorded radio traffic.
          This page only shows traffic where AI dispatch ran (or skipped with a reason). If you only see 1–2
          &ldquo;AI replied&rdquo; lines but many transmissions elsewhere, check for yellow &ldquo;Skipped&rdquo;
          lines — usually <strong>AI dispatch OFF on that channel</strong> or <strong>no speech detected</strong>.
        </p>
        {error && <p className="error">{error}</p>}
        {loading && !data && <p className="muted">Loading…</p>}

        {data && data.entries.length > 0 && (
          <p className="muted" style={{ marginBottom: "1rem", fontSize: "0.9rem" }}>
            Showing {data.entries.length} events — {processed} with AI reply, {skipped} skipped
          </p>
        )}

        {data && data.ten8_active_incidents.length > 0 && (
          <section style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ fontSize: "1rem" }}>10-8 active incidents</h2>
            <ul className="muted">
              {data.ten8_active_incidents.map((inc) => (
                <li key={inc.call_id}>
                  <strong>{inc.call_id}</strong> — {inc.incident_type ?? "Unknown"} @ {inc.location ?? "—"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {data?.entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} />
        ))}

        {data && data.entries.length === 0 && !loading && (
          <p className="muted">No AI dispatch events yet. Enable AI dispatch on a channel and transmit.</p>
        )}
      </main>
    </div>
  );
}
