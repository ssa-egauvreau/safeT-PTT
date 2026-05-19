import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type Bridge, type BridgeInput } from "../../api";

function emptyInput(): BridgeInput {
  return {
    name: "",
    sourceType: "stream_url",
    sourceUrl: "",
    deviceHint: "",
    targetChannel: "",
    direction: "inbound",
    yieldToUnits: true,
    txMode: "passthrough",
    voxThreshold: 0.02,
    voxHangMs: 1500,
    enabled: false,
  };
}

function toInput(b: Bridge): BridgeInput {
  return {
    name: b.name,
    sourceType: b.source_type,
    sourceUrl: b.source_url ?? "",
    deviceHint: b.device_hint ?? "",
    targetChannel: b.target_channel,
    direction: b.direction,
    yieldToUnits: b.yield_to_units,
    txMode: b.tx_mode,
    voxThreshold: b.vox_threshold,
    voxHangMs: b.vox_hang_ms,
    enabled: b.enabled,
  };
}

/** Field set for one bridge — used for both creating and editing. Remounted (via key) per bridge. */
function BridgeForm({
  initial,
  busy,
  channelNames,
  simulcastNames,
  onSubmit,
  onDelete,
}: {
  initial: BridgeInput;
  busy: boolean;
  channelNames: string[];
  simulcastNames: string[];
  onSubmit: (input: BridgeInput) => void;
  onDelete?: () => void;
}) {
  const [f, setF] = useState<BridgeInput>(initial);
  const set = <K extends keyof BridgeInput>(key: K, value: BridgeInput[K]) =>
    setF((prev) => ({ ...prev, [key]: value }));

  // A bridge saved against a since-renamed channel must still show its target.
  const known = new Set([...channelNames, ...simulcastNames]);
  const orphanTarget = f.targetChannel.trim() && !known.has(f.targetChannel.trim());

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      ...f,
      name: f.name.trim(),
      targetChannel: f.targetChannel.trim(),
      sourceUrl: f.sourceType === "stream_url" ? (f.sourceUrl ?? "").trim() || null : null,
      deviceHint: f.sourceType === "audio_device" ? (f.deviceHint ?? "").trim() || null : null,
      // A stream URL is a listen-only feed — it can never be bidirectional.
      direction: f.sourceType === "stream_url" ? "inbound" : f.direction,
    });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label>Name</label>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} required />
        </div>
        <div className="field">
          <label>Source</label>
          <select value={f.sourceType} onChange={(e) => set("sourceType", e.target.value)}>
            <option value="stream_url">Stream URL</option>
            <option value="audio_device">Line-in / audio device</option>
          </select>
        </div>
        {f.sourceType === "stream_url" ? (
          <div className="field">
            <label>Stream URL</label>
            <input
              value={f.sourceUrl ?? ""}
              onChange={(e) => set("sourceUrl", e.target.value)}
              placeholder="https://… (Broadcastify / ProScan / icecast)"
            />
          </div>
        ) : (
          <div className="field">
            <label>Device hint</label>
            <input
              value={f.deviceHint ?? ""}
              onChange={(e) => set("deviceHint", e.target.value)}
              placeholder="e.g. USB audio in"
            />
          </div>
        )}
        <div className="field">
          <label>Target channel</label>
          <select
            value={f.targetChannel}
            onChange={(e) => set("targetChannel", e.target.value)}
            required
          >
            <option value="" disabled>
              Select a channel…
            </option>
            {channelNames.length > 0 && (
              <optgroup label="Channels">
                {channelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
            {simulcastNames.length > 0 && (
              <optgroup label="Simulcast">
                {simulcastNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
            {orphanTarget && (
              <option value={f.targetChannel}>{f.targetChannel} (not found)</option>
            )}
          </select>
        </div>
        {f.sourceType === "audio_device" && (
          <div className="field">
            <label>Direction</label>
            <select value={f.direction} onChange={(e) => set("direction", e.target.value)}>
              <option value="inbound">Inbound only</option>
              <option value="bidirectional">Bidirectional</option>
            </select>
          </div>
        )}
        <div className="field">
          <label>TX mode</label>
          <select value={f.txMode} onChange={(e) => set("txMode", e.target.value)}>
            <option value="passthrough">Pass-through (no re-vocoding)</option>
            <option value="vocoder">Vocoder (IMBE)</option>
          </select>
        </div>
        <div className="field">
          <label>VOX threshold (0–1)</label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={f.voxThreshold}
            onChange={(e) => set("voxThreshold", Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>VOX hang (ms)</label>
          <input
            type="number"
            min={100}
            max={10000}
            step={100}
            value={f.voxHangMs}
            onChange={(e) => set("voxHangMs", Number(e.target.value))}
          />
        </div>
      </div>
      <div className="sim-channels" style={{ marginTop: 4 }}>
        <label>
          <input
            type="checkbox"
            checked={f.yieldToUnits}
            onChange={(e) => set("yieldToUnits", e.target.checked)}
          />
          Yield to real units
        </label>
        <label>
          <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Enabled
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : onDelete ? "Save" : "Create bridge"}
        </button>
        {onDelete && (
          <button type="button" className="btn sm danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

/** Admin panel for configuring radio bridges. */
export function BridgesPanel() {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [channelNames, setChannelNames] = useState<string[]>([]);
  const [simulcastNames, setSimulcastNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createKey, setCreateKey] = useState(0);

  async function reload() {
    try {
      setBridges((await api.listBridges()).bridges);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // Channels and simulcasts populate the target-channel dropdown; a failed
    // simulcast fetch must not block the rest of the panel.
    void (async () => {
      const [chans, sims] = await Promise.allSettled([
        api.listChannels(),
        api.listSimulcasts(),
      ]);
      if (chans.status === "fulfilled") {
        setChannelNames(chans.value.channels.map((c) => c.name));
      }
      if (sims.status === "fulfilled") {
        setSimulcastNames(sims.value.simulcasts.map((s) => s.name));
      }
    })();
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function create(input: BridgeInput) {
    void run(async () => {
      await api.createBridge(input);
      setCreateKey((k) => k + 1);
    });
  }

  function remove(bridge: Bridge) {
    if (window.confirm(`Delete bridge "${bridge.name}"?`)) {
      void run(() => api.deleteBridge(bridge.id));
    }
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Radio bridges</h2>
        <span className="count">{bridges.length}</span>
      </div>
      <p className="panel-desc">
        Link an external audio source — a scanner stream URL (Broadcastify, ProScan) or a line-in /
        audio device — onto a channel. Bridges are <strong>VOX-gated</strong>: they only key the
        channel when there is audio, and (when set to yield) any real unit pre-empts them. An enabled
        stream-URL bridge begins ingesting within seconds; audio-device bridges run from the desktop
        console on the bridge host.
      </p>

      {error && <div className="banner error">{error}</div>}

      <h3>New bridge</h3>
      <BridgeForm
        key={createKey}
        initial={emptyInput()}
        busy={busy}
        channelNames={channelNames}
        simulcastNames={simulcastNames}
        onSubmit={create}
      />

      {loading ? (
        <div className="empty">Loading…</div>
      ) : bridges.length === 0 ? (
        <div className="empty">No bridges configured.</div>
      ) : (
        bridges.map((bridge) => (
          <div key={bridge.id}>
            <div className="panel-head">
              <h3>{bridge.name}</h3>
              <span className={bridge.enabled ? "pill on" : "pill off"}>
                {bridge.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <BridgeForm
              initial={toInput(bridge)}
              busy={busy}
              channelNames={channelNames}
              simulcastNames={simulcastNames}
              onSubmit={(input) => void run(() => api.updateBridge(bridge.id, input))}
              onDelete={() => remove(bridge)}
            />
          </div>
        ))
      )}
    </div>
  );
}
