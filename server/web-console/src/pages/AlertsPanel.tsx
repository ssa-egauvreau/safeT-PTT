import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  describeError,
  uploadAlertImage,
  fetchAlertImage,
  type Alert,
  type UserChannel,
} from "../api";
import { sounds } from "../sounds";
import { useUnitAliasResolver } from "../unitAliases";
import { IconAlertTriangle, IconBell } from "../icons";
import { SectionHeader, type SectionProps } from "./PopOutSection";

type AlertKind = "page" | "emergency";

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Raises an OS-level notification for a new emergency, when the user has granted permission. */
function notifyEmergency(alert: Alert): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const from = alert.from_unit || alert.from_name || "Unknown unit";
  const where = alert.channel_name ?? "All channels";
  try {
    const note = new Notification("EMERGENCY", {
      body: `${from} · ${where}${alert.message ? `\n${alert.message}` : ""}`,
      tag: `emergency-${alert.id}`,
      requireInteraction: true,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    /* notification construction can throw on some platforms — non-fatal */
  }
}

/** Lazy-loads and shows a page's picture attachment; click opens it full-size. */
function AlertThumb({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    fetchAlertImage(id)
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        revoked = objUrl;
        setUrl(objUrl);
      })
      .catch(() => undefined);
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id]);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="alert-thumb">
      <img src={url} alt="attachment" />
    </a>
  );
}

export function AlertsPanel({ variant = "embedded", onPopOut }: SectionProps) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [kind, setKind] = useState<AlertKind>("page");
  const [channelName, setChannelName] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<"broadcast" | "unit">("broadcast");
  const [targetUnit, setTargetUnit] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const seenEmergencies = useRef<Set<number>>(new Set());
  const primed = useRef(false);
  const aliasFor = useUnitAliasResolver();

  async function refresh() {
    try {
      const res = await api.alerts();
      setAlerts(res.alerts);
      const active = res.alerts.filter((a) => a.kind === "emergency" && a.active);
      const fresh = active.filter((a) => !seenEmergencies.current.has(a.id));
      active.forEach((a) => seenEmergencies.current.add(a.id));
      const isNew = primed.current && fresh.length > 0;
      primed.current = true;
      if (isNew) {
        sounds.emergency();
        fresh.forEach(notifyEmergency);
      }
    } catch {
      /* keep last snapshot */
    }
  }

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    api
      .myChannels()
      .then((res) => setChannels(res.channels))
      .catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (kind === "page" && !message.trim()) {
      setError("Enter a page message.");
      return;
    }
    const unit = audience === "unit" ? targetUnit.trim().toUpperCase() : null;
    if (audience === "unit" && !unit) {
      setError("Enter a unit ID, or switch to broadcast.");
      return;
    }
    setSending(true);
    try {
      const { alert } = await api.sendAlert({
        kind,
        // A targeted page goes to one unit regardless of channel; a broadcast
        // can still be scoped to a channel.
        channelName: unit ? null : channelName || null,
        targetUnit: unit,
        message: message.trim() || null,
      });
      if (imageFile && alert?.id) {
        await uploadAlertImage(alert.id, imageFile);
      }
      setMessage("");
      setImageFile(null);
      if (imageInputRef.current) imageInputRef.current.value = "";
      // Emergencies get their own loud tone via refresh(); a page just needs the cue.
      if (kind === "page") {
        sounds.success();
      }
      await refresh();
    } catch (err) {
      sounds.error();
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  async function clear(id: number) {
    setError(null);
    try {
      await api.clearAlert(id);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const activeEmergencies = alerts.filter((a) => a.kind === "emergency" && a.active);
  const history = alerts.filter((a) => !(a.kind === "emergency" && a.active));

  return (
    <div className={variant === "window" ? "alerts-panel windowed" : "alerts-panel"}>
      <SectionHeader title="Alerts & Paging" onPopOut={onPopOut} />


      {activeEmergencies.map((alert) => (
        <div className="alert-row emergency" key={alert.id}>
          <div className="alert-body">
            <strong className="alert-title">
              <IconAlertTriangle size={14} /> EMERGENCY
            </strong>{" "}
            · {aliasFor(alert.from_unit) || alert.from_name || "Unknown"}
            <div className="alert-sub">
              {alert.channel_name ?? "All channels"} · {formatTime(alert.created_at)}
            </div>
            {alert.message && <div className="alert-msg">{alert.message}</div>}
          </div>
          <button className="btn sm" onClick={() => clear(alert.id)}>
            Clear
          </button>
        </div>
      ))}

      <form className="alert-send" onSubmit={send}>
        {error && <div className="banner error">{error}</div>}
        <div className="alert-send-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
            <option value="page">Page</option>
            <option value="emergency">Emergency</option>
          </select>
          <select value={audience} onChange={(e) => setAudience(e.target.value as "broadcast" | "unit")}>
            <option value="broadcast">Broadcast</option>
            <option value="unit">Specific unit</option>
          </select>
          {audience === "unit" ? (
            <input
              className="alert-unit-input"
              placeholder="Unit ID"
              value={targetUnit}
              onChange={(e) => setTargetUnit(e.target.value.toUpperCase())}
            />
          ) : (
            <select value={channelName} onChange={(e) => setChannelName(e.target.value)}>
              <option value="">All channels</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.name}>
                  {channel.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <input
          placeholder={kind === "page" ? "Page message" : "Note (optional)"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="alert-send-row">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
          />
          {imageFile ? (
            <button type="button" className="btn sm" onClick={() => {
              setImageFile(null);
              if (imageInputRef.current) imageInputRef.current.value = "";
            }}>
              Remove image
            </button>
          ) : null}
        </div>
        <button className="btn primary icon-btn" type="submit" disabled={sending}>
          {kind === "emergency" ? <IconAlertTriangle size={15} /> : <IconBell size={15} />}
          {sending ? "Sending…" : kind === "emergency" ? "Broadcast emergency" : "Send page"}
        </button>
      </form>

      <div className="alert-history">
        {history.length === 0 && <div className="empty">No recent alerts.</div>}
        {history.map((alert) => (
          <div className={alert.active ? "alert-row" : "alert-row done"} key={alert.id}>
            <div className="alert-body">
              <strong className="alert-title">
                {alert.kind === "emergency" ? <IconAlertTriangle size={13} /> : <IconBell size={13} />}
                {alert.kind === "emergency" ? "Emergency" : "Page"}
              </strong>{" "}
              · {(alert.channel_name ?? aliasFor(alert.target_unit)) || "All channels"}
              <div className="alert-sub">
                {alert.from_name || aliasFor(alert.from_unit) || "—"} · {formatTime(alert.created_at)}
                {!alert.active && alert.cleared_by ? ` · cleared by ${alert.cleared_by}` : ""}
              </div>
              {alert.message && <div className="alert-msg">{alert.message}</div>}
              {alert.has_image && <AlertThumb id={alert.id} />}
            </div>
            {alert.active && (
              <button className="btn sm" onClick={() => clear(alert.id)}>
                Clear
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
