import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type Bridge } from "../api";
import { useAuth } from "../auth";
import { Topbar } from "../Topbar";
import { BridgesPanel } from "./admin/BridgesPanel";
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

const BRIDGE_RECONNECT_DELAY_MS = 3000;

interface StoredDeviceSelection {
  input?: string;
  output?: string;
}

function storedSelectionKey(bridgeId: number): string {
  return `safetPtt.bridgeRunner.devices.${bridgeId}`;
}

function readStoredSelection(bridgeId: number): StoredDeviceSelection | null {
  try {
    const raw = localStorage.getItem(storedSelectionKey(bridgeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDeviceSelection;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredSelection(bridgeId: number, sel: StoredDeviceSelection): void {
  try {
    localStorage.setItem(storedSelectionKey(bridgeId), JSON.stringify(sel));
  } catch {
    /* private mode or quota */
  }
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
  const [inputId, setInputId] = useState(() => {
    const stored = readStoredSelection(bridge.id)?.input;
    if (stored && inputs.some((d) => d.deviceId === stored)) {
      return stored;
    }
    return defaultInput(inputs, bridge.device_hint);
  });
  const [outputId, setOutputId] = useState(() => {
    const stored = readStoredSelection(bridge.id)?.output;
    if (stored && outputs.some((d) => d.deviceId === stored)) {
      return stored;
    }
    return outputs[0]?.deviceId ?? "";
  });
  const [runState, setRunState] = useState<BridgeRunState>("idle");
  const [keyed, setKeyed] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [level, setLevel] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const runnerRef = useRef<BridgeRunnerClient | null>(null);
  const wantRunningRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      clearReconnectTimer();
      wantRunningRef.current = false;
      runnerRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    writeStoredSelection(bridge.id, { input: inputId, output: outputId });
  }, [bridge.id, inputId, outputId]);

  const running = runState === "connecting" || runState === "running" || reconnecting;

  function start() {
    if (!inputId) return;
    if (runState === "connecting" || runState === "running") return;
    setDetail(null);
    setKeyed(false);
    setReceiving(false);
    setLevel(0);
    setReconnecting(false);
    clearReconnectTimer();
    wantRunningRef.current = true;
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
            if (state === "closed" && wantRunningRef.current) {
              setReconnecting(true);
              clearReconnectTimer();
              reconnectTimerRef.current = window.setTimeout(() => {
                reconnectTimerRef.current = null;
                if (wantRunningRef.current) {
                  setReconnecting(false);
                  start();
                }
              }, BRIDGE_RECONNECT_DELAY_MS);
            } else if (state === "error") {
              wantRunningRef.current = false;
              setReconnecting(false);
            }
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
    wantRunningRef.current = false;
    clearReconnectTimer();
    setReconnecting(false);
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
  } else if (reconnecting) {
    status = "Reconnecting…";
    statusClass = "pill";
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

function BridgeRunnerSection() {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDevices = useCallback(async () => {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      /* permission denied */
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
    <>
      <div className="panel-head">
        <h2>Run line-in bridges</h2>
        <span className="count">{bridges.length}</span>
      </div>
      <p className="panel-desc">
        Start an audio-device bridge from this computer — capture a line-in from an external radio or
        scanner, VOX-gate it, and key it onto a channel. Bidirectional bridges also play channel audio
        back out to a chosen output device. Stream bridges and VOX settings are configured on the{" "}
        <strong>Configure bridges</strong> tab (admins).
      </p>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : bridges.length === 0 ? (
        <div className="empty">
          No enabled line-in bridges. An admin can add one under <strong>Configure bridges</strong>.
        </div>
      ) : (
        bridges.map((bridge) => (
          <BridgeRunnerRow key={bridge.id} bridge={bridge} inputs={inputs} outputs={outputs} />
        ))
      )}
    </>
  );
}

type BridgesView = "runner" | "settings";

/** Radio bridges — run line-in bridges and (for admins) configure all bridge types. */
export function BridgesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState<BridgesView>("runner");

  useEffect(() => {
    if (!isAdmin && view === "settings") {
      setView("runner");
    }
  }, [isAdmin, view]);

  return (
    <div className="app-shell">
      <Topbar section="bridges" />
      <div className="admin-body">
        <aside className="tabs bridges-page-tabs">
          <button
            type="button"
            className={view === "runner" ? "tab active" : "tab"}
            onClick={() => setView("runner")}
          >
            Run bridges
          </button>
          {isAdmin && (
            <button
              type="button"
              className={view === "settings" ? "tab active" : "tab"}
              onClick={() => setView("settings")}
            >
              Configure bridges
            </button>
          )}
        </aside>
        <main className="panel">
          {view === "runner" && <BridgeRunnerSection />}
          {view === "settings" && isAdmin && <BridgesPanel embedded />}
        </main>
      </div>
    </div>
  );
}
