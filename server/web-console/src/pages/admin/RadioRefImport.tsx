import { useState, type ChangeEvent } from "react";
import { api, describeError } from "../../api";

/** One talkgroup in the working list. */
interface TalkRow {
  tgid: number;
  alpha: string;
  desc: string;
  tag: string;
}

const BASE_URL_KEY = "sdrStreamBaseUrl";

/** Split one delimited line (comma or tab), honoring "quoted, fields". */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        q = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      q = true;
    } else if (c === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a pasted talkgroup table: a RadioReference web-table copy (tab-separated),
 * a RadioReference CSV export, or a trunk-recorder talkgroups.csv. Delimiter is
 * auto-detected (tab vs comma). When a header row is present we map columns by
 * name (so column order doesn't matter); otherwise we assume the trunk-recorder
 * order: Decimal,Hex,Alpha Tag,Mode,Description,Tag.
 */
function parseTalkgroups(text: string): TalkRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const delim = lines[0].includes("\t") ? "\t" : ",";
  const first = splitLine(lines[0], delim).map((h) => h.toLowerCase());
  const hasHeader = first.some((h) =>
    ["decimal", "dec", "tgid", "alpha tag", "alpha", "hex", "mode"].includes(h),
  );

  // Column indices — trunk-recorder default order as the no-header fallback.
  let iDec = 0,
    iAlpha = 2,
    iDesc = 4,
    iTag = 5;
  if (hasHeader) {
    const find = (...names: string[]) => first.findIndex((h) => names.includes(h));
    iDec = find("decimal", "tgid", "dec");
    iAlpha = find("alpha tag", "alpha", "name");
    iDesc = find("description", "desc");
    iTag = find("tag");
  }

  const rows: TalkRow[] = [];
  const seen = new Set<number>();
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cols = splitLine(line, delim);
    const tgid = Number((cols[iDec] ?? "").replace(/[^\d]/g, ""));
    if (!Number.isInteger(tgid) || tgid <= 0 || seen.has(tgid)) continue;
    seen.add(tgid);
    rows.push({
      tgid,
      alpha: (cols[iAlpha] ?? "").trim() || `TG ${tgid}`,
      desc: (cols[iDesc] ?? "").trim(),
      tag: (cols[iTag] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * "Add scanner channels" — build a list of talkgroups (type them in, or paste a
 * RadioReference table), then create a SafeT channel + stream bridge for each in
 * one click.
 *
 * Each bridge's stream URL is `<base>/tg<TGID>`. That mount-naming convention is
 * what lets the PC-side launcher (sdr-bridge) auto-discover which talkgroups to
 * decode straight from the bridges created here — no second config to maintain.
 */
export function RadioRefImport({
  channelNames,
  bridgeNames,
  onDone,
}: {
  channelNames: string[];
  bridgeNames: string[];
  onDone: () => void;
}) {
  const [base, setBase] = useState(() => localStorage.getItem(BASE_URL_KEY) ?? "");
  const [rows, setRows] = useState<TalkRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [qId, setQId] = useState("");
  const [qName, setQName] = useState("");
  const [raw, setRaw] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  /** Add one hand-typed talkgroup. */
  function addManual() {
    const tgid = Number(qId.trim().replace(/[^\d]/g, ""));
    if (!Number.isInteger(tgid) || tgid <= 0) {
      setError("Enter a numeric talkgroup ID (the decimal TGID).");
      return;
    }
    if (rows.some((r) => r.tgid === tgid)) {
      setError(`TG ${tgid} is already in the list.`);
      return;
    }
    setError(null);
    setResult(null);
    const alpha = qName.trim() || `TG ${tgid}`;
    setRows((prev) => [...prev, { tgid, alpha, desc: "", tag: "" }]);
    setSelected((prev) => new Set(prev).add(tgid));
    setQId("");
    setQName("");
  }

  /** Merge a parsed batch (paste or file) into the working list. */
  function mergeRows(parsed: TalkRow[]) {
    if (parsed.length === 0) {
      setError(
        "Couldn't read any talkgroups. Paste the table including its header row " +
          "(it needs an 'Alpha Tag' and a Decimal/DEC column), or just type them in above.",
      );
      return;
    }
    setError(null);
    const have = new Set(rows.map((r) => r.tgid));
    const added = parsed.filter((r) => !have.has(r.tgid));
    setRows((prev) => [...prev, ...added]);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of parsed) next.add(r.tgid);
      return next;
    });
    setResult(`Added ${added.length} talkgroup${added.length === 1 ? "" : "s"} to the list.`);
    setRaw("");
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then((t) => mergeRows(parseTalkgroups(t)));
    e.target.value = "";
  }

  function removeRow(tgid: number) {
    setRows((prev) => prev.filter((r) => r.tgid !== tgid));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(tgid);
      return next;
    });
  }

  const shown = rows.filter((r) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      r.alpha.toLowerCase().includes(q) ||
      r.desc.toLowerCase().includes(q) ||
      r.tag.toLowerCase().includes(q) ||
      String(r.tgid).includes(q)
    );
  });

  function toggle(tgid: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tgid)) next.delete(tgid);
      else next.add(tgid);
      return next;
    });
  }

  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = shown.every((r) => next.has(r.tgid));
      for (const r of shown) {
        if (allOn) next.delete(r.tgid);
        else next.add(r.tgid);
      }
      return next;
    });
  }

  async function createSelected() {
    const cleanBase = base.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(cleanBase)) {
      setError("Enter the stream base URL first (your Icecast address, e.g. https://abc.trycloudflare.com).");
      return;
    }
    localStorage.setItem(BASE_URL_KEY, cleanBase);

    const picks = rows.filter((r) => selected.has(r.tgid));
    if (picks.length === 0) {
      setError("Add and tick at least one talkgroup.");
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    const existingChannels = new Set(channelNames);
    const existingBridges = new Set(bridgeNames);
    let createdCh = 0,
      createdBr = 0,
      skipped = 0;
    const failures: string[] = [];

    for (const r of picks) {
      const channelName = r.alpha;
      const mount = `tg${r.tgid}`;
      try {
        if (!existingChannels.has(channelName)) {
          try {
            await api.createChannel(channelName);
            existingChannels.add(channelName);
            createdCh++;
          } catch (err) {
            // A pre-existing channel of the same name is fine — keep going.
            if (describeError(err).toLowerCase().includes("duplicate")) {
              existingChannels.add(channelName);
            } else {
              throw err;
            }
          }
        }
        if (existingBridges.has(channelName)) {
          skipped++;
          continue;
        }
        await api.createBridge({
          name: channelName,
          sourceType: "stream_url",
          sourceUrl: `${cleanBase}/${mount}`,
          deviceHint: null,
          targetChannel: channelName,
          direction: "inbound",
          yieldToUnits: false,
          txMode: "passthrough",
          voxThreshold: 0.02,
          voxHangMs: 1500,
          enabled: true,
          noiseSuppression: "off",
        });
        existingBridges.add(channelName);
        createdBr++;
      } catch (err) {
        failures.push(`${channelName} (TG ${r.tgid}): ${describeError(err)}`);
      }
    }

    setBusy(false);
    setResult(
      `Created ${createdBr} bridge${createdBr === 1 ? "" : "s"} and ${createdCh} channel${
        createdCh === 1 ? "" : "s"
      }${skipped ? `, skipped ${skipped} already-bridged` : ""}.` +
        (failures.length ? ` ${failures.length} failed.` : ""),
    );
    if (failures.length) setError(failures.join("  •  "));
    onDone();
  }

  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.tgid));

  return (
    <details className="card" style={{ marginBottom: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Add scanner channels&nbsp;
        <span className="field-hint" style={{ fontWeight: 400 }}>
          — type in a talkgroup + name (or paste a RadioReference table), then create them all
        </span>
      </summary>

      <div style={{ marginTop: 12 }}>
        <div className="field">
          <label>Stream base URL</label>
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://your-icecast.trycloudflare.com"
          />
          <p className="field-hint">
            The public address of the Icecast your SDR PC publishes to (for cloud SafeT, your
            cloudflared tunnel URL; for self-hosted, e.g. <code>http://127.0.0.1:8000</code>). Each
            channel points at <code>&lt;base&gt;/tg&lt;talkgroup&gt;</code>. Saved for next time.
          </p>
        </div>

        {/* Quick add — the simple path */}
        <div className="field">
          <label>Add a talkgroup</label>
          <div className="form-row" style={{ gap: 8, alignItems: "center" }}>
            <input
              value={qId}
              onChange={(e) => setQId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
              placeholder="Talkgroup ID (e.g. 16)"
              inputMode="numeric"
              style={{ width: 160 }}
            />
            <input
              value={qName}
              onChange={(e) => setQName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
              placeholder="Channel name (e.g. DSP-DSP)"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={addManual}>
              Add
            </button>
          </div>
          <p className="field-hint">
            The decimal Talkgroup ID from RadioReference, and the channel name you want it to show
            as. Add as many as you like.
          </p>
        </div>

        {/* Bulk paste — optional */}
        <details>
          <summary style={{ cursor: "pointer" }} className="field-hint">
            …or paste / upload a whole RadioReference table
          </summary>
          <div className="field" style={{ marginTop: 8 }}>
            <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} />
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={
                "Paste the RadioReference talkgroup table here (include the header row), then click Add these.\n" +
                "Works with a copy straight off the web page (tab-separated) or a CSV export."
              }
              rows={4}
              style={{ width: "100%", marginTop: 6, fontFamily: "monospace", fontSize: 12 }}
            />
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 6 }}
              onClick={() => mergeRows(parseTalkgroups(raw))}
              disabled={!raw.trim()}
            >
              Add these
            </button>
          </div>
        </details>

        {rows.length > 0 && (
          <>
            <div className="form-row" style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter ${rows.length} talkgroups…`}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn sm" onClick={toggleAllShown}>
                {allShownSelected ? "Clear shown" : "Select shown"}
              </button>
              <span className="count">{selected.size} selected</span>
            </div>

            <div style={{ maxHeight: 320, overflow: "auto", margin: "8px 0", border: "1px solid var(--border, #333)", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", position: "sticky", top: 0, background: "var(--panel, #1b1b1b)" }}>
                    <th style={{ width: 32 }}></th>
                    <th style={{ padding: "4px 8px" }}>Channel name</th>
                    <th style={{ padding: "4px 8px" }}>TGID</th>
                    <th style={{ padding: "4px 8px" }}>Description</th>
                    <th style={{ width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.tgid} style={{ borderTop: "1px solid var(--border, #2a2a2a)" }}>
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.tgid)}
                          onChange={() => toggle(r.tgid)}
                        />
                      </td>
                      <td style={{ padding: "4px 8px" }}>{r.alpha}</td>
                      <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{r.tgid}</td>
                      <td style={{ padding: "4px 8px", opacity: 0.8 }}>{r.desc}{r.tag ? ` · ${r.tag}` : ""}</td>
                      <td style={{ textAlign: "center" }}>
                        <button
                          type="button"
                          className="btn sm danger"
                          title="Remove"
                          onClick={() => removeRow(r.tgid)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button type="button" className="btn primary" onClick={() => void createSelected()} disabled={busy}>
              {busy ? "Creating…" : `Create ${selected.size} channel${selected.size === 1 ? "" : "s"}`}
            </button>
            <p className="field-hint">
              Creates an enabled channel + stream bridge for each ticked talkgroup. Already-created
              ones are skipped, so it&apos;s safe to run again. Your SDR PC launcher picks them up
              automatically.
            </p>
          </>
        )}

        {result && <div className="banner" style={{ marginTop: 8 }}>{result}</div>}
        {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </details>
  );
}
