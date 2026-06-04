import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, type Bridge, type BridgeInput, type BridgeStatus } from "../../api";
import { BridgeMeter } from "../BridgeMeter";
import { RadioRefImport } from "./RadioRefImport";

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
          <p className="field-hint">A label for this bridge, shown here and in the runner.</p>
        </div>
        <div className="field">
          <label>Source</label>
          <select value={f.sourceType} onChange={(e) => set("sourceType", e.target.value)}>
            <option value="stream_url">Stream URL</option>
            <option value="audio_device">Line-in / audio device</option>
          </select>
          <p className="field-hint">
            Where the audio comes from: an online stream, or hardware wired into a bridge PC.
          </p>
        </div>
        {f.sourceType === "stream_url" ? (
          <div className="field">
            <label>Stream URL</label>
            <input
              value={f.sourceUrl ?? ""}
              onChange={(e) => set("sourceUrl", e.target.value)}
              placeholder="https://stream.example.com:8000/feed.mp3"
            />
            <p className="field-hint">
              The <strong>direct audio-stream address</strong> — an Icecast / Shoutcast HTTP(S)
              feed (MP3 or AAC) or an HLS <code>.m3u8</code> playlist. Use the raw stream link, not
              a Broadcastify listen page or a web page with an embedded player.
            </p>
          </div>
        ) : (
          <div className="field">
            <label>Device hint</label>
            <input
              value={f.deviceHint ?? ""}
              onChange={(e) => set("deviceHint", e.target.value)}
              placeholder="e.g. USB audio in"
            />
            <p className="field-hint">
              Part of the input device's name. The Bridge Runner pre-selects the first match — the
              operator still picks the exact device there.
            </p>
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
          <p className="field-hint">The channel or simulcast this bridge keys its audio onto.</p>
        </div>
        {f.sourceType === "audio_device" && (
          <div className="field">
            <label>Direction</label>
            <select value={f.direction} onChange={(e) => set("direction", e.target.value)}>
              <option value="inbound">Inbound only</option>
              <option value="bidirectional">Bidirectional</option>
            </select>
            <p className="field-hint">
              Inbound feeds audio onto the channel. Bidirectional also plays channel traffic back
              out to the wired radio.
            </p>
          </div>
        )}
        <div className="field">
          <label>TX mode</label>
          <select value={f.txMode} onChange={(e) => set("txMode", e.target.value)}>
            <option value="passthrough">Pass-through (no re-vocoding)</option>
            <option value="vocoder">Vocoder (IMBE)</option>
          </select>
          <p className="field-hint">
            Pass-through forwards audio unchanged. Vocoder re-encodes it through IMBE for
            P25-style radios.
          </p>
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
          <p className="field-hint">
            How loud audio must be to open the gate. Lower catches quiet audio; higher ignores
            hiss. Watch the meter to tune it.
          </p>
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
          <p className="field-hint">
            How long the gate stays open after audio stops, so word endings aren't clipped.
          </p>
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
      <p className="field-hint">
        <strong>Yield to real units</strong> drops the bridge off the air whenever a live radio
        keys the channel, so it never talks over a unit. <strong>Enabled</strong> turns the bridge
        on — stream bridges start within seconds; line-in bridges must also be started from the
        Run bridges tab.
      </p>
    </form>
  );
}

/** Admin panel for configuring radio bridges (Settings tab or Bridges → Configure). */
export function BridgesPanel({ embedded = false }: { embedded?: boolean }) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [statuses, setStatuses] = useState<Record<number, BridgeStatus>>({});
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

  // Poll live ingest levels so each bridge's audio meter stays current.
  useEffect(() => {
    if (bridges.length === 0) {
      return;
    }
    let cancelled = false;
    function poll() {
      api
        .bridgeStatuses()
        .then((res) => {
          if (!cancelled) {
            const next: Record<number, BridgeStatus> = {};
            res.statuses.forEach((s) => {
              next[s.id] = s;
            });
            setStatuses(next);
          }
        })
        .catch(() => undefined);
    }
    poll();
    const timer = window.setInterval(poll, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridges.length]);

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
    <div className={embedded ? "bridges-settings-embed" : undefined}>
      <div className="panel-head">
        <h2>{embedded ? "Configure radio bridges" : "Radio bridges"}</h2>
        <span className="count">{bridges.length}</span>
      </div>
      <p className="panel-desc">
        A radio bridge feeds an outside audio source onto one of your channels — a public scanner
        stream, or a base radio / scanner wired into a bridge PC&apos;s line-in. Line-in bridges are
        started from the <strong>Run bridges</strong> tab on this page.
      </p>

      <div className="bridge-help">
        <strong>Setting one up</strong>
        <ol>
          <li>
            Pick a <em>Source</em> — a stream URL, or a line-in / audio device on a bridge PC.
          </li>
          <li>
            Choose the <em>Target channel</em> the audio should key onto.
          </li>
          <li>
            Set the <em>VOX</em> gate (below), tick <em>Enabled</em>, and Save.
          </li>
          <li>
            Stream bridges start on the server automatically. Line-in bridges are started by an
            operator on the <em>Run bridges</em> tab, which also selects the exact audio device.
          </li>
        </ol>
        <strong>VOX gate</strong>
        <p>
          VOX (voice-operated switch) keys the channel only while it hears audio, so silence on the
          source never holds the channel open.
        </p>
        <ul>
          <li>
            <em>Threshold (0–1)</em> — how loud audio must be to open the gate. Too low and hiss
            keys the channel; too high and quiet speech is missed. 0.02 suits a clean line; raise
            it for a noisy feed.
          </li>
          <li>
            <em>Hang (ms)</em> — how long the gate stays keyed after audio stops, so the ends of
            words aren't clipped. 1000–2000&nbsp;ms is typical.
          </li>
        </ul>
        <p>
          Each bridge below has an input meter — the bar is the live audio level and the marked
          line is the VOX threshold. Audio that reaches past the line is loud enough to key the
          channel.
        </p>
      </div>

      {error && <div className="banner error">{error}</div>}

      <RadioRefImport
        channelNames={channelNames}
        bridgeNames={bridges.map((b) => b.name)}
        onDone={() => void reload()}
      />

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
        bridges.map((bridge) => {
          const status = statuses[bridge.id];
          return (
            <div key={bridge.id}>
              <div className="panel-head">
                <h3>{bridge.name}</h3>
                <span className={bridge.enabled ? "pill on" : "pill off"}>
                  {bridge.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {bridge.source_type === "audio_device" ? (
                <p className="field-hint bridge-status-note">
                  Line-in bridge — watch its live input meter on the <strong>Run bridges</strong> tab
                  while it runs.
                </p>
              ) : (
                <BridgeMeter
                  level={status?.level ?? 0}
                  threshold={bridge.vox_threshold}
                  keyed={status?.keyed ?? false}
                  active={status?.running ?? false}
                />
              )}
              <BridgeForm
                initial={toInput(bridge)}
                busy={busy}
                channelNames={channelNames}
                simulcastNames={simulcastNames}
                onSubmit={(input) => void run(() => api.updateBridge(bridge.id, input))}
                onDelete={() => remove(bridge)}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
