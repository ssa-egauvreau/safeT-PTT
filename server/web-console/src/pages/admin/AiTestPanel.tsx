import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  describeError,
  type AiDispatchTestResult,
  type UserChannel,
} from "../../api";

const SAMPLE_TRANSCRIPTS: { label: string; text: string }[] = [
  { label: "9-61 with plate inline", text: "352 961 at 18-06 California 8 Victor Whiskey Victor 6 2 1" },
  { label: "9-61, no plate yet", text: "352 961 at 18-06" },
  { label: "Plate-only follow-up", text: "California 8 Victor Whiskey Victor 6 2 1" },
  { label: "Out with subject on existing call", text: "352 I'll be out with the property manager" },
  { label: "Pending calls request", text: "Hey dispatch, 334. Anything pending for me?" },
  { label: "10-20 on a unit", text: "27-000, 10-20 on 352" },
  { label: "Code 4 / clear", text: "352 code 4 advised" },
  { label: "Radio check", text: "27-010, radio check" },
];

const SAMPLE_UNITS = ["352", "351", "334", "231", "151", "27-000", "27-010", "STATION27"];

export function AiTestPanel() {
  const [transcript, setTranscript] = useState(SAMPLE_TRANSCRIPTS[0]!.text);
  const [channelName, setChannelName] = useState<string>("");
  const [unitId, setUnitId] = useState("352");
  const [sendForReal, setSendForReal] = useState(false);
  const [synthesizeTts, setSynthesizeTts] = useState(true);
  const [confirmingSendForReal, setConfirmingSendForReal] = useState(false);
  const [channels, setChannels] = useState<UserChannel[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiDispatchTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .myChannels()
      .then((res) => {
        if (cancelled) return;
        const real = res.channels.filter((c) => !c.simulcast);
        setChannels(real);
        if (real.length > 0 && !channelName) {
          setChannelName(real[0]!.name);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTest() {
    setError(null);
    setRunning(true);
    setResult(null);
    try {
      const res = await api.testAiDispatch({
        transcript: transcript.trim(),
        channelName: channelName.trim() || "test-channel",
        unitId: unitId.trim() || "352",
        sendForReal,
        synthesizeTts,
      });
      setResult(res);
      if (synthesizeTts && res.ttsMp3Base64) {
        // Auto-play the dispatcher response.
        setTimeout(() => {
          audioRef.current?.play().catch(() => undefined);
        }, 50);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRunning(false);
    }
  }

  function toggleSendForReal() {
    if (sendForReal) {
      setSendForReal(false);
      setConfirmingSendForReal(false);
      return;
    }
    if (!confirmingSendForReal) {
      setConfirmingSendForReal(true);
      return;
    }
    setSendForReal(true);
    setConfirmingSendForReal(false);
  }

  const audioSrc = useMemo(() => {
    if (!result?.ttsMp3Base64) return null;
    return `data:audio/mpeg;base64,${result.ttsMp3Base64}`;
  }, [result?.ttsMp3Base64]);

  return (
    <div className="ai-test-panel">
      <header className="ai-test-header">
        <h2>AI Dispatcher Test Console</h2>
        <p className="muted">
          Type a transcript as if it came in over the radio. The page runs the full pipeline
          — system prompt, knowledge-base retrieval, plate lookup, 10-8 body building, and TTS —
          and shows you exactly what the dispatcher would do. Nothing is posted to 10-8 unless
          you switch on <b>SEND FOR REAL</b>.
        </p>
      </header>

      <section className="ai-test-form">
        <label>
          <span>Transcript</span>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={3}
            placeholder='e.g. "352 961 at 18-06 California 8 Victor Whiskey Victor 6 2 1"'
          />
        </label>

        <div className="ai-test-samples">
          {SAMPLE_TRANSCRIPTS.map((s) => (
            <button
              type="button"
              key={s.label}
              className="ai-test-sample"
              onClick={() => setTranscript(s.text)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="ai-test-meta">
          <label>
            <span>Channel</span>
            <select value={channelName} onChange={(e) => setChannelName(e.target.value)}>
              {channels.length === 0 && <option value="">(no channels)</option>}
              {channels.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                  {c.ai_dispatch_enabled ? " · AI ON" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Unit ID</span>
            <input
              type="text"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              list="ai-test-units"
              maxLength={16}
            />
            <datalist id="ai-test-units">
              {SAMPLE_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </label>
          <label className="ai-test-toggle">
            <input
              type="checkbox"
              checked={synthesizeTts}
              onChange={(e) => setSynthesizeTts(e.target.checked)}
            />
            <span>Synthesize voice (preview only)</span>
          </label>
          <label className={"ai-test-toggle" + (sendForReal ? " danger" : "")}>
            <input
              type="checkbox"
              checked={sendForReal}
              onChange={toggleSendForReal}
            />
            <span>
              {sendForReal
                ? "SEND FOR REAL (writes to 10-8)"
                : confirmingSendForReal
                  ? "Click again to confirm — will write to 10-8"
                  : "Send for real (10-8 writes)"}
            </span>
          </label>
        </div>

        <div className="ai-test-run">
          <button
            type="button"
            className={"ai-test-run-btn" + (sendForReal ? " danger" : "")}
            onClick={runTest}
            disabled={running || !transcript.trim()}
          >
            {running ? "Running…" : sendForReal ? "Run + Post to 10-8" : "Run (dry)"}
          </button>
          {error && <span className="ai-test-error">{error}</span>}
        </div>
      </section>

      {result && (
        <section className="ai-test-result">
          <div className="ai-test-summary-row">
            <span className="ai-test-pill">
              intent: <b>{result.parsed?.intent ?? "?"}</b>
            </span>
            {result.parsed?.code && (
              <span className="ai-test-pill">code: {result.parsed.code}</span>
            )}
            {result.parsed?.unit && (
              <span className="ai-test-pill">unit: {result.parsed.unit}</span>
            )}
            {result.parsed?.location_code && (
              <span className="ai-test-pill">
                loc: {result.parsed.location_code}
                {result.parsed.location_name ? ` (${result.parsed.location_name})` : ""}
              </span>
            )}
            <span className="ai-test-pill">total: {result.durationMs}ms</span>
            {!result.channelAiDispatchEnabled && (
              <span className="ai-test-pill warn">channel AI dispatch is OFF</span>
            )}
            {!result.ten8Configured && (
              <span className="ai-test-pill warn">10-8 not configured</span>
            )}
          </div>

          {result.errors.length > 0 && (
            <div className="ai-test-section error">
              <h3>Errors</h3>
              <ul>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="ai-test-section">
            <h3>Dispatcher reply</h3>
            {result.dispatcherReply ? (
              <>
                <blockquote className="ai-test-quote">{result.dispatcherReply}</blockquote>
                <div className="ai-test-meta-line">
                  TTS kind: <code>{result.ttsKind}</code>
                  {!result.ttsMp3Base64 && synthesizeTts && (
                    <span className="ai-test-mute"> · no audio (check ElevenLabs key)</span>
                  )}
                </div>
                {audioSrc && (
                  <audio ref={audioRef} controls src={audioSrc} className="ai-test-audio" />
                )}
              </>
            ) : (
              <p className="muted">
                The model returned no text and there is no deterministic ack for this intent —
                the dispatcher would stay silent on the radio.
              </p>
            )}
          </div>

          <details className="ai-test-section" open>
            <summary>
              <h3 style={{ display: "inline" }}>Parsed JSON</h3>
            </summary>
            <pre className="ai-test-json">{JSON.stringify(result.parsed, null, 2)}</pre>
          </details>

          <details className="ai-test-section" open>
            <summary>
              <h3 style={{ display: "inline" }}>10-8 actions</h3>
            </summary>
            {Object.keys(result.ten8Actions).length === 0 ? (
              <p className="muted">No 10-8 actions for this transmission.</p>
            ) : (
              <pre className="ai-test-json">{JSON.stringify(result.ten8Actions, null, 2)}</pre>
            )}
          </details>

          {result.plateLookup && (
            <details className="ai-test-section" open>
              <summary>
                <h3 style={{ display: "inline" }}>Plate lookup</h3>
              </summary>
              <pre className="ai-test-json">{JSON.stringify(result.plateLookup, null, 2)}</pre>
            </details>
          )}

          <details className="ai-test-section">
            <summary>
              <h3 style={{ display: "inline" }}>
                Knowledge base context ({result.knowledgeContextChars} chars)
              </h3>
            </summary>
            {result.knowledgeContextPreview ? (
              <pre className="ai-test-json">{result.knowledgeContextPreview}</pre>
            ) : (
              <p className="muted">
                Knowledge base returned no matching chunks (or the embedding model is cold —
                next call will be warm).
              </p>
            )}
          </details>

          <details className="ai-test-section">
            <summary>
              <h3 style={{ display: "inline" }}>Timing trace</h3>
            </summary>
            <table className="ai-test-trace">
              <thead>
                <tr>
                  <th>phase</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {result.trace.map((t, i) => (
                  <tr key={i}>
                    <td>{t.phase}</td>
                    <td>{t.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}
    </div>
  );
}
