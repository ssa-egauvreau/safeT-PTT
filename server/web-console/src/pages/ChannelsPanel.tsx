import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type UserChannel } from "../api";
import { useAuth } from "../auth";
import { sounds } from "../sounds";
import { TransmissionLog } from "./TransmissionLog";
import { SimulcastManager } from "./SimulcastManager";
import { type SectionProps } from "./PopOutSection";
import { keyLabel } from "./consoleShared";
import {
  dockChannel,
  MAX_SAFE_DOCKED_CHANNELS,
  placeWorkspaceTile,
  WORKSPACE_GRID_MAX_COLS,
  focusChannel,
  reconcileChannels,
  resetMissionControlSavedData,
  setChannelMonitoring,
  setKeyboardOn,
  setPrimaryChannel,
  setPttCode,
  undockChannel,
  useConsoleState,
} from "../consoleStore";
import { ChannelRailTile } from "./ChannelRailTile";
import { ChannelWorkspace } from "./ChannelWorkspace";
import { LiveControlPanel } from "./LiveControlPanel";
import { IconBoard, IconHeadphones } from "../icons";

/**
 * The "Channels" section — every channel the account may use, each as a
 * collapsible row. Collapsed rows show the name, an on/off (monitor) toggle, and
 * a quick PTT button; expanding a row reveals its full control surface.
 */
export function ChannelsPanel({ variant = "embedded", onPopOut }: SectionProps) {
  const { user } = useAuth();
  const { open, expanded, primary, pttCode, keyboardOn } = useConsoleState();
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulcastOpen, setSimulcastOpen] = useState(false);
  const [rebindingPtt, setRebindingPtt] = useState(false);
  const [dockNotice, setDockNotice] = useState<string | null>(null);
  const canSimulcast = user?.role === "admin" || user?.role === "dispatcher";

  const dockedChannels = expanded
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is UserChannel => !!c);
  const dockedIdSet = new Set(expanded);
  const workspaceFull = expanded.length >= MAX_SAFE_DOCKED_CHANNELS;

  // Docking is capped to keep the tab from freezing on reload (see consoleStore).
  // Returns false (and shows a notice) when the cap blocks a new channel — without
  // this the extra tile would silently disappear on the next commit/reload.
  function tryDock(id: number, at?: { col: number; row: number }): boolean {
    if (expanded.includes(id)) {
      if (at) {
        placeWorkspaceTile(id, at.col, at.row, WORKSPACE_GRID_MAX_COLS, "large");
      }
      return true;
    }
    if (expanded.length >= MAX_SAFE_DOCKED_CHANNELS) {
      setDockNotice(
        `Mission Control is full — ${MAX_SAFE_DOCKED_CHANNELS} channels max. Undock one to add another.`,
      );
      return false;
    }
    setDockNotice(null);
    dockChannel(id, at);
    return true;
  }

  function dockFromRail(id: number, at?: { col: number; row: number }) {
    if (!tryDock(id, at)) {
      return;
    }
    if (!open.includes(id)) {
      setChannelMonitoring(id, true);
    }
    setPrimaryChannel(id);
  }

  function toggleMonitorFromRail(channelId: number) {
    if (open.includes(channelId)) {
      setChannelMonitoring(channelId, false);
      return;
    }
    if (!tryDock(channelId)) {
      return;
    }
    setChannelMonitoring(channelId, true);
    setPrimaryChannel(channelId);
  }

  const refreshChannels = useCallback(() => {
    api
      .myChannels()
      .then((res) => {
        setChannels(res.channels);
        reconcileChannels(res.channels.map((c) => c.id));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => {
        setChannels(res.channels);
        reconcileChannels(res.channels.map((c) => c.id));
      })
      .catch((err) => setListError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  function toggleKeyboard() {
    const next = !keyboardOn;
    setKeyboardOn(next);
    if (!next) {
      setRebindingPtt(false);
    }
  }

  // Latest data reachable from the once-mounted keyboard listener.
  const opsRef = useRef({ channels, keyboardOn });
  opsRef.current = { channels, keyboardOn };

  // Keyboard: digit keys 1–9 turn on + expand that channel (PTT is per-panel).
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
          sounds.channelSwitch();
          focusChannel(channel.id);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Auto-dismiss the "workspace full" notice so it doesn't linger after the operator
  // makes room. Re-armed each time a new notice is shown.
  useEffect(() => {
    if (!dockNotice) {
      return;
    }
    const t = window.setTimeout(() => setDockNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [dockNotice]);

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
      }
      setRebindingPtt(false);
    }
    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [rebindingPtt]);

  return (
    <div className={variant === "window" ? "section-panel windowed" : "section-panel"}>
      {loading && <div className="empty">Loading…</div>}
      {listError && <div className="banner error">{listError}</div>}
      {dockNotice && <div className="banner warn compact">{dockNotice}</div>}
      {!loading && !listError && channels.length === 0 && (
        <div className="empty">No channels assigned to this account.</div>
      )}

      <div className="channel-workspace-layout">
        <aside className="channel-rail" aria-label="Channel list">
          {channels.map((channel, index) => {
            const showZone = !!channel.zone && channel.zone !== (channels[index - 1]?.zone ?? null);
            return (
              <Fragment key={channel.id}>
                {showZone && <div className="zone-header">{channel.zone}</div>}
                <ChannelRailTile
                  channel={channel}
                  monitoring={open.includes(channel.id)}
                  docked={dockedIdSet.has(channel.id)}
                  onDock={() => dockFromRail(channel.id)}
                  onToggleMonitor={() => toggleMonitorFromRail(channel.id)}
                  onUndock={() => undockChannel(channel.id)}
                />
              </Fragment>
            );
          })}

          {channels.length > 0 && (
            <div className="channel-rail-footer">
              {onPopOut && (
                <button
                  type="button"
                  className="btn sm channel-rail-popout"
                  onClick={onPopOut}
                  title="Open channels in a separate window"
                >
                  Pop out
                </button>
              )}
              <div className="channel-rail-legend" title="Each channel row: board button = shown on the workspace; headphones = audio on">
                <span className="channel-rail-legend-item">
                  <IconBoard size={10} /> on board
                </span>
                <span className="channel-rail-legend-item">
                  <IconHeadphones size={10} /> audio on
                </span>
              </div>
              <div
                className={workspaceFull ? "channel-rail-count full" : "channel-rail-count"}
                title="Channels docked on the Mission Control workspace"
              >
                Docked {expanded.length} / {MAX_SAFE_DOCKED_CHANNELS}
                {workspaceFull && " · full"}
              </div>
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

              {canSimulcast && !loading && !listError && (
                <button className="btn sm channel-rail-simulcast" onClick={() => setSimulcastOpen(true)}>
                  Manage simulcast
                </button>
              )}

              <button
                type="button"
                className="btn sm channel-rail-reset"
                title="Fix glitches when the page works in incognito but not in normal Chrome"
                onClick={() => {
                  if (
                    window.confirm(
                      "Reset Mission Control layout?\n\nThis clears which channels were open in the workspace and fixes glitches from old saved data. You stay signed in.\n\nClose any other Mission Control or pop-out tabs, then click OK.",
                    )
                  ) {
                    resetMissionControlSavedData();
                    window.location.href = "/console?console_reset=1";
                  }
                }}
              >
                Reset layout
              </button>
            </div>
          )}
        </aside>

        {loading ? (
          <section
            className="channel-workspace-rows channel-workspace-grid"
            aria-label="Channel workspace"
          >
            <div className="channel-workspace-empty">
              <p>Loading channels…</p>
            </div>
          </section>
        ) : (
          <ChannelWorkspace
            dockedChannels={dockedChannels}
            open={open}
            primary={primary}
            pttCode={pttCode}
            keyboardOn={keyboardOn}
            onToggleMonitor={(id) => setChannelMonitoring(id, !open.includes(id))}
            onUndock={undockChannel}
            onMakePrimary={setPrimaryChannel}
            onDockFromRail={dockFromRail}
          />
        )}
      </div>

      <LiveControlPanel />

      <TransmissionLog />

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
