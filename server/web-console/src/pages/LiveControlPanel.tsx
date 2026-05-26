import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type ChannelMember } from "../api";
import { useAuth } from "../auth";
import { useUnitAliasResolver } from "../unitAliases";
import { IconCar, IconClose, IconMobile, IconRadio, IconRecord } from "../icons";

/** Names produced by the emergency-channel endpoint always start with EMERGENCY. */
function isEmergencyChannelName(name: string): boolean {
  return /^emergency(\b|$)/i.test(name.trim());
}

function unitDeviceIcon(deviceType: string | null | undefined) {
  if (deviceType === "unit_radio") {
    return <IconCar size={11} />;
  }
  if (deviceType === "phone" || deviceType === "handheld") {
    return <IconMobile size={11} />;
  }
  return <IconMobile size={11} />;
}

const POLL_MS = 4000;

const MOVE_REASONS = [
  "Reassigned",
  "Emergency response",
  "Wrong channel",
  "Noise control",
  "Training",
  "Supervisor request",
  "Other",
] as const;

interface ChannelGroup {
  channel: string;
  members: ChannelMember[];
}

/** Compact live unit move board — embedded in Mission Control. */
export function LiveControlPanel() {
  const aliasFor = useUnitAliasResolver();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [rosters, setRosters] = useState<ChannelGroup[]>([]);
  const [channelsList, setChannelsList] = useState<{ id: number; name: string }[]>([]);
  const [reason, setReason] = useState<(typeof MOVE_REASONS)[number]>("Reassigned");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  async function refreshChannels(): Promise<{ id: number; name: string }[] | null> {
    try {
      const res = await api.myChannels();
      const next = res.channels.filter((c) => !c.simulcast).map((c) => ({ id: c.id, name: c.name }));
      setChannelsList(next);
      return next;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    void refreshChannels();
  }, []);

  const allChannels = useMemo(() => channelsList.map((c) => c.name), [channelsList]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.channelRosters();
        if (!cancelled) {
          setRosters(res.channels);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load live channel state.");
        }
      }
    }
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const channels = useMemo(() => {
    const map = new Map<string, ChannelMember[]>();
    for (const name of allChannels) {
      map.set(name, []);
    }
    for (const group of rosters) {
      map.set(group.channel, group.members);
    }
    return [...map.entries()]
      .map(([channel, members]) => ({ channel, members }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }, [allChannels, rosters]);

  const unitChannel = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of channels) {
      for (const m of group.members) {
        map.set(m.unit_id, group.channel);
      }
    }
    return map;
  }, [channels]);

  function toggleSelected(unitId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) {
        next.delete(unitId);
      } else {
        next.add(unitId);
      }
      return next;
    });
  }

  function memberByUnit(unitId: string): ChannelMember | undefined {
    for (const group of channels) {
      const hit = group.members.find((m) => m.unit_id === unitId);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  async function moveMany(units: string[], toChannel: string) {
    const locked = units.filter((u) => memberByUnit(u)?.move_locked);
    if (locked.length > 0) {
      setError(
        locked.length === 1
          ? `${aliasFor(locked[0]!)} has the dispatch console open on multiple channels and cannot be moved.`
          : "One or more selected operators have the dispatch console open and cannot be moved.",
      );
      return;
    }
    const moves = units.filter((u) => unitChannel.get(u) !== toChannel);
    if (moves.length === 0) {
      return;
    }
    setStatus(null);
    setError(null);
    try {
      const results = await Promise.all(
        moves.map((unitId) =>
          api.moveUnit({ unitId, fromChannel: unitChannel.get(unitId) ?? null, toChannel, reason }),
        ),
      );
      const reached = results.filter((r) => r.reached > 0).length;
      setStatus(
        moves.length === 1
          ? results[0]!.reached > 0
            ? `Moved ${aliasFor(moves[0]!)} to ${toChannel}.`
            : `${aliasFor(moves[0]!)} isn't connected — move not delivered.`
          : `Moved ${reached}/${moves.length} units to ${toChannel}.`,
      );
      setSelected(new Set());
      const fresh = await api.channelRosters();
      setRosters(fresh.channels);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.message === "unit_move_locked") {
        setError("That operator has the dispatch console open on multiple channels and cannot be moved.");
      } else {
        setError("Could not complete the move.");
      }
    }
  }

  async function createEmergencyChannel() {
    const units = [...selected];
    if (units.length === 0) {
      return;
    }
    const name = window.prompt(
      "Name the emergency channel:",
      `EMERGENCY ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    );
    if (name === null) {
      return;
    }
    setStatus(null);
    setError(null);
    try {
      const res = await api.createEmergencyChannel({ name: name.trim() || undefined, unitIds: units });
      setStatus(`Emergency channel "${res.channel}" — ${res.reached}/${units.length} units moved in.`);
      setSelected(new Set());
      await refreshChannels();
      const fresh = await api.channelRosters();
      setRosters(fresh.channels);
    } catch {
      setError("Could not create the emergency channel.");
    }
  }

  async function deleteEmergencyChannel(channelName: string) {
    const latest = await refreshChannels();
    if (!latest) {
      setError("Could not verify channel list. Please try again.");
      return;
    }
    const channel = latest.find((c) => c.name === channelName);
    if (!channel) {
      setError(`Channel "${channelName}" was renamed or already removed.`);
      return;
    }
    if (!isEmergencyChannelName(channel.name)) {
      setError(`"${channel.name}" is not currently an emergency channel.`);
      return;
    }
    if (!window.confirm(`Delete emergency channel "${channel.name}"? This cannot be undone.`)) {
      return;
    }
    setStatus(null);
    setError(null);
    try {
      await api.deleteChannel(channel.id);
      setStatus(`Deleted emergency channel "${channel.name}".`);
      await refreshChannels();
      const fresh = await api.channelRosters();
      setRosters(fresh.channels);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Only admins can delete channels.");
      } else {
        setError(`Could not delete "${channelName}".`);
      }
    }
  }

  return (
    <div className={`live-control-embed${collapsed ? " collapsed" : ""}`}>
      <div className="live-control-embed-head">
        <button
          type="button"
          className="live-control-embed-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <IconRecord size={14} />
          {collapsed ? "▸" : "▾"} Live unit control
        </button>
        <label className="lcc-reason compact">
          Move reason
          <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {MOVE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!collapsed && (
        <>
          <p className="lcc-hint compact">
            Drag units between channels · dispatch console operators on multiple channels cannot be
            moved · moves are audit-logged
          </p>

          {selected.size > 0 && (
            <div className="lcc-selbar compact">
              <span>{selected.size} selected</span>
              <button className="btn sm danger" onClick={() => void createEmergencyChannel()}>
                Emergency channel
              </button>
              <button className="btn sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}

          {error && <div className="banner error compact">{error}</div>}
          {status && <div className="banner info compact">{status}</div>}

          <div className="lcc-grid compact">
            {channels.map((group) => (
              <section
                key={group.channel}
                className={`lcc-channel compact${dragOver === group.channel ? " drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(group.channel);
                }}
                onDragLeave={() => setDragOver((c) => (c === group.channel ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const unit = e.dataTransfer.getData("text/unit");
                  if (!unit) {
                    return;
                  }
                  const units = selected.has(unit) ? [...selected] : [unit];
                  void moveMany(units, group.channel);
                }}
              >
                <div className="lcc-channel-head">
                  <IconRadio size={12} />
                  <span className="lcc-channel-name">{group.channel}</span>
                  <span className="count">{group.members.length}</span>
                  {isAdmin && isEmergencyChannelName(group.channel) && (
                    <button
                      type="button"
                      className="lcc-channel-delete"
                      title="Delete this emergency channel"
                      aria-label={`Delete emergency channel ${group.channel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteEmergencyChannel(group.channel);
                      }}
                    >
                      <IconClose size={11} />
                    </button>
                  )}
                </div>
                {group.members.length === 0 ? (
                  <div className="lcc-empty">Drop unit</div>
                ) : (
                  group.members.map((m) => (
                    <div
                      key={`${m.unit_id}-${m.kind}`}
                      className={`lcc-unit${selected.has(m.unit_id) ? " selected" : ""}${
                        m.move_locked ? " locked" : ""
                      }`}
                      draggable={!m.move_locked}
                      onClick={() => toggleSelected(m.unit_id)}
                      onDragStart={(e) => {
                        if (m.move_locked) {
                          e.preventDefault();
                          return;
                        }
                        e.dataTransfer.setData("text/unit", m.unit_id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      title={
                        m.move_locked
                          ? "Dispatch console — connected on multiple channels"
                          : "Click to select · drag to move"
                      }
                    >
                      {unitDeviceIcon(m.device_type)}
                      <span className="lcc-unit-name">{m.display_name || aliasFor(m.unit_id)}</span>
                    </div>
                  ))
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
