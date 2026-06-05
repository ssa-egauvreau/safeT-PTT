import { useState, type ChangeEvent } from "react";
import { api, describeError } from "../../api";

/** One talkgroup parsed from a RadioReference / trunk-recorder CSV export. */
interface TalkRow {
  tgid: number;
  alpha: string;
  desc: string;
  tag: string;
}

const BASE_URL_KEY = "sdrStreamBaseUrl";

/** Split one CSV line, honoring "quoted, fields". */
function splitCsv(line: string): string[] {
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
    } else if (c === ",") {
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
 * Parse a RadioReference talkgroup export or a trunk-recorder talkgroups.csv.
 * Both are CSV with a Decimal TGID and an Alpha Tag; column order varies, so we
 * map by header name when a header is present and fall back to the well-known
 * trunk-recorder order otherwise.
 */
function parseTalkgroups(text: string): TalkRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const first = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = first.some((h) => h === "decimal" || h === "alpha tag" || h === "tgid");

  // Column indices (trunk-recorder default order as the fallback).
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
    const cols = splitCsv(line);
    const tgid = Number(cols[iDec]);
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
 * "Import from RadioReference" — paste a talkgroup export, tick the ones you
 * want, and create a channel + stream bridge for each in one click.
 *
 * The stream URL for each bridge is `<base>/tg<TGID>`. That mount-naming
 * convention is what lets the PC-side launcher (sdr-bridge) auto-discover which
 * talkgroups to decode straight from the bridges you create here — no second
 * config to maintain.
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
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<TalkRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function loadCsv(text: string) {
    setRaw(text);
    const parsed = parseTalkgroups(text);
    setRows(parsed);
    setSelected(new Set());
    setResult(null);
    setError(parsed.length === 0 && text.trim() ? "No talkgroups found — is this a RadioReference / trunk-recorder CSV?" : null);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then(loadCsv);
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
      setError("Tick at least one talkgroup.");
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
    setSelected(new Set());
    onDone();
  }

  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.tgid));

  return (
    <details className="card" style={{ marginBottom: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Import from RadioReference&nbsp;
        <span className="field-hint" style={{ fontWeight: 400 }}>
          — paste a talkgroup export, tick the ones you want, create them all at once
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
            bridge below points at <code>&lt;base&gt;/tg&lt;talkgroup&gt;</code>. Saved for next time.
          </p>
        </div>

        <div className="field">
          <label>Talkgroup CSV</label>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          <textarea
            value={raw}
            onChange={(e) => loadCsv(e.target.value)}
            placeholder="…or paste your RadioReference / trunk-recorder talkgroup CSV here"
            rows={4}
            style={{ width: "100%", marginTop: 6, fontFamily: "monospace", fontSize: 12 }}
          />
          <p className="field-hint">
            Use RadioReference&apos;s talkgroup export or a trunk-recorder <code>talkgroups.csv</code>.
            We read the decimal Talkgroup ID and Alpha Tag from each row.
          </p>
        </div>

        {rows.length > 0 && (
          <>
            <div className="form-row" style={{ alignItems: "center", gap: 8 }}>
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
                    <th style={{ padding: "4px 8px" }}>Alpha Tag</th>
                    <th style={{ padding: "4px 8px" }}>TGID</th>
                    <th style={{ padding: "4px 8px" }}>Description</th>
                    <th style={{ padding: "4px 8px" }}>Tag</th>
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
                      <td style={{ padding: "4px 8px", opacity: 0.8 }}>{r.desc}</td>
                      <td style={{ padding: "4px 8px", opacity: 0.8 }}>{r.tag}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button type="button" className="btn primary" onClick={() => void createSelected()} disabled={busy}>
              {busy ? "Creating…" : `Create ${selected.size} bridge${selected.size === 1 ? "" : "s"}`}
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
