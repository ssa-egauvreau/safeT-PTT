import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type UserChannel } from "../api";
import { useAuth } from "../auth";
import { ChannelPanel } from "./ChannelPanel";
import { SimulcastManager } from "./SimulcastManager";
import { TransmissionLog } from "./TransmissionLog";
import { QuickReplay } from "./QuickReplay";
import { MapPanel } from "./MapPanel";
import { AlertsPanel } from "./AlertsPanel";
import { sounds } from "../sounds";
import { Topbar } from "../Topbar";
import { IconRadio } from "../icons";
import {
  PERMISSION_LABEL,
  keyLabel,
  OPEN_CHANNELS_KEY,
  LAST_CHANNEL_KEY,
  PTT_CODE_KEY,
  DEFAULT_PTT_CODE,
  KEYBOARD_ENABLED_KEY,
} from "./consoleShared";

/** The channel ids the console had open last session (primary first). */
function readSavedOpen(): number[] {
  try {
    const raw = localStorage.getItem(OPEN_CHANNELS_KEY);
    if (raw) {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) {
        return ids.filter((id): id is number => typeof id === "number");
      }
    }
  } catch {
    /* fall through to the legacy single-channel key */
  }
  const last = Number(localStorage.getItem(LAST_CHANNEL_KEY));
  return Number.isFinite(last) && last > 0 ? [last] : [];
}

export function ConsolePage() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulcastOpen, setSimulcastOpen] = useState(false);

  const [openIds, setOpenIds] = useState<number[]>([]);
  const [primaryId, setPrimaryId] = useState<number | null>(null);

  const refreshChannels = useCallback(() => {
    api
      .myChannels()
      .then((res) => setChannels(res.channels))
      .catch(() => undefined);
  }, []);

  const canSimulcast = user?.role === "admin" || user?.role === "dispatcher";

  const [pttCode, setPttCode] = useState(() => localStorage.getItem(PTT_CODE_KEY) || DEFAULT_PTT_CODE);
  const [rebindingPtt, setRebindingPtt] = useState(false);
  const [keyboardOn, setKeyboardOn] = useState(() => localStorage.getItem(KEYBOARD_ENABLED_KEY) !== "0");

  // Captured before any effect can overwrite the persisted open set.
  const savedOpenRef = useRef<number[]>(readSavedOpen());

  function openChannel(channel: UserChannel) {
    sounds.channelSwitch();
    setPrimaryId(channel.id);
    setOpenIds((prev) => (prev.includes(channel.id) ? prev : [...prev, channel.id]));
  }

  function closeChannel(id: number) {
    setOpenIds((prev) => prev.filter((x) => x !== id));
  }

  function toggleKeyboard() {
    const next = !keyboardOn;
    setKeyboardOn(next);
    localStorage.setItem(KEYBOARD_ENABLED_KEY, next ? "1" : "0");
    if (!next) {
      setRebindingPtt(false);
    }
  }

  // Latest data reachable from the once-mounted keyboard listener.
  const opsRef = useRef({ channels, openChannel, keyboardOn });
  opsRef.current = { channels, openChannel, keyboardOn };

  useEffect(() => {
    sounds.preload();
    const stopSoundSync = sounds.startAutoRefresh();
    api
      .myChannels()
      .then((res) => {
        setChannels(res.channels);
        const available = new Set(res.channels.map((c) => c.id));
        const restore = savedOpenRef.current.filter((id) => available.has(id));
        if (restore.length > 0) {
          setOpenIds(restore);
          setPrimaryId(restore[0]);
        }
      })
      .catch((err) => setListError(describeError(err)))
      .finally(() => setLoading(false));
    return stopSoundSync;
  }, []);

  // Keep the primary channel pointing at an open panel.
  useEffect(() => {
    if (openIds.length === 0) {
      setPrimaryId(null);
    } else if (primaryId === null || !openIds.includes(primaryId)) {
      setPrimaryId(openIds[openIds.length - 1]);
    }
  }, [openIds, primaryId]);

  // Persist the open set (primary first) once channels have loaded.
  useEffect(() => {
    if (loading) {
      return;
    }
    const ordered =
      primaryId != null ? [primaryId, ...openIds.filter((id) => id !== primaryId)] : openIds;
    localStorage.setItem(OPEN_CHANNELS_KEY, JSON.stringify(ordered));
  }, [openIds, primaryId, loading]);

  // Keyboard: digit keys 1–9 open that channel (PTT is handled per-panel).
  useEffect(() => {
    function inField(): boolean {
      const el = document.activeElement;
      return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (!opsRef.current.keyboardOn || inField() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) {
        return;
      }
      if (e.code.startsWith("Digit")) {
        const channel = opsRef.current.channels[Number(e.code.slice(5)) - 1];
        if (channel) {
          e.preventDefault();
          opsRef.current.openChannel(channel);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // PTT-key rebinding: capture the next keypress (Escape cancels). The capture
  // phase + stopPropagation keeps that keypress from also triggering transmit.
  useEffect(() => {
    if (!rebindingPtt) {
      return;
    }
    function capture(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        setPttCode(e.code);
        localStorage.setItem(PTT_CODE_KEY, e.code);
      }
      setRebindingPtt(false);
    }
    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [rebindingPtt]);

  const openChannelObjs = openIds
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is UserChannel => !!c);

  return (
    <div className="app-shell">
      <Topbar section="console" />

      <div className="console-grid">
        <div className="console-col">
          <h3>Channels</h3>
          {loading && <div className="empty">Loading…</div>}
          {listError && <div className="banner error">{listError}</div>}
          {!loading && !listError && channels.length === 0 && (
            <div className="empty">No channels assigned to this account.</div>
          )}
          {channels.map((channel, index) => {
            const open = openIds.includes(channel.id);
            const isPrimary = primaryId === channel.id;
            const showZone = !!channel.zone && channel.zone !== (channels[index - 1]?.zone ?? null);
            return (
              <Fragment key={channel.id}>
                {showZone && <div className="zone-header">{channel.zone}</div>}
                <button
                  className={`chan-item${open ? " active" : ""}${isPrimary ? " primary" : ""}`}
                  onClick={() => openChannel(channel)}
                  style={channel.color ? { boxShadow: `inset 4px 0 0 ${channel.color}` } : undefined}
                >
                  <span className="chan-name">
                    <IconRadio size={14} />
                    {channel.name}
                  </span>
                  <span className="perm">
                    {isPrimary && <span className="chan-primary-tag">PTT</span>}
                    {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
                    {index < 9 && <span className="chan-key">{index + 1}</span>}
                    {PERMISSION_LABEL[channel.permission]}
                  </span>
                </button>
              </Fragment>
            );
          })}
          {channels.length > 0 && (
            <div className="kbd-hint">
              <button
                className={keyboardOn ? "kbd-toggle on" : "kbd-toggle"}
                onClick={toggleKeyboard}
                title="Enable or disable all keyboard shortcuts"
              >
                Keyboard shortcuts: {keyboardOn ? "On" : "Off"}
              </button>
              {keyboardOn && (
                <div className="kbd-keys">
                  Keys 1–9 open · PTT{" "}
                  <button
                    className={rebindingPtt ? "key-rebind active" : "key-rebind"}
                    onClick={() => setRebindingPtt((v) => !v)}
                    title="Click, then press a key to rebind push-to-talk"
                  >
                    {rebindingPtt ? "press a key…" : keyLabel(pttCode)}
                  </button>
                </div>
              )}
            </div>
          )}
          {canSimulcast && !loading && !listError && (
            <button
              className="btn sm"
              style={{ marginTop: 10, width: "100%" }}
              onClick={() => setSimulcastOpen(true)}
            >
              Manage simulcast
            </button>
          )}
        </div>

        <div className="console-col">
          <h3>Channels on air</h3>
          <QuickReplay />
          {openChannelObjs.length === 0 ? (
            <div className="placeholder-box">
              <strong>No channels open</strong>
              Pick a channel on the left — each one you open gets its own control panel here.
            </div>
          ) : (
            <div className="panel-grid">
              {openChannelObjs.map((channel) => (
                <ChannelPanel
                  key={channel.id}
                  channel={channel}
                  primary={primaryId === channel.id}
                  pttCode={pttCode}
                  keyboardOn={keyboardOn}
                  onMakePrimary={() => setPrimaryId(channel.id)}
                  onClose={() => closeChannel(channel.id)}
                />
              ))}
            </div>
          )}

          <TransmissionLog />
        </div>

        <div className="console-col">
          <MapPanel />
          <AlertsPanel />
        </div>
      </div>

      {simulcastOpen && (
        <SimulcastManager
          channels={channels}
          onClose={() => setSimulcastOpen(false)}
          onChanged={refreshChannels}
        />
      )}
    </div>
  );
}
