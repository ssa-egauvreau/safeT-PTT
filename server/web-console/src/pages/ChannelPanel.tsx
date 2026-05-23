import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import type { Permission, ToneOut, UserChannel } from "../api";
import { api } from "../api";
import { VoiceChannelClient, type VoiceState, type ToneOutKind } from "../voice/voiceClient";
import { AudioLevelMeter } from "../voice/AudioLevelMeter";
import { ChannelMemberCount } from "../components/ChannelMemberCount";
import { ChannelRoster } from "./ChannelRoster";
import { LatestChannelTransmission } from "../components/LatestChannelTransmission";
import type { WorkspaceWidgetSize } from "../consoleStore";
import { sounds } from "../sounds";
import { useToneOuts, loadTonePcm, ToneOutBadge } from "../toneOuts";
import {
  IconBolt,
  IconBeacon,
  IconRadio,
  IconHeadphones,
  IconToneRoutine,
  IconTonePriority,
  IconToneStatus,
  IconStop,
  IconVolume,
  IconVolumeMuted,
} from "../icons";
import {
  PERMISSION_LABEL,
  STATE_LABEL,
  keyLabel,
  loadAudioOutputId,
  loadMuted,
  loadTxDigital,
  loadVolume,
  muteKey,
  saveAudioOutputId,
  txDigitalKey,
  volumeKey,
} from "./consoleShared";

/** How long to wait between a server-driven WS close and the next auto-reconnect attempt. */
const VOICE_RECONNECT_DELAY_MS = 3000;

interface ChannelPanelProps {
  channel: UserChannel;
  /** `workspace` = full panel in the dock; `accordion` = legacy inline card. */
  layout?: "workspace" | "accordion";
  /** Workspace widget size (S / M / L) — controls which controls are visible. */
  workspaceWidgetSize?: WorkspaceWidgetSize;
  /** Workspace tile is wide enough for a 2-column control layout inside the card. */
  workspaceWide?: boolean;
  /** Whether live voice is connected for this channel ("on"). */
  monitoring: boolean;
  /** Whether the full control surface is revealed. */
  expanded: boolean;
  /** Whether the keyboard PTT key controls this panel. */
  primary: boolean;
  pttCode: string;
  keyboardOn: boolean;
  onToggleMonitor: () => void;
  onToggleExpanded: () => void;
  onMakePrimary: () => void;
  /** Header chrome for workspace tiles (close, size, drag) — replaces the left ✕ and grey drag bar. */
  workspaceChrome?: {
    sizeLabel: string;
    sizeTitle: string;
    onCycleSize: () => void;
    onClose: () => void;
    onDragPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
    isDragging?: boolean;
  };
}

/**
 * One channel as a collapsible accordion row. Collapsed it shows the name, an
 * on/off (monitor) toggle, and a quick PTT button; expanded it reveals the full
 * control surface — listen, transmit, 10-33 marker, AI dispatch, and tone-outs.
 */
export function ChannelPanel({
  channel,
  layout = "accordion",
  workspaceWidgetSize = "large",
  workspaceWide = false,
  monitoring,
  expanded,
  primary,
  pttCode,
  keyboardOn,
  onToggleMonitor,
  onToggleExpanded,
  onMakePrimary,
  workspaceChrome,
}: ChannelPanelProps) {
  const workspace = layout === "workspace";
  const [voiceState, setVoiceState] = useState<VoiceState>("connecting");
  const [voiceDetail, setVoiceDetail] = useState<string | null>(null);
  const [permission, setPermission] = useState<Permission>(channel.permission);
  const [marker, setMarker] = useState(false);
  const [aiDispatch, setAiDispatch] = useState(channel.ai_dispatch_enabled === true);
  const [aiDispatchReady, setAiDispatchReady] = useState(false);
  const [aiDispatchHint, setAiDispatchHint] = useState<string | null>(null);
  const [txDigital, setTxDigital] = useState(() => loadTxDigital(channel.id));
  const [volume, setVolume] = useState(() => loadVolume(channel.id));
  const [muted, setMuted] = useState(() => loadMuted(channel.id));
  const [audioOutputId, setAudioOutputId] = useState(() => loadAudioOutputId(channel.id));
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [receiving, setReceiving] = useState(false);
  /** Custom soundboard tone-outs currently looping on this channel. */
  const [loopingIds, setLoopingIds] = useState<Set<number>>(new Set());
  const toneOuts = useToneOuts();

  const clientRef = useRef<VoiceChannelClient | null>(null);
  /** Whether the operator is currently holding PTT — gates the looping busy tone. */
  const pttHeldRef = useRef(false);
  /*
   * Auto-reconnect on server-driven close (Railway redeploy, transient network blip). The flag
   * separates "operator hit reconnect / closed the panel" (no retry) from "the WS dropped under
   * us" (3 s wait, then re-call connect()). Mirrors the bridge runner and radio portal patterns.
   */
  const wantConnectedRef = useRef(true);
  const reconnectTimerRef = useRef<number | null>(null);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  const connect = useCallback(() => {
    clearReconnectTimer();
    wantConnectedRef.current = true;
    const client = new VoiceChannelClient(channel.name, {
      onState: (state, detail) => {
        setVoiceState(state);
        setVoiceDetail(detail ?? null);
        // Auto-reconnect on server-driven close (Railway redeploy, transient network blip) so
        // the operator doesn't have to click the manual "Reconnect" button every redeploy.
        // Errors don't retry — those usually mean a config/permission issue another attempt
        // won't fix. The "Reconnect" button is still wired up for the error case.
        if (state === "closed" && wantConnectedRef.current) {
          clearReconnectTimer();
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!wantConnectedRef.current) return;
            // Close the prior VoiceChannelClient before constructing a new one — its rxWatchdog
            // interval, AudioContext, MediaStream tracks, and IMBE decoder all need to go through
            // close() to be released. Repeated server-driven drops (Railway redeploys, network
            // blips) would otherwise pile up orphaned clients with each retry.
            clientRef.current?.close();
            clientRef.current = null;
            connect();
          }, VOICE_RECONNECT_DELAY_MS);
        } else if (state === "error") {
          wantConnectedRef.current = false;
        }
      },
      onPermission: (perm) => setPermission(perm),
      onReceiving: (rx) => setReceiving(rx),
      onBusy: (unit) => {
        // Keep the busy tone going while the operator still holds the key.
        if (pttHeldRef.current) {
          sounds.busyLoopStart();
        }
        setVoiceDetail(
          unit ? `Channel busy — ${unit} is transmitting.` : "Channel busy — another unit is transmitting.",
        );
      },
    });
    client.setDigitalTx(loadTxDigital(channel.id));
    client.setVolume(loadVolume(channel.id));
    client.setMuted(loadMuted(channel.id));
    client.setAudioOutputId(loadAudioOutputId(channel.id));
    clientRef.current = client;
    client.connect();
  }, [channel.id, channel.name]);

  // Live voice exists only while the channel is "on". Toggling off tears the
  // client down (releasing its WebSocket, AudioContext, and IMBE decoder);
  // toggling on reconnects. Collapsing/expanding the row does not touch voice.
  useEffect(() => {
    if (!monitoring) {
      setVoiceState("idle");
      setVoiceDetail(null);
      return;
    }
    connect();
    return () => {
      wantConnectedRef.current = false;
      clearReconnectTimer();
      clientRef.current?.close();
      clientRef.current = null;
      sounds.busyLoopStop();
    };
  }, [connect, monitoring]);

  const startTx = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
      // The button is normally disabled while !connected, but a navigation/re-mount
      // race could leave the panel briefly with no client; surface the state instead
      // of silently swallowing the press.
      setVoiceDetail("Voice not ready — wait for the channel to reconnect.");
      return;
    }
    pttHeldRef.current = true;
    try {
      await client.startTransmit();
      sounds.permit();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === "channel_busy") {
        // Loop the busy tone for as long as the operator holds the key.
        if (pttHeldRef.current) {
          sounds.busyLoopStart();
        }
        setVoiceDetail("Channel busy — another unit is transmitting.");
      } else if (code === "listen_only") {
        setVoiceDetail("You have listen-only access on this channel.");
      } else if (code === "not_connected") {
        // Distinct message so the operator knows the voice socket dropped
        // (e.g. after a tab navigation race) rather than blaming the mic.
        setVoiceDetail("Voice disconnected — reconnecting…");
      } else {
        setVoiceDetail("Microphone unavailable or permission denied.");
      }
    }
  }, []);

  const stopTx = useCallback(() => {
    pttHeldRef.current = false;
    clientRef.current?.stopTransmit();
    sounds.busyLoopStop();
  }, []);

  // Keyboard hold-to-talk — only while this panel is the primary, monitoring one.
  useEffect(() => {
    if (!primary || !keyboardOn || !monitoring) {
      return;
    }
    let held = false;
    function inField(): boolean {
      const el = document.activeElement;
      return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    }
    function down(e: KeyboardEvent) {
      if (e.code !== pttCode || inField() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) {
        return;
      }
      e.preventDefault();
      if (!held) {
        held = true;
        void startTx();
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code === pttCode && held) {
        held = false;
        stopTx();
      }
    }
    function blur() {
      if (held) {
        held = false;
        stopTx();
      }
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      if (held) {
        stopTx();
      }
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [primary, keyboardOn, monitoring, pttCode, startTx, stopTx]);

  function beginTransmit(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    void startTx();
  }

  useEffect(() => {
    // The AI dispatch toggle only lives in the expanded body — don't fetch its
    // status for every collapsed row.
    if (!expanded) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [status, row] = await Promise.all([
          api.getAiDispatchStatus(),
          api.getChannelAiDispatch(channel.name),
        ]);
        if (cancelled) {
          return;
        }
        setAiDispatch(row.enabled);
        setAiDispatchReady(true);
        const hints: string[] = [];
        if (!status.platform_enabled) {
          hints.push("AI dispatcher is off on the server (Railway).");
        } else if (!status.platform_llm_configured) {
          hints.push("Server LLM API key is not set.");
        }
        if (!status.agency_tts_configured) {
          hints.push("Set ElevenLabs key and voice under Admin → Integrations.");
        }
        setAiDispatchHint(hints.length > 0 ? hints.join(" ") : null);
      } catch {
        if (!cancelled) {
          setAiDispatchReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.name, expanded]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !monitoring) {
      return;
    }
    client.setAiDispatchListenPcm(aiDispatch);
    client.setDigitalTx(loadTxDigital(channel.id));
  }, [aiDispatch, monitoring, channel.id]);

  function toggleAiDispatch() {
    if (!aiDispatchReady) {
      return;
    }
    const next = !aiDispatch;
    setAiDispatch(next);
    void api.setChannelAiDispatch(channel.name, next).catch(() => {
      setAiDispatch(!next);
    });
    clientRef.current?.setAiDispatchListenPcm(next);
    if (next) {
      setAiDispatchHint(
        "AI dispatch uses clear audio for transcripts; Fast (vocoder) still keys the channel for other units.",
      );
    } else {
      setAiDispatchHint(null);
    }
  }

  useEffect(() => {
    // Only poll the 10-33 marker for rows the operator is actually watching.
    if (!monitoring && !expanded) {
      return;
    }
    let cancelled = false;
    const syncTen33 = () => {
      void api.getChannelTen33(channel.name).then((r) => {
        if (cancelled) {
          return;
        }
        setMarker((prev) => (prev === r.active ? prev : r.active));
      });
    };
    syncTen33();
    const timer = window.setInterval(syncTen33, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channel.name, monitoring, expanded]);

  function toggleMarker() {
    const next = !marker;
    setMarker(next);
    // Server sets DB flag, plays marker on channel, and radios poll the 10-33 icon.
    void api.setChannelTen33(channel.name, next).catch(() => {
      setMarker(!next);
    });
  }

  function sendTone(kind: ToneOutKind) {
    clientRef.current?.sendToneOut(kind);
  }

  /** Fires a custom soundboard tone-out — or stops it if it is a running loop. */
  async function fireToneOut(toneOut: ToneOut) {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    const loop = toneOut.play_mode === "loop";
    if (loop && loopingIds.has(toneOut.id)) {
      client.stopCustomTone(toneOut.id);
      setLoopingIds((prev) => {
        const next = new Set(prev);
        next.delete(toneOut.id);
        return next;
      });
      return;
    }
    try {
      const pcm = await loadTonePcm(toneOut.id);
      client.playCustomTone(toneOut.id, pcm, loop);
      if (loop) {
        setLoopingIds((prev) => new Set(prev).add(toneOut.id));
      }
    } catch {
      /* the clip failed to load or decode — nothing to play */
    }
  }

  function stopAllSounds() {
    clientRef.current?.stopAllTones();
    sounds.stopAll();
    setMarker(false);
    setLoopingIds(new Set());
  }

  function toggleTxMode() {
    const next = !txDigital;
    setTxDigital(next);
    localStorage.setItem(txDigitalKey(channel.id), next ? "1" : "0");
    clientRef.current?.setDigitalTx(next);
  }

  function changeVolume(next: number) {
    setVolume(next);
    clientRef.current?.setVolume(next);
    localStorage.setItem(volumeKey(channel.id), String(next));
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    clientRef.current?.setMuted(next);
    localStorage.setItem(muteKey(channel.id), next ? "1" : "0");
  }

  function changeAudioOutput(deviceId: string) {
    setAudioOutputId(deviceId);
    saveAudioOutputId(channel.id, deviceId);
    clientRef.current?.setAudioOutputId(deviceId);
  }

  useEffect(() => {
    if (!expanded) {
      return;
    }
    async function loadDevices() {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) {
          return;
        }
        const list = await navigator.mediaDevices.enumerateDevices();
        setAudioOutputs(list.filter((d) => d.kind === "audiooutput"));
      } catch {
        /* ignore */
      }
    }
    void loadDevices();
    navigator.mediaDevices?.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", loadDevices);
  }, [expanded]);

  useEffect(() => {
    clientRef.current?.setAudioOutputId(audioOutputId);
  }, [audioOutputId, monitoring]);

  function reconnect() {
    // Manual button — cancel any in-flight auto-reconnect first so we don't race a second connect()
    // against the pending timer.
    clearReconnectTimer();
    clientRef.current?.close();
    setVoiceState("connecting");
    setVoiceDetail(null);
    setMarker(false);
    setLoopingIds(new Set());
    connect();
  }

  const connected = voiceState === "listening" || voiceState === "transmitting";
  const canTransmit = permission !== "listen_only";
  const transmitting = voiceState === "transmitting";
  const wsSize = workspace ? workspaceWidgetSize : "large";
  const wsIcon = workspace
    ? wsSize === "small"
      ? { toolbar: 11, volume: 11, radio: 10, txMain: 14, action: 11, tone: 10, badge: 10, member: 10 }
      : wsSize === "medium"
        ? { toolbar: 12, volume: 12, radio: 11, txMain: 16, action: 12, tone: 11, badge: 11, member: 11 }
        : { toolbar: 13, volume: 12, radio: 12, txMain: 18, action: 12, tone: 11, badge: 11, member: 12 }
    : null;
  const showToolbar = true;
  const showVolume = true;
  const showStatusChip = workspace && wsSize !== "small";
  const showMemberCount = workspace;
  const showMeta = !workspace || wsSize === "large";
  const showAudioOut = !workspace || wsSize === "large";
  const showActions = !workspace || wsSize === "large";
  const showTones = workspace && (wsSize === "medium" || wsSize === "large");
  const showTonesCompact = workspace && wsSize === "medium";
  const showToneCustom = !workspace || wsSize === "large";
  const showLiveTx = workspace;
  const showRoster = !workspace || wsSize === "large";
  /** Full XMIT pad only on large — S/M use the toolbar PTT. */
  const showMainTxButton = !workspace || wsSize === "large";
  const volumeInHead = false;

  const volumeRow = showVolume ? (
    <div className="volume-row">
      <button
        className="vol-mute"
        onClick={toggleMute}
        title={muted ? "Unmute channel" : "Mute channel"}
      >
        {muted ? (
          <IconVolumeMuted size={wsIcon?.volume ?? 16} />
        ) : (
          <IconVolume size={wsIcon?.volume ?? 16} />
        )}
      </button>
      <input
        className="vol-slider"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => changeVolume(Number(e.target.value))}
      />
      <span className="vol-pct">{muted ? "Muted" : `${Math.round(volume * 100)}%`}</span>
    </div>
  ) : null;

  const workspaceToolbar = showToolbar ? (
    <div className="ch-card-toolbar">
      {showStatusChip && monitoring &&
        (connected ? (
          <span className={`state-chip ${transmitting ? "tx" : receiving ? "rx" : voiceState}`}>
            {transmitting ? "ON AIR" : receiving ? "RX" : STATE_LABEL[voiceState]}
          </span>
        ) : (
          <span className={`state-chip ${voiceState}`}>{STATE_LABEL[voiceState]}</span>
        ))}
      {showStatusChip && monitoring && receiving && !transmitting && (
        <span className="state-chip busy">BUSY</span>
      )}
      <button
        type="button"
        className={monitoring ? "ch-power active" : "ch-power"}
        onClick={onToggleMonitor}
        aria-pressed={monitoring}
        title={monitoring ? "Turn channel off (stop monitoring)" : "Turn channel on (monitor)"}
      >
        <IconHeadphones size={wsIcon?.toolbar ?? 16} />
        <span>{monitoring ? "ON" : "OFF"}</span>
      </button>
      <button
        type="button"
        className={transmitting ? "ch-quick-ptt active" : "ch-quick-ptt"}
        disabled={!monitoring || !connected || !canTransmit}
        onPointerDown={beginTransmit}
        onPointerUp={stopTx}
        onPointerCancel={stopTx}
        title={
          !monitoring
            ? "Turn the channel on to talk"
            : !canTransmit
              ? "Listen-only on this channel"
              : "Hold to talk"
        }
      >
        <IconBolt size={wsIcon?.toolbar ?? 16} />
        <span>{transmitting ? "ON AIR" : "PTT"}</span>
      </button>
    </div>
  ) : null;

  return (
    <div
      className={`channel-card${expanded ? " expanded" : ""}${primary ? " primary" : ""}${workspace ? " workspace" : ""}`}
      data-widget-size={workspace ? wsSize : undefined}
      data-width={workspace ? (workspaceWide ? "wide" : "narrow") : undefined}
      style={channel.color ? { borderLeftColor: channel.color, borderLeftWidth: 3 } : undefined}
    >
      <div className={`ch-card-head${workspace ? " workspace-head" : ""}`}>
        {workspace ? (
          <>
            <div
              className={`ch-card-title-row${channel.color ? " has-channel-color" : ""}${
                workspaceChrome?.isDragging ? " dragging" : ""
              }`}
              style={
                channel.color
                  ? { background: channel.color, color: "#fff", borderColor: channel.color }
                  : undefined
              }
              onPointerDownCapture={workspaceChrome?.onDragPointerDown}
              title={workspaceChrome ? "Drag the name bar to reorder (not PTT or S / M / L)" : undefined}
            >
              <div className="ch-card-title-main">
                <div className="ch-card-name ch-card-name-static">
                  <IconRadio size={wsIcon?.radio ?? 14} />
                  <span className="ch-card-label">{channel.name}</span>
                  {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
                </div>
                {showMemberCount && (
                  <ChannelMemberCount
                    channelName={channel.name}
                    iconSize={wsIcon?.member ?? 14}
                  />
                )}
              </div>
              {workspaceChrome ? (
                <div
                  className="ch-card-chrome"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="channel-workspace-size-btn"
                    title={workspaceChrome.sizeTitle}
                    aria-label={workspaceChrome.sizeTitle}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      workspaceChrome.onCycleSize();
                    }}
                  >
                    {workspaceChrome.sizeLabel}
                  </button>
                  <button
                    type="button"
                    className="ch-workspace-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      workspaceChrome.onClose();
                    }}
                    aria-label="Remove from workspace"
                    title="Remove from workspace"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ch-disclosure"
                  onClick={onToggleExpanded}
                  aria-expanded={expanded}
                  title="Remove from workspace"
                >
                  ✕
                </button>
              )}
            </div>
            {volumeInHead && volumeRow}
            {workspaceToolbar}
          </>
        ) : (
          <>
            <button
              type="button"
              className="ch-disclosure"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              title={expanded ? "Collapse channel" : "Expand channel"}
            >
              {expanded ? "▾" : "▸"}
            </button>
            <button type="button" className="ch-card-name" onClick={onToggleExpanded}>
              <IconRadio size={14} />
              <span className="ch-card-label">{channel.name}</span>
              {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
            </button>
            {monitoring &&
              (!expanded && connected ? (
                <span
                  className={`ch-mini-wave${transmitting ? " tx" : receiving ? " rx" : ""}`}
                  title={transmitting ? "On air" : receiving ? "Receiving" : "Listening"}
                >
                  <AudioLevelMeter
                    getLevel={() => clientRef.current?.getLevel() ?? 0}
                    active={transmitting || receiving}
                    variant={transmitting ? "tx" : "rx"}
                    className="audio-level-meter--mini"
                  />
                </span>
              ) : (
                <span className={`state-chip ${voiceState}`}>{STATE_LABEL[voiceState]}</span>
              ))}
            {monitoring && expanded && receiving && !transmitting && (
              <span className="state-chip busy">BUSY</span>
            )}
            <button
              type="button"
              className={monitoring ? "ch-power active" : "ch-power"}
              onClick={onToggleMonitor}
              aria-pressed={monitoring}
              title={monitoring ? "Turn channel off (stop monitoring)" : "Turn channel on (monitor)"}
            >
              <IconHeadphones size={16} />
              <span>{monitoring ? "ON" : "OFF"}</span>
            </button>
            <button
              type="button"
              className={transmitting ? "ch-quick-ptt active" : "ch-quick-ptt"}
              disabled={!monitoring || !connected || !canTransmit}
              onPointerDown={beginTransmit}
              onPointerUp={stopTx}
              onPointerCancel={stopTx}
              title={
                !monitoring
                  ? "Turn the channel on to talk"
                  : !canTransmit
                    ? "Listen-only on this channel"
                    : "Hold to talk"
              }
            >
              <IconBolt size={16} />
              <span>{transmitting ? "ON AIR" : "PTT"}</span>
            </button>
          </>
        )}
      </div>

      {expanded && (
      <div className={`ch-card-body${workspace ? " workspace-dense" : ""}`}>
      {showMeta && (
        <div className="live-meta">
          Permission: <strong>{PERMISSION_LABEL[permission]}</strong>
        </div>
      )}

      {showMeta && monitoring && (
        <div className="cp-ptt-assign">
          {primary ? (
            <span className="cp-primary" title="Keyboard PTT controls this channel">
              Keyboard PTT
            </span>
          ) : (
            <button
              className="ch-setprimary"
              onClick={onMakePrimary}
              title="Use the keyboard PTT for this channel"
            >
              Set as keyboard PTT
            </button>
          )}
        </div>
      )}

      {showVolume && !volumeInHead && volumeRow}

      {showAudioOut && (
      <label className="audio-out-row">
        <span className="audio-out-label">Audio out</span>
        <select
          className="audio-out-select"
          value={audioOutputId}
          onChange={(e) => changeAudioOutput(e.target.value)}
          title="Play this channel on a specific speaker or headset"
        >
          <option value="">System default</option>
          {audioOutputs.map((d) => (
            <option key={d.deviceId || d.label} value={d.deviceId}>
              {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </label>
      )}

      {showMeta && voiceDetail && (
        <div className={`banner ${voiceState === "error" ? "error" : "info"}`}>{voiceDetail}</div>
      )}

      {showMainTxButton && (
      <button
        className={`tx-button${workspace ? " tx-button-integrated" : ""}${
          transmitting ? " active" : receiving ? " busy" : ""
        }`}
        disabled={!connected || !canTransmit}
        onPointerDown={beginTransmit}
        onPointerUp={stopTx}
        onPointerCancel={stopTx}
      >
        {workspace && (
          <div
            className={`tx-button-wave${transmitting ? " tx" : receiving ? " rx" : ""}`}
            aria-hidden
          >
            <AudioLevelMeter
              getLevel={() => clientRef.current?.getLevel() ?? 0}
              active={transmitting || receiving}
              variant={transmitting ? "tx" : "rx"}
              className="audio-level-meter--tx-fill"
            />
          </div>
        )}
        <span className="tx-main">
          <IconBolt size={wsIcon?.txMain ?? 26} />
          {transmitting ? "ON AIR" : !canTransmit ? "LISTEN ONLY" : receiving ? "BUSY" : "XMIT"}
        </span>
        {(!workspace || wsSize === "large") && (
          <span className="tx-sub">
            {transmitting
              ? "release to stop"
              : !canTransmit
                ? "no transmit permission"
                : !connected
                  ? "connecting…"
                  : receiving
                    ? "channel busy — another unit transmitting"
                    : primary
                      ? `hold to talk · ${keyLabel(pttCode)}`
                      : "hold to talk"}
          </span>
        )}
      </button>
      )}

      {!workspace && (
        <div className={`waveform-strip${transmitting ? " tx" : receiving ? " rx" : ""}`}>
          <AudioLevelMeter
            getLevel={() => clientRef.current?.getLevel() ?? 0}
            active={transmitting || receiving}
            variant={transmitting ? "tx" : "rx"}
            className="audio-level-meter--strip"
          />
        </div>
      )}

      {showLiveTx && monitoring && (
        <LatestChannelTransmission
          variant="console"
          channelName={channel.name}
          active={monitoring && connected}
          homeReceiving={receiving && !transmitting}
          logHint={
            wsSize === "large"
              ? "Open the transmission log below for full history."
              : ""
          }
        />
      )}

      {showActions && (
      <div className={workspace ? "ch-actions-grid" : "ch-actions-stack"}>
        <button className="txmode-btn ch-action-cell" onClick={toggleTxMode} type="button">
          {workspace ? (
            <>
              <span className="ch-action-kicker">TX mode</span>
              <strong>{txDigital ? "Fast" : "HQ"}</strong>
            </>
          ) : (
            <>
              TX MODE:{" "}
              <strong>{txDigital ? "COMPRESSED · FAST" : "HIGH QUALITY · NORMAL SPEED"}</strong>
            </>
          )}
        </button>

        <button
          type="button"
          className={marker ? "marker-button active ch-action-cell" : "marker-button ch-action-cell"}
          disabled={!connected || !canTransmit}
          onClick={toggleMarker}
          title="10-33 emergency marker tone"
        >
          <IconBeacon size={wsIcon?.action ?? (workspace ? 14 : 18)} />
          <span>{marker ? (workspace ? "10-33 ON" : "10-33 MARKER ON") : workspace ? "10-33" : "10-33 CHANNEL MARKER"}</span>
        </button>

        <button
          type="button"
          className={aiDispatch ? "marker-button active ch-action-cell" : "marker-button ch-action-cell"}
          disabled={!aiDispatchReady}
          onClick={toggleAiDispatch}
          title={
            aiDispatchHint ??
            "When on, unit transmissions on this channel can trigger an AI dispatcher reply on the air."
          }
        >
          <span>{aiDispatch ? (workspace ? "AI ON" : "AI DISPATCH ON") : workspace ? "AI OFF" : "AI DISPATCH OFF"}</span>
        </button>
      </div>
      )}
      {showActions && (marker || aiDispatchHint || (aiDispatch && !aiDispatchHint)) && (
        <div className="ch-action-notes">
          {marker && <span className="marker-note">10-33 marker tone every 12s</span>}
          {aiDispatchHint && <span className="marker-note muted">{aiDispatchHint}</span>}
          {aiDispatch && !aiDispatchHint && (
            <span className="marker-note">AI transcribes and replies on this channel</span>
          )}
        </div>
      )}

      {showTones && (
      <div className={`toneout${showTonesCompact ? " workspace-tones-compact" : ""}`}>
        <div className={workspace ? "ch-tone-grid" : "toneout-row"}>
          <button
            type="button"
            className="toneout-btn ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("routine")}
          >
            <IconToneRoutine size={wsIcon?.tone ?? (workspace ? 13 : 16)} />
            Routine
          </button>
          <button
            type="button"
            className="toneout-btn priority ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("priority")}
          >
            <IconTonePriority size={wsIcon?.tone ?? (workspace ? 13 : 16)} />
            Priority
          </button>
          <button
            type="button"
            className="toneout-btn ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("status")}
          >
            <IconToneStatus size={wsIcon?.tone ?? (workspace ? 13 : 16)} />
            Status
          </button>
        </div>
        {showToneCustom && toneOuts.some((t) => t.has_audio) && (
          <div className={workspace ? "ch-tone-grid" : "toneout-custom"}>
            {toneOuts
              .filter((t) => t.has_audio)
              .map((toneOut) => {
                const looping = loopingIds.has(toneOut.id);
                const isLoop = toneOut.play_mode === "loop";
                return (
                  <button
                    key={toneOut.id}
                    type="button"
                    className={looping ? "toneout-btn custom looping ch-action-cell" : "toneout-btn custom ch-action-cell"}
                    disabled={!connected || !canTransmit}
                    onClick={() => void fireToneOut(toneOut)}
                    title={
                      isLoop
                        ? looping
                          ? `Stop "${toneOut.name}" loop`
                          : `Loop "${toneOut.name}"`
                        : `Play "${toneOut.name}"`
                    }
                  >
                    <ToneOutBadge toneOut={toneOut} size={wsIcon?.badge ?? (workspace ? 14 : 16)} />
                    <span className="toneout-label">{toneOut.name}</span>
                    {isLoop && <span className="toneout-mode">{looping ? "■" : "↻"}</span>}
                  </button>
                );
              })}
          </div>
        )}
        <button type="button" className="stopall-btn" onClick={stopAllSounds}>
          <IconStop size={wsIcon?.tone ?? (workspace ? 13 : 16)} />
          {workspace ? "Stop all" : "Stop All Sounds"}
        </button>
      </div>
      )}

      {showRoster && (voiceState === "error" || voiceState === "closed") && (
        <div className="live-actions">
          <button className="btn sm" onClick={reconnect}>
            Reconnect
          </button>
        </div>
      )}

      {showRoster && <ChannelRoster channelName={channel.name} />}
      </div>
      )}
    </div>
  );
}
