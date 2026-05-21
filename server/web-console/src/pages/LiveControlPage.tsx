import { useEffect, useMemo, useState } from "react";
import { Topbar } from "../Topbar";
import { api, type ChannelMember } from "../api";
import { useUnitAliasResolver } from "../unitAliases";
import { IconRadio, IconUser } from "../icons";

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

/**
 * Live Channel Control — a control-room view of every channel and the units on
 * it. Drag a unit onto another channel to live-move them (the unit's radio
 * retunes and shows a "you were moved" banner). Admin/dispatcher only.
 */
export function LiveControlPage() {
  const aliasFor = useUnitAliasResolver();
  const [rosters, setRosters] = useState<ChannelGroup[]>([]);
  const [allChannels, setAllChannels] = useState<string[]>([]);
  const [reason, setReason] = useState<(typeof MOVE_REASONS)[number]>("Reassigned");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .myChannels()
      .then((res) => setAllChannels(res.channels.map((c) => c.name)))
      .catch(() => undefined);
  }, []);

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

  // Every channel to show as a drop target: assigned channels plus any that
  // currently have members (deduped, sorted).
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

  // unit_id -> the channel it's currently on (for bulk moves across channels).
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

  async function moveMany(units: string[], toChannel: string) {
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
    } catch {
      setError("Could not complete the move.");
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
      setAllChannels((prev) => (prev.includes(res.channel) ? prev : [...prev, res.channel]));
      const fresh = await api.channelRosters();
      setRosters(fresh.channels);
    } catch {
      setError("Could not create the emergency channel.");
    }
  }

  return (
    <div className="app-shell">
      <Topbar section="console" />
      <div className="lcc">
        <div className="lcc-head">
          <h1>Live Channel Control</h1>
          <label className="lcc-reason">
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

        <p className="lcc-hint">
          Click units to select several, then drag any one onto a channel to move them together.
          Moved units retune and see a &ldquo;you were moved&rdquo; banner; every move is audit-logged.
        </p>

        {selected.size > 0 && (
          <div className="lcc-selbar">
            <span>{selected.size} selected</span>
            <button className="btn sm danger" onClick={() => void createEmergencyChannel()}>
              Create emergency channel
            </button>
            <button className="btn sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        )}

        {error && <div className="banner error">{error}</div>}
        {status && <div className="banner info">{status}</div>}

        <div className="lcc-grid">
          {channels.map((group) => (
            <section
              key={group.channel}
              className={`lcc-channel${dragOver === group.channel ? " drag-over" : ""}`}
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
                // Dragging a selected unit moves the whole selection; otherwise just it.
                const units = selected.has(unit) ? [...selected] : [unit];
                void moveMany(units, group.channel);
              }}
            >
              <div className="lcc-channel-head">
                <IconRadio size={14} />
                <span className="lcc-channel-name">{group.channel}</span>
                <span className="count">{group.members.length}</span>
              </div>
              {group.members.length === 0 ? (
                <div className="lcc-empty">Drop a unit here</div>
              ) : (
                group.members.map((m) => (
                  <div
                    key={`${m.unit_id}-${m.kind}`}
                    className={`lcc-unit${selected.has(m.unit_id) ? " selected" : ""}`}
                    draggable
                    onClick={() => toggleSelected(m.unit_id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/unit", m.unit_id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    title="Click to select · drag to another channel to move"
                  >
                    <IconUser size={13} />
                    <span className="lcc-unit-name">{m.display_name || aliasFor(m.unit_id)}</span>
                    {m.kind === "legacy" && <span className="roster-tag">radio</span>}
                  </div>
                ))
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
