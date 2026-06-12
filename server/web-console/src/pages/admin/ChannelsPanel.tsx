import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  describeError,
  VOICE_CODECS,
  VOICE_CODEC_LABEL,
  type Channel,
  type VoiceCodec,
  type Zone,
} from "../../api";

export function ChannelsPanel() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [defaultCodec, setDefaultCodec] = useState<VoiceCodec | null>(null);
  const [zoneNumber, setZoneNumber] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [zoneCreating, setZoneCreating] = useState(false);

  async function reload() {
    try {
      const [chRes, zoneRes, agRes] = await Promise.all([
        api.listChannels(),
        api.listZones().catch(() => ({ zones: [] as Zone[] })),
        api.getAdminAgency().catch(() => null),
      ]);
      setChannels(chRes.channels);
      setZones(zoneRes.zones);
      if (agRes) {
        setDefaultCodec(agRes.agency.defaultCodec);
      }
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function changeDefaultCodec(next: VoiceCodec) {
    if (next === defaultCodec) return;
    setError(null);
    const prior = defaultCodec;
    setDefaultCodec(next); // optimistic — falls back to prior on error
    try {
      await api.setAgencyDefaultCodec(next);
    } catch (err) {
      setDefaultCodec(prior);
      setError(describeError(err));
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await api.createChannel(name.trim());
      setName("");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  async function patch(channel: Channel, change: Parameters<typeof api.updateChannel>[1]) {
    setError(null);
    try {
      await api.updateChannel(channel.id, change);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  function rename(channel: Channel) {
    const next = window.prompt("Channel name", channel.name);
    if (next != null && next.trim() && next.trim() !== channel.name) {
      void patch(channel, { name: next.trim() });
    }
  }

  async function remove(channel: Channel) {
    if (!window.confirm(`Delete channel "${channel.name}"? Assignments to it are removed too.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteChannel(channel.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function onCreateZone(event: FormEvent) {
    event.preventDefault();
    const num = Number(zoneNumber);
    if (!Number.isInteger(num) || num < 1 || !zoneName.trim()) {
      return;
    }
    setZoneCreating(true);
    setError(null);
    try {
      await api.createZone(num, zoneName.trim());
      setZoneNumber("");
      setZoneName("");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setZoneCreating(false);
    }
  }

  function renameZone(zone: Zone) {
    const next = window.prompt(`Zone ${zone.zone_number} description`, zone.name);
    if (next != null && next.trim() && next.trim() !== zone.name) {
      void (async () => {
        setError(null);
        try {
          await api.updateZone(zone.id, { name: next.trim() });
          await reload();
        } catch (err) {
          setError(describeError(err));
        }
      })();
    }
  }

  function renumberZone(zone: Zone) {
    const next = window.prompt(`Zone number for "${zone.name}"`, String(zone.zone_number));
    const num = next == null ? NaN : Number(next.trim());
    if (Number.isInteger(num) && num >= 1 && num !== zone.zone_number) {
      void (async () => {
        setError(null);
        try {
          await api.updateZone(zone.id, { zone_number: num });
          await reload();
        } catch (err) {
          setError(describeError(err));
        }
      })();
    }
  }

  async function removeZone(zone: Zone) {
    const members = channels.filter((c) => c.zone_id === zone.id).length;
    if (
      !window.confirm(
        `Delete zone ${zone.zone_number} "${zone.name}"?` +
          (members ? ` ${members} channel(s) become unzoned.` : ""),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.deleteZone(zone.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Channels</h2>
        <span className="count">{channels.length} total</span>
      </div>
      <p className="panel-desc">
        Channels radios and the console can tune. Group channels into numbered <strong>zones</strong> below —
        radios cycle one zone at a time and show the zone number in front of the channel name
        (zone 1's "Green 1" displays as <code className="mono">1 GREEN 1</code>).
      </p>

      {error && <div className="banner error">{error}</div>}

      <form className="card" onSubmit={onCreateZone}>
        <h3>Zones</h3>
        {zones.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Zone</th>
                <th>Description</th>
                <th>Channels</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr key={zone.id}>
                  <td>
                    <code className="mono">{zone.zone_number}</code>
                  </td>
                  <td>{zone.name}</td>
                  <td>{channels.filter((c) => c.zone_id === zone.id).length}</td>
                  <td>
                    <div className="cell-actions">
                      <button type="button" className="btn sm" onClick={() => renumberZone(zone)}>
                        Renumber
                      </button>
                      <button type="button" className="btn sm" onClick={() => renameZone(zone)}>
                        Rename
                      </button>
                      <button type="button" className="btn sm danger" onClick={() => void removeZone(zone)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form-row">
          <div className="field">
            <label>Zone number</label>
            <input
              type="number"
              min={1}
              max={999}
              value={zoneNumber}
              onChange={(e) => setZoneNumber(e.target.value)}
              placeholder="1"
              required
            />
          </div>
          <div className="field">
            <label>Description</label>
            <input
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              placeholder="e.g. Patrol"
              required
            />
          </div>
          <button className="btn primary" type="submit" disabled={zoneCreating}>
            {zoneCreating ? "Adding…" : "Add zone"}
          </button>
        </div>
      </form>

      <form className="card" onSubmit={onCreate}>
        <h3>Add channel</h3>
        <div className="form-row">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Green 4" required />
          </div>
          <div className="field">
            <label>Default codec for new channels</label>
            <select
              value={defaultCodec ?? "imbe"}
              disabled={defaultCodec === null}
              onChange={(e) => void changeDefaultCodec(e.target.value as VoiceCodec)}
              title="Applied to channels created from this page. Existing channels keep their per-channel codec — change those individually in the table below."
            >
              {VOICE_CODECS.map((c) => (
                <option key={c} value={c}>
                  {VOICE_CODEC_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit" disabled={creating}>
            {creating ? "Adding…" : "Add channel"}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="empty">No channels yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Color</th>
              <th>Zone</th>
              <th>Codec</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td>
                  <code className="mono">{channel.id}</code>
                </td>
                <td>{channel.name}</td>
                <td>
                  <div className="cell-actions" style={{ justifyContent: "flex-start" }}>
                    <input
                      type="color"
                      className="color-input"
                      value={channel.color ?? "#888888"}
                      onChange={(e) => patch(channel, { color: e.target.value })}
                    />
                    {channel.color && (
                      <button className="btn sm" onClick={() => patch(channel, { color: null })}>
                        Clear
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <select
                    value={channel.zone_id ?? ""}
                    onChange={(e) => {
                      const next = e.target.value === "" ? null : Number(e.target.value);
                      if (next !== channel.zone_id) {
                        void patch(channel, { zone_id: next });
                      }
                    }}
                    title="Zone this channel belongs to. Radios scroll within one zone and show the zone number before the channel name."
                  >
                    <option value="">— no zone —</option>
                    {zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.zone_number} — {zone.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={channel.codec}
                    onChange={(e) => {
                      const next = e.target.value as VoiceCodec;
                      if (next !== channel.codec) {
                        void patch(channel, { codec: next });
                      }
                    }}
                    title="Voice codec used to transmit on this channel. Connected clients receive a codec_change push immediately."
                  >
                    {VOICE_CODECS.map((c) => (
                      <option key={c} value={c}>
                        {VOICE_CODEC_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="cell-actions">
                    <button className="btn sm" onClick={() => rename(channel)}>
                      Rename
                    </button>
                    <button className="btn sm danger" onClick={() => remove(channel)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
