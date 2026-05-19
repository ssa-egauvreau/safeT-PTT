import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from "react";
import type { Permission, UserChannel } from "../api";
import { api } from "../api";
import { VoiceChannelClient, type VoiceState, type ToneOutKind } from "../voice/voiceClient";
import { ChannelRoster } from "./ChannelRoster";
import { sounds } from "../sounds";
import {
  IconBolt,
  IconBeacon,
  IconToneRoutine,
  IconTonePriority,
  IconToneStatus,
  IconStop,
  IconVolume,
  IconVolumeMuted,
} from "../icons";
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PERMISSION_LABEL,
  STATE_LABEL,
  keyLabel,
  loadMuted,
  loadPanelWidth,
  loadTxDigital,
  loadVolume,
  muteKey,
  panelWidthKey,
  txDigitalKey,
  volumeKey,
} from "./consoleShared";

interface ChannelPanelProps {
  channel: UserChannel;
  /** Whether the keyboard PTT key controls this panel. */
  primary: boolean;
  pttCode: string;
  keyboardOn: boolean;
  onMakePrimary: () => void;
  onClose: () => void;
  /** Drops a dragged panel (by channel id) onto this one to reorder the strip. */
  onReorder?: (fromId: number) => void;
}

/** One channel's full control surface: listen, transmit, marker, and tone-outs. */
export function ChannelPanel({
  channel,
  primary,
  pttCode,
  keyboardOn,
  onMakePrimary,
  onClose,
  onReorder,
}: ChannelPanelProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>("connecting");
  const [voiceDetail, setVoiceDetail] = useState<string | null>(null);
  const [permission, setPermission] = useState<Permission>(channel.permission);
  const [marker, setMarker] = useState(false);
  const [txDigital, setTxDigital] = useState(() => loadTxDigital(channel.id));
  const [volume, setVolume] = useState(() => loadVolume(channel.id));
  const [muted, setMuted] = useState(() => loadMuted(channel.id));
  const [receiving, setReceiving] = useState(false);

  const clientRef = useRef<VoiceChannelClient | null>(null);
  /** Whether the operator is currently holding PTT — gates the looping busy tone. */
  const pttHeldRef = useRef(false);

  // --- panel layout: drag-to-reorder + drag-to-resize --------------------
  const rootRef = useRef<HTMLDivElement | null>(null);
  // dragenter/dragleave bubble from children, so a depth counter avoids flicker.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // Restore the operator's saved panel width and persist any later resize.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const saved = loadPanelWidth(channel.id);
    if (saved != null) {
      el.style.width = `${saved}px`;
    }
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const width = parseInt(el.style.width, 10);
        if (Number.isFinite(width) && width >= PANEL_MIN_WIDTH && width <= PANEL_MAX_WIDTH) {
          localStorage.setItem(panelWidthKey(channel.id), String(width));
        }
      }, 400);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [channel.id]);

  function handleDragEnter() {
    if (!onReorder) {
      return;
    }
    dragDepth.current += 1;
    setDragOver(true);
  }

  function handleDragLeave() {
    if (!onReorder) {
      return;
    }
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onReorder) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const from = Number(event.dataTransfer.getData("text/plain"));
    if (Number.isFinite(from) && from !== channel.id) {
      onReorder?.(from);
    }
  }

  const connect = useCallback(() => {
    const client = new VoiceChannelClient(channel.name, {
      onState: (state, detail) => {
        setVoiceState(state);
        setVoiceDetail(detail ?? null);
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

  useEffect(() => {
    connect();
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
      sounds.busyLoopStop();
    };
  }, [connect]);

  const startTx = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
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

  // Keyboard hold-to-talk — only while this panel is the primary one.
  useEffect(() => {
    if (!primary || !keyboardOn) {
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
  }, [primary, keyboardOn, pttCode, startTx, stopTx]);

  function beginTransmit(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    void startTx();
  }

  function toggleMarker() {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    const next = !marker;
    client.setChannelMarker(next);
    setMarker(next);
    // Also flag the channel server-side so radios show the 10-33 warning icon.
    void api.setChannelTen33(channel.name, next).catch(() => undefined);
  }

  function sendTone(kind: ToneOutKind) {
    clientRef.current?.sendToneOut(kind);
  }

  function stopAllSounds() {
    clientRef.current?.stopAllTones();
    sounds.stopAll();
    setMarker(false);
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
    clientRef.current?.close();
    setVoiceState("connecting");
    setVoiceDetail(null);
    setMarker(false);
    connect();
  }

  const connected = voiceState === "listening" || voiceState === "transmitting";
  const canTransmit = permission !== "listen_only";
  const transmitting = voiceState === "transmitting";

  return (
    <div
      ref={rootRef}
      className={`channel-panel live-panel${primary ? " primary" : ""}${dragOver ? " drag-over" : ""}`}
      style={channel.color ? { borderTopColor: channel.color, borderTopWidth: 3 } : undefined}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="cp-head"
        onClick={onMakePrimary}
        title={primary ? "Keyboard PTT controls this channel" : "Click to control with the keyboard PTT"}
      >
        {onReorder && (
          <span
            className="cp-grip"
            draggable
            onClick={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", String(channel.id));
              e.dataTransfer.effectAllowed = "move";
            }}
            title="Drag to reorder this channel"
            aria-label="Drag to reorder this channel"
          >
            ⠿
          </span>
        )}
        <span className="live-channel cp-name">{channel.name}</span>
        <span className={`state-chip ${voiceState}`}>{STATE_LABEL[voiceState]}</span>
        {receiving && !transmitting && <span className="state-chip busy">BUSY</span>}
        {primary && <span className="cp-primary">PTT</span>}
        <button
          className="cp-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close channel"
        >
          ✕
        </button>
      </div>

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
  );
}
