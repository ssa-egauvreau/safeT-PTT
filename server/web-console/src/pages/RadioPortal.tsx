import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  describeError,
  type ChannelMember,
  type Permission,
  type UserChannel,
} from "../api";
import { LatestChannelTransmission } from "../components/LatestChannelTransmission";
import { useAuth } from "../auth";
import { Topbar } from "../Topbar";
import { VoiceChannelClient, type VoiceState } from "../voice/voiceClient";
import { AudioLevelMeter } from "../voice/AudioLevelMeter";
import { ScanListenClient } from "../voice/scanListenClient";
import { bindLostLinkBusyAlerts, sounds } from "../sounds";
import { ClientPlatformBadge, PresenceStatusBadge } from "../components/RosterBadges";

const ROSTER_POLL_MS = 5_000;
const EMERGENCY_HOLD_MS = 1500;
/** Quiet pause between a voice-WS close and the next reconnect attempt. */
const VOICE_RECONNECT_DELAY_MS = 3000;

/**
 * Mobile-friendly portal for `radio`-role accounts. Renders the same channels / PTT / scan
 * surface a handset has, in a single scrollable column suitable for a phone browser. Reuses the
 * dispatch console's voice plumbing (VoiceChannelClient) so PTT / RX audio is identical.
 */
export function RadioPortal() {
  const { user, logout } = useAuth();
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [permission, setPermission] = useState<Permission>("listen_only");
  const [receiving, setReceiving] = useState(false);
  const [transmitting, setTransmitting] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [movedNotice, setMovedNotice] = useState<{ channel: string; by: string | null } | null>(null);

  const [scanEnabled, setScanEnabled] = useState(false);
  const [scanList, setScanList] = useState<Set<string>>(new Set());
  const [scanActiveChannels, setScanActiveChannels] = useState<ReadonlySet<string>>(() => new Set());
  // Derived: which channel name (if any) to put on the banner. The latched channel is the most
  // recently added one — preserves the prior "show the channel that just lit up" UX without
  // dropping the banner when an OTHER channel goes idle.
  const [scanLatchedChannel, setScanLatchedChannel] = useState<string | null>(null);
  const scanActiveChannel = scanActiveChannels.size > 0
    ? (scanLatchedChannel && scanActiveChannels.has(scanLatchedChannel)
        ? scanLatchedChannel
        : scanActiveChannels.values().next().value ?? null)
    : null;
  const [scanPickerOpen, setScanPickerOpen] = useState(false);

  const [roster, setRoster] = useState<ChannelMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [emergencyActive, setEmergencyActive] = useState(false);
  const [emergencyArming, setEmergencyArming] = useState(false);
  const [busyEmergency, setBusyEmergency] = useState(false);
  const voiceRef = useRef<VoiceChannelClient | null>(null);
  const scanRef = useRef<ScanListenClient | null>(null);
  const emergencyTimerRef = useRef<number | null>(null);
  /*
   * Want-to-stay-connected flag: separates "user picked a new channel" / "user signed out" (no
   * reconnect) from "the WS dropped out from under us" (try to reconnect). Held in a ref so the
   * long-lived onState callback always sees the current value without re-binding.
   */
  const wantConnectedRef = useRef(false);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const [voiceReconnecting, setVoiceReconnecting] = useState(false);
  // PTT held flag — referenced both by startPtt and by the onBusy callback registered with the
  // voice client, so it has to live above joinChannel so the joinChannel closure can read it.
  const pttHeldRef = useRef(false);

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

  // --- hydrate emergency state from the server on mount ---
  // emergencyActive is a local toggle, but the server-side alert is the source of truth: it
  // persists across reloads and other devices. Without this hydration step, a page reload while
  // this unit already has an active emergency would leave emergencyActive=false locally and the
  // next EMER hold would POST active=true again — creating a duplicate alert instead of clearing.
  useEffect(() => {
    const unit = (user?.unitId?.trim() || user?.username?.trim() || "").toUpperCase();
    if (!unit) return;
    let cancelled = false;
    api
      .alerts()
      .then((res) => {
        if (cancelled) return;
        const mine = res.alerts.some(
          (a) =>
            a.active &&
            a.kind?.toLowerCase() === "emergency" &&
            (a.from_unit ?? "").toUpperCase() === unit,
        );
        if (mine) setEmergencyActive(true);
      })
      .catch(() => {
        /* leave local state at false; the user can still re-trigger if needed */
      });
    return () => {
      cancelled = true;
    };
  }, [user?.unitId, user?.username]);

  function clearVoiceReconnectTimer() {
    if (voiceReconnectTimerRef.current !== null) {
      window.clearTimeout(voiceReconnectTimerRef.current);
      voiceReconnectTimerRef.current = null;
    }
  }

  // --- main voice client (created on first channel pick, recreated on channel change) ---
  const joinChannel = useCallback((channelName: string) => {
    // Tear down any previous client before connecting the new one so we never have two open.
    voiceRef.current?.close();
    voiceRef.current = null;
    clearVoiceReconnectTimer();
    setVoiceReconnecting(false);
    setVoiceState("connecting");
    setVoiceError(null);
    setReceiving(false);
    setTransmitting(false);
    setPermission("listen_only");
    wantConnectedRef.current = true;

    const client = new VoiceChannelClient(channelName, {
      onState: (state, detail) => {
        setVoiceState(state);
        if (state === "error" && detail) setVoiceError(detail);
        if (state === "transmitting") setTransmitting(true);
        if (state === "listening") setTransmitting(false);
        if (state === "closed" || state === "error") {
          setTransmitting(false);
          setReceiving(false);
        }
        /*
         * Auto-reconnect on a server-driven close (Railway redeploy, transient network blip)
         * so the operator doesn't have to re-tap the channel button. Errors don't retry —
         * those usually mean a config or permission issue (not_a_member, channel_lookup_failed)
         * that another attempt won't fix.
         */
        if (state === "closed" && wantConnectedRef.current) {
          setVoiceReconnecting(true);
          clearVoiceReconnectTimer();
          voiceReconnectTimerRef.current = window.setTimeout(() => {
            voiceReconnectTimerRef.current = null;
            if (wantConnectedRef.current) {
              setVoiceReconnecting(false);
              joinChannel(channelName);
            }
          }, VOICE_RECONNECT_DELAY_MS);
        } else if (state === "error") {
          wantConnectedRef.current = false;
          setVoiceReconnecting(false);
        }
      },
      onPermission: (p) => setPermission(p),
      onReceiving: (r) => setReceiving(r),
      onMove: (toChannel, by) => {
        setMovedNotice({ channel: toChannel, by });
        sounds.channelSwitch();
        joinChannel(toChannel);
      },
      onBusy: () => {
        // The relay rejected our key — already handled inside the client (stopTransmit), just
        // make sure local UI reflects that we're not transmitting. Loop the busy tone for as
        // long as the operator is still holding the PTT button (matches ChannelPanel).
        setTransmitting(false);
        if (pttHeldRef.current) {
          sounds.busyLoopStart();
        }
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

  // Auto-dismiss the "you were moved" banner after a few seconds.
  useEffect(() => {
    if (!movedNotice) {
      return;
    }
    const timer = window.setTimeout(() => setMovedNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [movedNotice]);

  // Warm the audio cache and start auto-refresh of agency-custom tones so PTT permit / busy /
  // emergency / channel-switch play the agency's uploads when present, falling back to bundled
  // defaults otherwise. The agency-custom set follows admin uploads without a manual reload.
  useEffect(() => {
    sounds.preload();
    const stop = sounds.startAutoRefresh();
    const stopLostLink = bindLostLinkBusyAlerts();
    return () => {
      stop();
      stopLostLink();
      sounds.stopAll();
    };
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      wantConnectedRef.current = false;
      clearVoiceReconnectTimer();
      voiceRef.current?.close();
      voiceRef.current = null;
      scanRef.current?.closeAll();
      scanRef.current = null;
      if (emergencyTimerRef.current !== null) {
        window.clearTimeout(emergencyTimerRef.current);
      }
      sounds.busyLoopStop();
    };
  }, []);

  // --- scan listen reconciliation ---
  useEffect(() => {
    if (!scanRef.current) {
      scanRef.current = new ScanListenClient(selectedChannel ?? "", {
        // Track the FULL set of currently-receiving scan channels — not just the latest. If
        // channels A and B both light up and B subsequently goes idle, the banner should still
        // show "SCAN RX · A" instead of clearing entirely (A never emits a fresh receiving=true
        // edge to re-latch it).
        onChannelActivity: (channel, receivingNow) => {
          setScanActiveChannels((current) => {
            const next = new Set(current);
            if (receivingNow) next.add(channel);
            else next.delete(channel);
            return next;
          });
          if (receivingNow) setScanLatchedChannel(channel);
        },
      });
    }
    scanRef.current.setScanList(Array.from(scanList));
    scanRef.current.setEnabled(scanEnabled);
    if (!scanEnabled) {
      setScanActiveChannels(new Set());
      setScanLatchedChannel(null);
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

  const scanWatchList = useMemo(() => {
    if (!scanEnabled || !selectedChannel) return "";
    return Array.from(scanList)
      .filter((c) => c !== selectedChannel)
      .join(",");
  }, [scanEnabled, scanList, selectedChannel]);

  const voiceConnected =
    voiceState === "listening" || voiceState === "transmitting";

  // --- PTT handlers ---
  // The same client.startTransmit / stopTransmit gestures dispatch uses; we wire them to a big
  // hold-to-talk button instead of a hardware key.
  // pttHeldRef lets us race-cancel: if the user releases the button before startTransmit()
  // finishes (e.g. while the browser is still prompting for mic permission), VoiceChannelClient
  // would otherwise enter transmit AFTER release and leave the channel keyed indefinitely.
  // We check the flag immediately after the await and stop right away if it's already false.
  // (pttHeldRef is declared above joinChannel so the onBusy callback can read it.)
  const startPtt = useCallback(async () => {
    const client = voiceRef.current;
    if (!client) return;
    pttHeldRef.current = true;
    try {
      await client.startTransmit();
      sounds.permit();
      // Two race-cancel cases after the await:
      //   1. The user released the button before startTransmit() resolved (typical: mic
      //      permission prompt held the await). pttHeldRef is already false → drop the TX.
      //   2. The user switched channels (or the component started teardown) while we were
      //      waiting. voiceRef now points at a NEW client; the original one would otherwise
      //      transmit on the OLD channel and emit late state transitions that stomp on the
      //      new channel's UI. stopTransmit() on the captured client undoes the just-started
      //      transmission; the new client is never touched.
      if (client !== voiceRef.current) {
        client.stopTransmit();
        return;
      }
      if (!pttHeldRef.current) {
        client.stopTransmit();
      }
    } catch (err) {
      // pttHeldRef must be read BEFORE we set it to false so the busy-loop guard sees the
      // operator's actual held state at the time the relay rejected the TX. Without that gate
      // a slow rejection arriving after the user already released would start the busy loop
      // with nothing to stop it.
      const stillHeld = pttHeldRef.current;
      pttHeldRef.current = false;
      const code = err instanceof Error ? err.message : "transmit_failed";
      if (code === "channel_busy" && stillHeld) {
        // Loop the busy tone for as long as the operator keeps holding the key, matching
        // the ChannelPanel busy-key behavior. stopPtt clears the loop on release.
        sounds.busyLoopStart();
      }
      // Don't surface this error on the new channel's UI if we're already on a different
      // client — the user has moved on.
      if (client !== voiceRef.current) return;
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
    pttHeldRef.current = false;
    voiceRef.current?.stopTransmit();
    sounds.busyLoopStop();
  }, []);

  // --- emergency long-press ---
  // The setTimeout below outlives a render, so it cannot capture `fireEmergency` by closure —
  // a mid-hold channel switch or emergency-state flip would otherwise activate against stale
  // values. Keep a ref to the latest fireEmergency and resolve it inside the timer callback.
  const fireEmergencyRef = useRef<() => void>(() => {});
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
      if (targetActive) {
        // Local audible cue that the emergency went live — matches the radio's behavior. We
        // intentionally don't play it on clear; clear is silent on the dispatch side too.
        sounds.emergency();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyEmergency(false);
    }
  }
  // Refresh on every render so the timer always invokes the freshest fireEmergency.
  useEffect(() => {
    fireEmergencyRef.current = fireEmergency;
  });

  const beginEmergencyHold = useCallback(() => {
    if (busyEmergency) return;
    // When already active, clearing is a single tap — no hold required. A short hold would
    // otherwise be canceled by any finger drift or the user releasing too soon, which is the
    // bug operators kept hitting (button stuck in EMERGENCY ACTIVE). The asymmetry is
    // deliberate: triggering an emergency must be intentional (1.5 s hold), but clearing it
    // shouldn't require a steady finger — if it clears by accident it's trivially re-armed.
    if (emergencyActive) {
      fireEmergencyRef.current();
      return;
    }
    setEmergencyArming(true);
    if (emergencyTimerRef.current !== null) {
      window.clearTimeout(emergencyTimerRef.current);
    }
    emergencyTimerRef.current = window.setTimeout(() => {
      emergencyTimerRef.current = null;
      setEmergencyArming(false);
      fireEmergencyRef.current();
    }, EMERGENCY_HOLD_MS);
  }, [busyEmergency, emergencyActive]);

  const cancelEmergencyHold = useCallback(() => {
    if (emergencyTimerRef.current !== null) {
      window.clearTimeout(emergencyTimerRef.current);
      emergencyTimerRef.current = null;
    }
    setEmergencyArming(false);
  }, []);

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
    if (voiceReconnecting) return "Reconnecting…";
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
    voiceReconnecting,
    transmitting,
    receiving,
    scanActiveChannels,
    scanLatchedChannel,
    emergencyActive,
    permission,
  ]);

  // Stay enabled while transmitting too — otherwise the button flips to disabled the moment we
  // start TX, and some browsers don't fire pointerup/pointercancel on disabled controls, which
  // would leave stopPtt() uncalled and the channel keyed.
  const canTransmit =
    (voiceState === "listening" || voiceState === "transmitting") &&
    permission !== "listen_only";

  return (
    <div className="rp-shell">
      <Topbar section="radio" />
      <main className="rp-body">
        {error && <div className="banner error">{error}</div>}

        {movedNotice && (
          <div className="rp-moved-banner" role="status">
            <strong>You were moved</strong>
            <span>
              {movedNotice.by ? `${movedNotice.by} moved you to ` : "Moved to "}
              <b>{movedNotice.channel}</b>.
            </span>
            <button className="rp-moved-dismiss" onClick={() => setMovedNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

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
                    onClick={() => {
                      if (c.name !== selectedChannel) sounds.channelSwitch();
                      joinChannel(c.name);
                    }}
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
          <div className={`waveform-strip rp-waveform${transmitting ? " tx" : receiving ? " rx" : ""}`}>
            <AudioLevelMeter
              getLevel={() => voiceRef.current?.getLevel() ?? 0}
              active={transmitting || receiving}
              variant={transmitting ? "tx" : "rx"}
              className="audio-level-meter--strip"
            />
          </div>
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
            // Belt-and-braces: a regular click also clears the active emergency. Some browsers
            // route synthetic touch differently than pointer events; this keeps the clear path
            // working even if onPointerDown is swallowed (e.g. while a parent gesture is hot).
            onClick={() => {
              if (emergencyActive && !busyEmergency) fireEmergencyRef.current();
            }}
            // Activating still requires a channel selection (the alert is bound to one). Clearing
            // does not — clearing has to keep working even before the user picks a channel,
            // otherwise an alert that was hydrated from the server on mount would leave the
            // operator with no way to dismiss it.
            disabled={busyEmergency || (!selectedChannel && !emergencyActive)}
          >
            {emergencyActive
              ? "Tap to CLEAR emergency"
              : emergencyArming
                ? "Keep holding…"
                : "Hold for EMERGENCY"}
          </button>
        </section>

        <section className="rp-section">
          <div className="rp-section-head">
            <h2>On the air</h2>
          </div>
          <LatestChannelTransmission
            variant="radio"
            channelName={selectedChannel}
            active={!!selectedChannel && voiceConnected}
            homeReceiving={receiving}
            scanRxChannel={scanActiveChannel}
            scanWatchList={scanWatchList}
            localUnitId={user?.unitId ?? user?.username ?? null}
            logHint="Ask dispatch for the full transcript log if you need older messages."
          />
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
                  <span className="rp-roster-badges">
                    <PresenceStatusBadge status={m.status ?? "idle"} size={14} />
                    <ClientPlatformBadge client={m.client} size={13} />
                  </span>
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
