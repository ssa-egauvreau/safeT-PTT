import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { isPageHidden, onPageVisible } from "../lib/pageVisibility";
import type { AiDispatchMode, Permission, ToneOut, UserChannel } from "../api";
import { api, voiceCodecBadge, voiceCodecLabel } from "../api";
import { VoiceChannelClient, type VoiceState, type ToneOutKind } from "../voice/voiceClient";
import { scheduleConnect } from "../voice/connectScheduler";
import { AudioLevelMeter } from "../voice/AudioLevelMeter";
import { ChannelMemberCount } from "../components/ChannelMemberCount";
import { ChannelRoster } from "./ChannelRoster";
import { LatestChannelTransmission } from "../components/LatestChannelTransmission";
import type { PushedTalker } from "../hooks/useChannelLiveRx";
import { useChannelRoster } from "../hooks/useChannelRoster";
import type { WorkspaceWidgetSize } from "../consoleStore";
import { sounds } from "../sounds";
import { useToneOuts, loadTonePcm, ToneOutBadge } from "../toneOuts";
import {
  IconAi,
  IconBolt,
  IconBeacon,
  IconKeyboard,
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
 * Explainer for the AI-dispatch toggle. Kept as the button's hover tooltip only
 * — it's reference info, not an actionable warning, so it shouldn't take a line
 * of on-card space every time AI dispatch is on (actionable config warnings,
 * e.g. a missing key, still render as the note).
 */
const AI_DISPATCH_ON_NOTE =
  "AI dispatch uses clear audio for transcripts; Fast (vocoder) still keys the channel for other units.";

// Three-way AI dispatch control: tap cycles Off → Supervised → Auto.
const AI_DISPATCH_CYCLE: AiDispatchMode[] = ["off", "supervised", "full_auto"];
const AI_DISPATCH_LABEL: Record<AiDispatchMode, string> = {
  off: "OFF",
  supervised: "SUPERV",
  full_auto: "AUTO",
};
const AI_DISPATCH_MODE_NOTE: Record<AiDispatchMode, string> = {
  off: "AI dispatcher is off on this channel. Tap to require the wake word “AI”.",
  supervised:
    "Supervised: the dispatcher only replies when a unit opens with the wake word “AI” (e.g. “AI, 27-000 show me on a patrol check”). Tap for full auto.",
  full_auto:
    "Full auto: the dispatcher acts on every qualifying transmission. Tap to turn off.",
};
function nextAiDispatchMode(mode: AiDispatchMode): AiDispatchMode {
  const i = AI_DISPATCH_CYCLE.indexOf(mode);
  return AI_DISPATCH_CYCLE[(i + 1) % AI_DISPATCH_CYCLE.length]!;
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
  const [aiDispatchMode, setAiDispatchMode] = useState<AiDispatchMode>(
    channel.ai_dispatch_mode ?? (channel.ai_dispatch_enabled === true ? "full_auto" : "off"),
  );
  const aiDispatchOn = aiDispatchMode !== "off";
  const [aiDispatchReady, setAiDispatchReady] = useState(false);
  const [aiDispatchHint, setAiDispatchHint] = useState<string | null>(null);
  const [volume, setVolume] = useState(() => loadVolume(channel.id));
  const [muted, setMuted] = useState(() => loadMuted(channel.id));
  const [audioOutputId, setAudioOutputId] = useState(() => loadAudioOutputId(channel.id));
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [receiving, setReceiving] = useState(false);
  /** Relay-pushed talker (air_claimed/air_released) for instant attribution. */
  const [pushedTalker, setPushedTalker] = useState<PushedTalker | null>(null);
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
      onAirClaimed: (unitId, displayName) => setPushedTalker({ unitId, displayName }),
      onAirReleased: () => setPushedTalker(null),
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
    // Stagger the initial connect so a reload with many docked channels doesn't open
    // every AudioContext + WebSocket in the same frame (which can freeze the tab).
    const cancelScheduled = scheduleConnect(connect);
    return () => {
      cancelScheduled();
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

  function endTransmit(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopTx();
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
        setAiDispatchMode(row.mode ?? (row.enabled ? "full_auto" : "off"));
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
    client.setAiDispatchListenPcm(aiDispatchOn);
    client.setDigitalTx(loadTxDigital(channel.id));
  }, [aiDispatchOn, monitoring, channel.id]);

  function cycleAiDispatch() {
    if (!aiDispatchReady) {
      return;
    }
    const prev = aiDispatchMode;
    const next = nextAiDispatchMode(prev);
    setAiDispatchMode(next);
    void api.setChannelAiDispatch(channel.name, next).catch(() => {
      setAiDispatchMode(prev);
    });
    clientRef.current?.setAiDispatchListenPcm(next !== "off");
    // Don't push the clear-audio explainer into the on-card note — it's hover-only
    // now. `aiDispatchHint` is left to the config-warning effect (missing key, etc.).
  }

  useEffect(() => {
    // Only poll the 10-33 marker for rows the operator is actually watching.
    if (!monitoring && !expanded) {
      return;
    }
    let cancelled = false;
    const syncTen33 = () => {
      if (isPageHidden()) return; // skip while the operator can't see the marker
      void api.getChannelTen33(channel.name).then((r) => {
        if (cancelled) {
          return;
        }
        setMarker((prev) => (prev === r.active ? prev : r.active));
      });
    };
    syncTen33();
    const timer = window.setInterval(syncTen33, 4000);
    const offVisible = onPageVisible(syncTen33);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offVisible();
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
    // 10-33 runs server-side on a repeating timer. Always clear it (when allowed
    // to transmit) — it may have been armed by the AI dispatcher rather than from
    // this console, in which case the locally-polled `marker` state can be stale,
    // so gating on it would leave an AI-armed 10-33 playing until a verbal 10-34.
    if (canTransmit) {
      setMarker(false);
      // No optimistic rollback on failure: the periodic 10-33 poll re-syncs the
      // true state, so a transient error self-corrects instead of flipping back on.
      void api.setChannelTen33(channel.name, false).catch(() => undefined);
    }
    setLoopingIds(new Set());
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
      ? { toolbar: 12, volume: 12, radio: 14, txMain: 18, action: 11, tone: 10, badge: 10, member: 10 }
      : wsSize === "medium"
        ? { toolbar: 13, volume: 13, radio: 16, txMain: 20, action: 12, tone: 11, badge: 11, member: 11 }
        : { toolbar: 14, volume: 14, radio: 18, txMain: 22, action: 12, tone: 11, badge: 11, member: 12 }
    : null;
  const showToolbar = true;
  /* Workspace tiles pack controls side by side to save rows: volume + keyboard
     PTT + ON share the toolbar; AI dispatch, TX mode, 10-33, and Stop all share
     one quick-controls row; permission + audio out share another (L only). */
  const volumeInToolbar = workspace;
  const showVolumeInBody = !workspace;
  const showVolPct = !workspace || wsSize === "large";
  const showStatusChip =
    workspace &&
    wsSize !== "small" &&
    monitoring &&
    (transmitting ||
      receiving ||
      voiceState === "error" ||
      voiceState === "connecting" ||
      voiceState === "closed");
  const showMemberCount = workspace && wsSize !== "small";
  const showMeta = !workspace || wsSize === "large";
  const showPermission = !workspace || wsSize === "large";
  const showPttAssign = monitoring && (!workspace || wsSize === "medium" || wsSize === "large");
  const showControlRow = !workspace && (showPermission || showPttAssign);
  const showAudioOut = !workspace || wsSize === "large";
  const showActionsGrid = !workspace;
  const showQuickControls = workspace && (wsSize === "medium" || wsSize === "large");
  const showTones = workspace && wsSize === "large";
  const showLiveTx = workspace;
  const showRoster = workspace && (wsSize === "medium" || wsSize === "large");
  const rosterPollEnabled = monitoring && (showRoster || showMemberCount);
  const { members: rosterMembers, count: rosterCount } = useChannelRoster(
    channel.name,
    rosterPollEnabled,
  );
  /** Workspace tiles use the body XMIT pad only (no toolbar PTT). */
  const showMainTxButton = true;
  /** Zone caption shown under the channel name, e.g. "Zone 1 : Patrol". */
  const zoneLabel = [
    channel.zone_number != null ? `Zone ${channel.zone_number}` : null,
    channel.zone || null,
  ]
    .filter(Boolean)
    .join(" : ");
  /** Who is currently keyed on the channel — shown inside the XMIT button while
   *  receiving, so the live talker no longer needs a separate (card-resizing) box. */
  const rxTalkerLabel = pushedTalker
    ? `Receiving · ${pushedTalker.unitId}${pushedTalker.displayName ? ` · ${pushedTalker.displayName}` : ""}`
    : "Receiving";
  const showActionNotes =
    !workspace
      ? marker || aiDispatchHint || (aiDispatchOn && !aiDispatchHint)
      : wsSize === "large" && (marker || aiDispatchHint);

  const volumeControls = (
    <>
      <button
        className="vol-mute"
        onClick={toggleMute}
        title={muted ? "Unmute channel" : "Mute channel"}
        type="button"
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
      {showVolPct ? (
        <span className="vol-pct">{muted ? "Muted" : `${Math.round(volume * 100)}%`}</span>
      ) : null}
    </>
  );

  const volumeRow = showVolumeInBody ? (
    <div className="volume-row">
      {volumeControls}
    </div>
  ) : null;

  const workspaceToolbar = showToolbar ? (
    <div
      className={`ch-card-toolbar${workspace ? ` workspace-toolbar workspace-toolbar--${wsSize}` : ""}`}
    >
      {volumeInToolbar ? (
        <div className="ch-toolbar-volume volume-row">{volumeControls}</div>
      ) : null}
      <div className="ch-toolbar-transport">
        {showStatusChip &&
          (connected ? (
            <span className={`state-chip ${transmitting ? "tx" : receiving ? "rx" : voiceState}`}>
              {transmitting ? "ON AIR" : receiving ? "RX" : STATE_LABEL[voiceState]}
            </span>
          ) : (
            <span className={`state-chip ${voiceState}`}>{STATE_LABEL[voiceState]}</span>
          ))}
        {showStatusChip && receiving && !transmitting && (
          <span className="state-chip busy">BUSY</span>
        )}
        {workspace &&
          showPttAssign &&
          (primary ? (
            <span
              className="ch-kbd-chip on"
              title={`Keyboard PTT (${keyLabel(pttCode)}) talks on this channel`}
            >
              <IconKeyboard size={wsIcon?.toolbar ?? 14} />
              <span className="ch-kbd-chip-key">{keyLabel(pttCode)}</span>
            </span>
          ) : (
            <button
              type="button"
              className="ch-kbd-chip"
              onClick={onMakePrimary}
              title="Route the keyboard PTT key to this channel"
            >
              <IconKeyboard size={wsIcon?.toolbar ?? 14} />
              <span className="ch-kbd-chip-key">PTT</span>
            </button>
          ))}
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
      </div>
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
              title={workspaceChrome ? "Drag the name bar to reorder (not XMIT or S / M / L)" : undefined}
            >
              <div className="ch-card-title-main">
                <div className="ch-card-name ch-card-name-static">
                  <IconRadio size={wsIcon?.radio ?? 14} />
                  <span className="ch-card-label">{channel.name}</span>
                  {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
                  {voiceCodecBadge(channel.codec) && (
                    <span className="chan-sim-tag" title={voiceCodecLabel(channel.codec)}>
                      {voiceCodecBadge(channel.codec)}
                    </span>
                  )}
                </div>
                {zoneLabel && <span className="ch-card-zone">{zoneLabel}</span>}
                {showMemberCount && (
                  <ChannelMemberCount
                    channelName={channel.name}
                    iconSize={wsIcon?.member ?? 14}
                    count={rosterCount}
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
            {zoneLabel && <span className="ch-card-zone ch-card-zone--row">{zoneLabel}</span>}
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
              onPointerUp={endTransmit}
              onPointerCancel={endTransmit}
              onLostPointerCapture={stopTx}
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
      {volumeRow}

      {showMainTxButton && workspace && (
        <section className="ch-ws-section ch-ws-section--xmit" aria-label="Transmit">
          <button
            type="button"
            className={`tx-button tx-button-integrated tx-button-ws--${wsSize}${
              transmitting ? " active" : receiving ? " busy" : ""
            }`}
            disabled={!monitoring || !connected || !canTransmit}
            onPointerDown={beginTransmit}
            onPointerUp={endTransmit}
            onPointerCancel={endTransmit}
            onLostPointerCapture={stopTx}
            title={
              !monitoring
                ? "Turn the channel on to transmit"
                : !canTransmit
                  ? "Listen-only on this channel"
                  : "Hold to transmit"
            }
          >
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
            <span className="tx-main">
              <IconBolt size={wsIcon?.txMain ?? 22} />
              {transmitting ? "ON AIR" : receiving ? "BUSY" : !canTransmit ? "LISTEN ONLY" : "XMIT"}
            </span>
            <span className="tx-sub">
              {transmitting
                ? "Release to stop"
                : receiving
                  ? rxTalkerLabel
                  : !canTransmit
                    ? "No transmit permission"
                    : !connected
                      ? "Connecting…"
                      : !monitoring
                        ? "Turn channel on first"
                        : wsSize === "small"
                          ? primary
                            ? `Hold · ${keyLabel(pttCode)}`
                            : "Hold to talk"
                          : primary
                            ? `Hold to talk · ${keyLabel(pttCode)}`
                            : "Hold to talk"}
            </span>
          </button>
        </section>
      )}

      {showControlRow && (
        <div className="ch-control-row">
          {showPermission && (
            <div className="live-meta">
              Permission: <strong>{PERMISSION_LABEL[permission]}</strong>
            </div>
          )}
          {showPttAssign && (
            <div className="cp-ptt-assign">
              {primary ? (
                <span className="cp-primary" title="Keyboard PTT controls this channel">
                  Keyboard PTT
                </span>
              ) : (
                <button
                  type="button"
                  className="ch-setprimary"
                  onClick={onMakePrimary}
                  title="Use the keyboard PTT for this channel"
                >
                  Set keyboard PTT
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showAudioOut &&
        (() => {
          const audioOut = (
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
          );
          // Workspace: permission + audio output share one row to save height.
          return workspace ? (
            <div className="ch-ws-io-row">
              {showPermission && (
                <span className="ch-ws-permission" title="Your permission on this channel">
                  {PERMISSION_LABEL[permission]}
                </span>
              )}
              {audioOut}
            </div>
          ) : (
            audioOut
          );
        })()}

      {showMeta && voiceDetail && (
        <div className={`banner ${voiceState === "error" ? "error" : "info"}`}>{voiceDetail}</div>
      )}

      {showMainTxButton && !workspace && (
      <button
        className={`tx-button${transmitting ? " active" : receiving ? " busy" : ""}`}
        disabled={!connected || !canTransmit}
        onPointerDown={beginTransmit}
        onPointerUp={endTransmit}
        onPointerCancel={endTransmit}
        onLostPointerCapture={stopTx}
      >
        <span className="tx-main">
          <IconBolt size={26} />
          {transmitting ? "ON AIR" : receiving ? "BUSY" : !canTransmit ? "LISTEN ONLY" : "XMIT"}
        </span>
        <span className="tx-sub">
          {transmitting
            ? "release to stop"
            : receiving
              ? rxTalkerLabel
              : !canTransmit
                ? "no transmit permission"
                : !connected
                  ? "connecting…"
                  : primary
                    ? `hold to talk · ${keyLabel(pttCode)}`
                    : "hold to talk"}
        </span>
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
        <section className="ch-ws-section ch-ws-section--transmissions" aria-label="Transmissions">
          <LatestChannelTransmission
            variant="console"
            channelName={channel.name}
            active={monitoring && connected}
            homeReceiving={receiving && !transmitting}
            hideLiveBadge
            pushedTalker={pushedTalker}
            workspaceSize={workspace ? wsSize : undefined}
            logHint={
              wsSize === "large"
                ? "Full history is in the transmission log below."
                : ""
            }
          />
        </section>
      )}

      {showQuickControls && (
        <div className="ch-quick-controls" role="group" aria-label="Channel controls">
          <button
            type="button"
            aria-label={`AI dispatch mode: ${AI_DISPATCH_LABEL[aiDispatchMode]} (tap to change)`}
            className={`ch-action-cell ch-qc-ai${aiDispatchOn ? " active" : ""}${
              aiDispatchMode === "supervised" ? " supervised" : ""
            }`}
            disabled={!aiDispatchReady}
            onClick={cycleAiDispatch}
            title={aiDispatchHint ?? AI_DISPATCH_MODE_NOTE[aiDispatchMode]}
          >
            <span className="ch-action-kicker">AI dispatch</span>
            <strong className="ch-qc-value">
              {aiDispatchOn && <IconAi size={wsIcon?.action ?? 11} className="ch-ai-spark" />}
              {AI_DISPATCH_LABEL[aiDispatchMode]}
            </strong>
          </button>
          <button
            type="button"
            className={`marker-button ch-action-cell${marker ? " active" : ""}`}
            disabled={!connected || !canTransmit}
            onClick={toggleMarker}
            title="10-33 emergency marker tone"
          >
            <span className="ch-action-kicker">Marker</span>
            <strong className="ch-qc-value">
              <IconBeacon size={wsIcon?.action ?? 11} />
              {marker ? "10-33 ON" : "10-33"}
            </strong>
          </button>
          <button
            type="button"
            className="ch-action-cell ch-qc-stop"
            onClick={stopAllSounds}
            title="Stop all sounds — tones, loops, and the 10-33 marker"
          >
            <span className="ch-action-kicker">Sounds</span>
            <strong className="ch-qc-value">
              <IconStop size={wsIcon?.action ?? 11} />
              Stop
            </strong>
          </button>
        </div>
      )}

      {showActionsGrid && (
      <div className="ch-actions-stack">
        <button
          type="button"
          className={marker ? "marker-button active ch-action-cell" : "marker-button ch-action-cell"}
          disabled={!connected || !canTransmit}
          onClick={toggleMarker}
          title="10-33 emergency marker tone"
        >
          <IconBeacon size={18} />
          <span>{marker ? "10-33 MARKER ON" : "10-33 CHANNEL MARKER"}</span>
        </button>

      </div>
      )}
      {showActionNotes && (
        <div className="ch-action-notes">
          {marker && <span className="marker-note">10-33 marker tone every 12s</span>}
          {aiDispatchHint ? (
            <span className="marker-note muted">{aiDispatchHint}</span>
          ) : (
            aiDispatchOn && (
              <span className="marker-note muted">
                {AI_DISPATCH_MODE_NOTE[aiDispatchMode]}
                {aiDispatchMode === "full_auto" ? ` ${AI_DISPATCH_ON_NOTE}` : ""}
              </span>
            )
          )}
        </div>
      )}

      {showTones && (
      <div className="toneout">
        <div className="ch-tone-grid">
          <button
            type="button"
            className="toneout-btn routine ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("routine")}
            aria-label="Routine tone"
            title="Routine tone"
          >
            <IconToneRoutine size={wsIcon?.tone ?? 13} />
            Routine
          </button>
          <button
            type="button"
            className="toneout-btn priority ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("priority")}
            aria-label="Priority tone"
            title="Priority tone"
          >
            <IconTonePriority size={wsIcon?.tone ?? 13} />
            Priority
          </button>
          <button
            type="button"
            className="toneout-btn status ch-action-cell"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("status")}
            aria-label="Status tone"
            title="Status tone"
          >
            <IconToneStatus size={wsIcon?.tone ?? 13} />
            Status
          </button>
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
                  style={{ ["--tone-color" as string]: toneOut.icon_color }}
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
                  <ToneOutBadge toneOut={toneOut} size={wsIcon?.badge ?? 14} />
                  <span className="toneout-label">{toneOut.name}</span>
                  {isLoop && <span className="toneout-mode">{looping ? "■" : "↻"}</span>}
                </button>
              );
            })}
        </div>
      </div>
      )}

      {showRoster && (voiceState === "error" || voiceState === "closed") && (
        <div className="live-actions">
          <button className="btn sm" onClick={reconnect}>
            Reconnect
          </button>
        </div>
      )}

      {showRoster && (
        <section className="ch-ws-section ch-ws-section--roster" aria-label="Users on channel">
          <ChannelRoster
            channelName={channel.name}
            compact={workspace && wsSize !== "large"}
            members={rosterMembers}
          />
        </section>
      )}
      </div>
      )}
    </div>
  );
}
