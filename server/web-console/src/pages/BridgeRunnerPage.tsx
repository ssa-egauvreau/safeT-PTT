import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type Bridge } from "../api";
import { Topbar } from "../Topbar";
import { BridgeMeter } from "./BridgeMeter";
import { BridgeRunnerClient, type BridgeRunState } from "../voice/bridgeRunner";

/** Picks a sensible default input device — one whose label matches the hint. */
function defaultInput(devices: MediaDeviceInfo[], hint: string | null): string {
  if (hint) {
    const needle = hint.trim().toLowerCase();
    const match = devices.find((d) => d.label.toLowerCase().includes(needle));
    if (match) {
      return match.deviceId;
    }
  }
  return devices[0]?.deviceId ?? "";
}

/** One runnable audio-device bridge: device selection, start/stop, live status. */
function BridgeRunnerRow({
  bridge,
  inputs,
  outputs,
}: {
  bridge: Bridge;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}) {
  const bidirectional = bridge.direction === "bidirectional";
  const [inputId, setInputId] = useState(() => defaultInput(inputs, bridge.device_hint));
  const [outputId, setOutputId] = useState(() => outputs[0]?.deviceId ?? "");
  const [runState, setRunState] = useState<BridgeRunState>("idle");
  const [keyed, setKeyed] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [level, setLevel] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const runnerRef = useRef<BridgeRunnerClient | null>(null);

  // A running bridge must be torn down if the operator navigates away.
  useEffect(() => {
    return () => runnerRef.current?.stop();
  }, []);

  const running = runState === "connecting" || runState === "running";

  function start() {
    if (running || !inputId) {
      return;
    }
    setDetail(null);
    setKeyed(false);
    setReceiving(false);
    setLevel(0);
    const runner = new BridgeRunnerClient(
      {
        bridgeId: bridge.id,
        bidirectional,
        voxThreshold: bridge.vox_threshold,
        voxHangMs: bridge.vox_hang_ms,
        inputDeviceId: inputId,
        outputDeviceId: bidirectional ? outputId || null : null,
      },
      {
        onState: (state, d) => {
          setRunState(state);
          setDetail(d ?? null);
          if (state === "closed" || state === "error") {
            setKeyed(false);
            setReceiving(false);
            setLevel(0);
            runnerRef.current = null;
          }
        },
        onKeyed: setKeyed,
        onReceiving: setReceiving,
        onLevel: setLevel,
      },
    );
    runnerRef.current = runner;
    void runner.start();
  }

  function stop() {
    runnerRef.current?.stop();
    runnerRef.current = null;
    setLevel(0);
  }

  let status = "Idle";
  let statusClass = "pill off";
  if (runState === "connecting") {
    status = "Starting…";
    statusClass = "pill";
  } else if (runState === "running") {
    status = keyed ? "On air" : receiving ? "Receiving" : "Clear";
    statusClass = keyed ? "pill on" : "pill";
  } else if (runState === "error") {
    status = "Error";
    statusClass = "pill off";
  } else if (runState === "closed") {
    status = "Stopped";
    statusClass = "pill off";
  }

  return (
    <div className="card">
      <div className="panel-head">
        <h3>{bridge.name}</h3>
        <span className={statusClass}>{status}</span>
      </div>
      <p className="panel-desc">
        Keys <strong>{bridge.target_channel}</strong> · {bidirectional ? "Bidirectional" : "Inbound only"} ·{" "}
        {bridge.yield_to_units ? "yields to real units" : "holds the channel"} · VOX{" "}
        {bridge.vox_threshold} / {bridge.vox_hang_ms} ms
      </p>
      <div className="form-row">
        <div className="field">
          <label>Input device (line-in)</label>
          <select value={inputId} onChange={(e) => setInputId(e.target.value)} disabled={running}>
            {inputs.length === 0 && <option value="">No input devices found</option>}
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </div>
        {bidirectional && (
          <div className="field">
            <label>Output device (line-out)</label>
            <select value={outputId} onChange={(e) => setOutputId(e.target.value)} disabled={running}>
              {outputs.length === 0 && <option value="">System default</option>}
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="bridge-meter-row">
        <span className="bridge-meter-caption">Input level</span>
        <BridgeMeter
          level={level}
          threshold={bridge.vox_threshold}
          keyed={keyed}
          active={running}
        />
      </div>
      <div className="sim-channels" style={{ marginTop: 4 }}>
        {running ? (
          <button className="btn sm danger" onClick={stop}>
            Stop bridge
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={!inputId}>
            Start bridge
          </button>
        )}
        {detail && <span className="muted">{detail}</span>}
      </div>
    </div>
  );
}

/** Operator page for running audio-device bridges from this machine. */
export function BridgeRunnerPage() {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDevices = useCallback(async () => {
    try {
      // A getUserMedia grant is what unlocks device labels for enumeration.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      /* permission denied — devices still list, just without labels */
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((d) => d.kind === "audioinput"));
      setOutputs(devices.filter((d) => d.kind === "audiooutput"));
    } catch {
      /* enumeration unavailable */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setBridges((await api.listRunnableBridges()).bridges);
      } catch (err) {
        setError(describeError(err));
      }
      await loadDevices();
      setLoading(false);
    })();
  }, [loadDevices]);

  return (
    <div className="app-shell">
      <Topbar section="bridges" />
      <div className="admin-body">
        <main className="panel">
          <div className="panel-head">
            <h2>Radio bridge runner</h2>
            <span className="count">{bridges.length}</span>
          </div>
          <p className="panel-desc">
            Run an agency audio-device bridge from this machine — capture a line-in feed from an
            external radio or scanner, VOX-gate it, and key it onto a channel. Bidirectional bridges
            also play the channel back out to a chosen output device. Bridges and their VOX settings
            are configured by an admin under Control → Radio Bridges.
          </p>

          {error && <div className="banner error">{error}</div>}

          {loading ? (
            <div className="empty">Loading…</div>
          ) : bridges.length === 0 ? (
            <div className="empty">
              No enabled audio-device bridges. An admin can add one under Control → Radio Bridges.
            </div>
          ) : (
            bridges.map((bridge) => (
              <BridgeRunnerRow key={bridge.id} bridge={bridge} inputs={inputs} outputs={outputs} />
            ))
          )}
        </main>
      </div>
    </div>
  );
}
