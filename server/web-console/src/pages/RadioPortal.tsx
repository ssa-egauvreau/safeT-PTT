import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  describeError,
  fetchTransmissionAudio,
  type ChannelMember,
  type Permission,
  type Transmission,
  type UserChannel,
} from "../api";
import { useAuth } from "../auth";
import { Topbar } from "../Topbar";
import { VoiceChannelClient, type VoiceState } from "../voice/voiceClient";
import { ScanListenClient } from "../voice/scanListenClient";
import { useUnitAliasResolver } from "../unitAliases";
import { formatDuration, formatTime, transcriptOf } from "./TransmissionLog";

const ROSTER_POLL_MS = 5_000;
const TRANSMISSIONS_POLL_MS = 12_000;
const TRANSMISSIONS_CAP = 20;
const EMERGENCY_HOLD_MS = 1500;

/**
 * Mobile-friendly portal for `radio`-role accounts. Renders the same channels / PTT / scan
 * surface a handset has, in a single scrollable column suitable for a phone browser. Reuses the
 * dispatch console's voice plumbing (VoiceChannelClient) so PTT / RX audio is identical.
 */
export function RadioPortal() {
  const { user, logout } = useAuth();
  const aliasFor = useUnitAliasResolver();
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [permission, setPermission] = useState<Permission>("listen_only");
  const [receiving, setReceiving] = useState(false);
  const [transmitting, setTransmitting] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [scanEnabled, setScanEnabled] = useState(false);
  const [scanList, setScanList] = useState<Set<string>>(new Set());
  const [scanActiveChannel, setScanActiveChannel] = useState<string | null>(null);
  const [scanPickerOpen, setScanPickerOpen] = useState(false);

  const [roster, setRoster] = useState<ChannelMember[]>([]);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [emergencyActive, setEmergencyActive] = useState(false);
  const [emergencyArming, setEmergencyArming] = useState(false);
  const [busyEmergency, setBusyEmergency] = useState(false);
  const [playingTxId, setPlayingTxId] = useState<number | null>(null);

  const voiceRef = useRef<VoiceChannelClient | null>(null);
  const scanRef = useRef<ScanListenClient | null>(null);
  const emergencyTimerRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // --- channel list ---
  useEffect(() => {
    let cancelled = false;
    api
      .myChannels()
      .then((res) => {
        if (cancelled) return;
        setChannels(res.channels);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- main voice client (created on first channel pick, recreated on channel change) ---
  const joinChannel = useCallback((channelName: string) => {
    // Tear down any previous client before connecting the new one so we never have two open.
    voiceRef.current?.close();
    voiceRef.current = null;
    setVoiceState("connecting");
    setVoiceError(null);
    setReceiving(false);
    setTransmitting(false);
    setPermission("listen_only");

    const client = new VoiceChannelClient(channelName, {
      onState: (state, detail) => {
        setVoiceState(state);
        if (state === "error" && detail) setVoiceError(detail);
        if (state === "transmitting") setTransmitting(true);
        if (state === "listening") setTransmitting(false);
      },
      onPermission: (p) => setPermission(p),
      onReceiving: (r) => setReceiving(r),
      onBusy: () => {
        // The relay rejected our key — already handled inside the client (stopTransmit), just
        // make sure local UI reflects that we're not transmitting.
        setTransmitting(false);
      },
    });
    voiceRef.current = client;
    client.connect();
    setSelectedChannel(channelName);
  }, []);

  // Keep the scan-listen client's "home channel" in sync so we don't open a second WS to the
  // channel the user is already tuned to.
  useEffect(() => {
    if (selectedChannel) {
      scanRef.current?.setHomeChannel(selectedChannel);
    }
  }, [selectedChannel]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      voiceRef.current?.close();
      voiceRef.current = null;
      scanRef.current?.closeAll();
      scanRef.current = null;
      if (emergencyTimerRef.current !== null) {
        window.clearTimeout(emergencyTimerRef.current);
      }
    };
  }, []);

  // --- scan listen reconciliation ---
  useEffect(() => {
    if (!scanRef.current) {
      scanRef.current = new ScanListenClient(selectedChannel ?? "", {
        onChannelActivity: (channel, receivingNow) => {
          // Latch the most recent scan-channel that became active so the banner can name it.
          if (receivingNow) {
            setScanActiveChannel(channel);
          } else {
            setScanActiveChannel((current) => (current === channel ? null : current));
          }
        },
      });
    }
    scanRef.current.setScanList(Array.from(scanList));
    scanRef.current.setEnabled(scanEnabled);
    if (!scanEnabled) {
      setScanActiveChannel(null);
    }
  }, [scanEnabled, scanList, selectedChannel]);

  // --- roster + transmissions polling ---
  useEffect(() => {
    if (!selectedChannel) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    async function fetchRoster() {
      try {
        const channel = selectedChannel;
        if (!channel) return;
        const res = await api.channelRoster(channel);
        if (cancelled) return;
        setRoster(res.members);
      } catch {
        /* transient — let next poll retry */
      }
    }
    void fetchRoster();
    const id = window.setInterval(fetchRoster, ROSTER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedChannel]);

  useEffect(() => {
    if (!selectedChannel) {
      setTransmissions([]);
      return;
    }
    let cancelled = false;
    async function fetchTx() {
      try {
        const channel = selectedChannel;
        if (!channel) return;
        const res = await api.transmissions({ channel, limit: TRANSMISSIONS_CAP });
        if (cancelled) return;
        setTransmissions(res.transmissions);
      } catch {
        /* transient */
      }
    }
    void fetchTx();
    const id = window.setInterval(fetchTx, TRANSMISSIONS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedChannel]);

  // --- PTT handlers ---
  // The same client.startTransmit / stopTransmit gestures dispatch uses; we wire them to a big
  // hold-to-talk button instead of a hardware key.
  const startPtt = useCallback(async () => {
    const client = voiceRef.current;
    if (!client) return;
    try {
      await client.startTransmit();
    } catch (err) {
      const code = err instanceof Error ? err.message : "transmit_failed";
      setVoiceError(
        code === "listen_only"
          ? "You can only listen on this channel."
          : code === "channel_busy"
            ? "Channel busy — another unit is keyed."
            : code === "not_connected"
              ? "Not connected — pick a channel first."
              : "Transmit failed.",
      );
    }
  }, []);
  const stopPtt = useCallback(() => {
    voiceRef.current?.stopTransmit();
  }, []);

  // --- emergency long-press ---
  const beginEmergencyHold = useCallback(() => {
    if (busyEmergency) return;
    setEmergencyArming(true);
    if (emergencyTimerRef.current !== null) {
      window.clearTimeout(emergencyTimerRef.current);
    }
    emergencyTimerRef.current = window.setTimeout(() => {
      emergencyTimerRef.current = null;
      setEmergencyArming(false);
      fireEmergency();
    }, EMERGENCY_HOLD_MS);
  }, [busyEmergency]);

  const cancelEmergencyHold = useCallback(() => {
    if (emergencyTimerRef.current !== null) {
      window.clearTimeout(emergencyTimerRef.current);
      emergencyTimerRef.current = null;
    }
    setEmergencyArming(false);
  }, []);

  async function fireEmergency() {
    const unit = user?.unitId?.trim() || user?.username?.trim() || "WEB";
    setBusyEmergency(true);
    try {
      const targetActive = !emergencyActive;
      await api.radioEmergency({
        unitId: unit.toUpperCase(),
        channel: selectedChannel,
        active: targetActive,
        displayName: user?.displayName ?? null,
        message: targetActive ? "Emergency activated from radio portal" : null,
      });
      setEmergencyActive(targetActive);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyEmergency(false);
    }
  }

  // --- transmission playback ---
  async function playTransmission(id: number) {
    try {
      const blob = await fetchTransmissionAudio(id);
      const url = URL.createObjectURL(blob);
      const audio = audioElRef.current ?? new Audio();
      audioElRef.current = audio;
      audio.onended = () => {
        setPlayingTxId(null);
        URL.revokeObjectURL(url);
      };
      audio.src = url;
      setPlayingTxId(id);
      await audio.play();
    } catch (err) {
      setError(describeError(err));
      setPlayingTxId(null);
    }
  }

  // --- scan picker handlers ---
  function toggleScanChannel(name: string) {
    setScanList((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  const channelStatus = useMemo(() => {
    if (!selectedChannel) return "Pick a channel to start";
    if (voiceState === "connecting") return "Connecting…";
    if (voiceState === "error") return voiceError ?? "Voice error";
    if (voiceState === "closed") return "Disconnected";
    if (transmitting) return "TRANSMITTING";
    if (receiving) return "RECEIVING";
    if (scanActiveChannel) return `SCAN RX · ${scanActiveChannel}`;
    if (emergencyActive) return "EMERGENCY ACTIVE";
    return permission === "listen_only" ? "Listen-only on this channel" : "Clear";
  }, [
    selectedChannel,
    voiceState,
    voiceError,
    transmitting,
    receiving,
    scanActiveChannel,
    emergencyActive,
    permission,
  ]);

  const canTransmit = voiceState === "listening" && permission !== "listen_only";

  return (
    <div className="rp-shell">
      <Topbar section="radio" />
      <main className="rp-body">
        {error && <div className="banner error">{error}</div>}

        {/* Channel picker */}
        <section className="rp-section">
          <div className="rp-section-head">
            <h2>Channels</h2>
            {selectedChannel && (
              <span className="rp-pill">{selectedChannel}</span>
            )}
          </div>
          {channels.length === 0 ? (
            <div className="empty">No channels assigned. Ask an admin for access.</div>
          ) : (
            <div className="rp-channel-grid">
              {channels.map((c) => {
                const active = c.name === selectedChannel;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={active ? "rp-channel active" : "rp-channel"}
                    onClick={() => joinChannel(c.name)}
                  >
                    <span className="rp-channel-name">{c.name}</span>
                    {c.permission === "listen_only" && (
                      <span className="rp-channel-tag">listen only</span>
                    )}
                    {c.simulcast && (
                      <span className="rp-channel-tag">simulcast</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Channel status + big PTT */}
        <section
          className={
            transmitting
              ? "rp-status rp-status-tx"
              : receiving || scanActiveChannel
                ? "rp-status rp-status-rx"
                : "rp-status"
          }
        >
          <div className="rp-status-line">{channelStatus}</div>
          <button
            type="button"
            className={`rp-ptt ${transmitting ? "tx" : ""} ${!canTransmit ? "disabled" : ""}`}
            disabled={!canTransmit}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              void startPtt();
            }}
            onPointerUp={() => stopPtt()}
            onPointerCancel={() => stopPtt()}
            onPointerLeave={() => stopPtt()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {transmitting ? "ON AIR" : canTransmit ? "HOLD TO TALK" : "PTT"}
          </button>
          <button
            type="button"
            className={`rp-emergency ${emergencyActive ? "active" : ""} ${emergencyArming ? "arming" : ""}`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              beginEmergencyHold();
            }}
            onPointerUp={() => cancelEmergencyHold()}
            onPointerCancel={() => cancelEmergencyHold()}
            onPointerLeave={() => cancelEmergencyHold()}
            disabled={busyEmergency || !selectedChannel}
          >
            {emergencyActive
              ? "Tap-hold to CLEAR emergency"
              : emergencyArming
                ? "Keep holding…"
                : "Hold for EMERGENCY"}
          </button>
        </section>

        {/* Channel roster */}
        <section className="rp-section">
          <div className="rp-section-head">
            <h2>On this channel</h2>
            <span className="count">{roster.length}</span>
          </div>
          {selectedChannel == null ? (
            <div className="empty">Pick a channel to see who's online.</div>
          ) : roster.length === 0 ? (
            <div className="empty">No one else here.</div>
          ) : (
            <ul className="rp-roster">
              {roster.map((m) => (
                <li key={`${m.unit_id}-${m.kind}`}>
                  <strong>{m.unit_id}</strong>
                  {m.display_name && <span className="rp-name"> · {m.display_name}</span>}
                  <span className="muted"> · {m.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Scan */}
        <section className="rp-section">
          <div className="rp-section-head">
            <h2>Scan</h2>
            <label className="rp-toggle">
              <input
                type="checkbox"
                checked={scanEnabled}
                onChange={(e) => setScanEnabled(e.target.checked)}
              />
              <span>{scanEnabled ? "ON" : "OFF"}</span>
            </label>
          </div>
          <div className="rp-scan-summary">
            <span>
              {scanList.size === 0
                ? "No channels selected"
                : `${scanList.size} channel${scanList.size === 1 ? "" : "s"} on scan list`}
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={() => setScanPickerOpen((v) => !v)}
            >
              {scanPickerOpen ? "Done" : "Configure list"}
            </button>
          </div>
          {scanPickerOpen && (
            <div className="rp-scan-picker">
              {channels.length === 0 ? (
                <div className="empty">No channels available.</div>
              ) : (
                channels
                  .filter((c) => c.name !== selectedChannel)
                  .map((c) => (
                    <label key={c.id} className="rp-scan-row">
                      <input
                        type="checkbox"
                        checked={scanList.has(c.name)}
                        onChange={() => toggleScanChannel(c.name)}
                      />
                      <span>{c.name}</span>
                    </label>
                  ))
              )}
            </div>
          )}
        </section>

        {/* Recent transmissions */}
        <section className="rp-section">
          <div className="rp-section-head">
            <h2>Recent transmissions</h2>
            <span className="count">{transmissions.length}</span>
          </div>
          {selectedChannel == null ? (
            <div className="empty">Pick a channel to see recent traffic.</div>
          ) : transmissions.length === 0 ? (
            <div className="empty">No recorded transmissions yet.</div>
          ) : (
            <ul className="rp-tx-list">
              {transmissions.map((tx) => {
                const transcript = transcriptOf(tx);
                const speaker = tx.display_name || aliasFor(tx.unit_id) || "Unknown";
                const isPlaying = playingTxId === tx.id;
                return (
                  <li key={tx.id} className="rp-tx-row">
                    <div className="rp-tx-head">
                      <span className="rp-tx-speaker">{speaker}</span>
                      <span className="rp-tx-channel">{tx.channel_name}</span>
                    </div>
                    <div className="rp-tx-meta">
                      {formatTime(tx.started_at)} · {formatDuration(tx.duration_ms)}
                    </div>
                    <div className={transcript.muted ? "rp-tx-transcript muted" : "rp-tx-transcript"}>
                      {transcript.text}
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void playTransmission(tx.id)}
                      disabled={isPlaying}
                    >
                      {isPlaying ? "Playing…" : "Play"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rp-section">
          <div className="rp-section-head">
            <h2>Session</h2>
          </div>
          <div className="rp-session">
            <div>
              <strong>{user?.displayName ?? user?.username ?? "—"}</strong>
              {user?.unitId && <span className="muted"> · {user.unitId}</span>}
            </div>
            <button type="button" className="btn sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
