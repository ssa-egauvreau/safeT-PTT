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
import { Waveform } from "../voice/Waveform";
import { ChannelRoster } from "./ChannelRoster";
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
  loadMuted,
  loadTxDigital,
  loadVolume,
  muteKey,
  txDigitalKey,
  volumeKey,
} from "./consoleShared";

/** How long to wait between a server-driven WS close and the next auto-reconnect attempt. */
const VOICE_RECONNECT_DELAY_MS = 3000;

interface ChannelPanelProps {
  channel: UserChannel;
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
}

/**
 * One channel as a collapsible accordion row. Collapsed it shows the name, an
 * on/off (monitor) toggle, and a quick PTT button; expanded it reveals the full
 * control surface — listen, transmit, 10-33 marker, AI dispatch, and tone-outs.
 */
export function ChannelPanel({
  channel,
  monitoring,
  expanded,
  primary,
  pttCode,
  keyboardOn,
  onToggleMonitor,
  onToggleExpanded,
  onMakePrimary,
}: ChannelPanelProps) {
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

  function toggleAiDispatch() {
    if (!aiDispatchReady) {
      return;
    }
    const next = !aiDispatch;
    setAiDispatch(next);
    void api.setChannelAiDispatch(channel.name, next).catch(() => {
      setAiDispatch(!next);
    });
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

  return (
    <div
      className={`channel-card${expanded ? " expanded" : ""}${primary ? " primary" : ""}`}
      style={channel.color ? { borderLeftColor: channel.color, borderLeftWidth: 3 } : undefined}
    >
      <div className="ch-card-head">
        <button
          className="ch-disclosure"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          title={expanded ? "Collapse channel" : "Expand channel"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button className="ch-card-name" onClick={onToggleExpanded}>
          <IconRadio size={14} />
          <span className="ch-card-label">{channel.name}</span>
          {channel.simulcast && <span className="chan-sim-tag">SIM</span>}
        </button>
        {monitoring && (
          <span className={`state-chip ${voiceState}`}>{STATE_LABEL[voiceState]}</span>
        )}
        {monitoring && receiving && !transmitting && <span className="state-chip busy">BUSY</span>}
        {monitoring &&
          (primary ? (
            <span className="cp-primary" title="Keyboard PTT controls this channel">
              PTT
            </span>
          ) : (
            <button
              className="ch-setprimary"
              onClick={onMakePrimary}
              title="Use the keyboard PTT for this channel"
            >
              Set PTT
            </button>
          ))}
        <button
          className={monitoring ? "ch-power active" : "ch-power"}
          onClick={onToggleMonitor}
          aria-pressed={monitoring}
          title={monitoring ? "Turn channel off (stop monitoring)" : "Turn channel on (monitor)"}
        >
          <IconHeadphones size={16} />
          <span>{monitoring ? "ON" : "OFF"}</span>
        </button>
        <button
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
      </div>

      {expanded && (
      <div className="ch-card-body">
      <div className="live-meta">
        Permission: <strong>{PERMISSION_LABEL[permission]}</strong>
      </div>

      <div className="volume-row">
        <button
          className="vol-mute"
          onClick={toggleMute}
          title={muted ? "Unmute channel" : "Mute channel"}
        >
          {muted ? <IconVolumeMuted size={16} /> : <IconVolume size={16} />}
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

      {voiceDetail && (
        <div className={`banner ${voiceState === "error" ? "error" : "info"}`}>{voiceDetail}</div>
      )}

      <button
        className={transmitting ? "tx-button active" : receiving ? "tx-button busy" : "tx-button"}
        disabled={!connected || !canTransmit}
        onPointerDown={beginTransmit}
        onPointerUp={stopTx}
        onPointerCancel={stopTx}
      >
        <span className="tx-main">
          <IconBolt size={26} />
          {transmitting ? "ON AIR" : !canTransmit ? "LISTEN ONLY" : receiving ? "BUSY" : "XMIT"}
        </span>
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
      </button>

      <div className={`waveform-strip${transmitting ? " tx" : receiving ? " rx" : ""}`}>
        <Waveform
          getLevel={() => clientRef.current?.getLevel() ?? 0}
          active={transmitting || receiving}
          variant={transmitting ? "tx" : "rx"}
        />
      </div>

      <button className="txmode-btn" onClick={toggleTxMode}>
        TX MODE: <strong>{txDigital ? "COMPRESSED · FAST" : "HIGH QUALITY · NORMAL SPEED"}</strong>
      </button>

      <button
        className={marker ? "marker-button active" : "marker-button"}
        disabled={!connected || !canTransmit}
        onClick={toggleMarker}
      >
        <IconBeacon size={18} />
        <span>{marker ? "10-33 MARKER ON" : "10-33 CHANNEL MARKER"}</span>
      </button>
      {marker && <div className="marker-note">Emergency traffic — marker tone every 12s</div>}

      <button
        className={aiDispatch ? "marker-button active" : "marker-button"}
        disabled={!aiDispatchReady}
        onClick={toggleAiDispatch}
        title={
          aiDispatchHint ??
          "When on, unit transmissions on this channel can trigger an AI dispatcher reply on the air."
        }
      >
        <span>{aiDispatch ? "AI DISPATCH ON" : "AI DISPATCH OFF"}</span>
      </button>
      {aiDispatchHint && (
        <div className="marker-note muted">{aiDispatchHint}</div>
      )}
      {aiDispatch && !aiDispatchHint && (
        <div className="marker-note">
          Unit traffic is transcribed; AI replies as {channel.name} traffic when configured.
        </div>
      )}

      <div className="toneout">
        <div className="toneout-row">
          <button
            className="toneout-btn"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("routine")}
          >
            <IconToneRoutine size={16} />
            Routine
          </button>
          <button
            className="toneout-btn priority"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("priority")}
          >
            <IconTonePriority size={16} />
            Priority
          </button>
          <button
            className="toneout-btn"
            disabled={!connected || !canTransmit}
            onClick={() => sendTone("status")}
          >
            <IconToneStatus size={16} />
            Status
          </button>
        </div>
        {toneOuts.some((t) => t.has_audio) && (
          <div className="toneout-custom">
            {toneOuts
              .filter((t) => t.has_audio)
              .map((toneOut) => {
                const looping = loopingIds.has(toneOut.id);
                const isLoop = toneOut.play_mode === "loop";
                return (
                  <button
                    key={toneOut.id}
                    className={looping ? "toneout-btn custom looping" : "toneout-btn custom"}
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
                    <ToneOutBadge toneOut={toneOut} size={16} />
                    <span className="toneout-label">{toneOut.name}</span>
                    {isLoop && <span className="toneout-mode">{looping ? "■ loop" : "↻ loop"}</span>}
                  </button>
                );
              })}
          </div>
        )}
        <button className="stopall-btn" onClick={stopAllSounds}>
          <IconStop size={16} />
          Stop All Sounds
        </button>
      </div>

      {(voiceState === "error" || voiceState === "closed") && (
        <div className="live-actions">
          <button className="btn sm" onClick={reconnect}>
            Reconnect
          </button>
        </div>
      )}

      <ChannelRoster channelName={channel.name} />
      </div>
      )}
    </div>
  );
}
