import { type ReactNode } from "react";
import { Link } from "react-router-dom";

// A small Markdown renderer for the legal documents in `legal/`. It covers only
// the constructs those documents use: headings (1-3), paragraphs, blockquotes,
// ordered/unordered lists, GFM tables, and inline bold / italic / code.
//
// `links` maps a code-span's exact text (e.g. a referenced filename) to an
// in-app route, so cross-references between the documents become clickable.

type Token = { kind: "code" | "bold" | "em"; m: RegExpMatchArray };

function renderInline(text: string, prefix: string, links: Record<string, string>): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    const candidates: Token[] = [];
    const code = rest.match(/`([^`]+)`/);
    if (code) candidates.push({ kind: "code", m: code });
    const bold = rest.match(/\*\*([^*]+)\*\*/);
    if (bold) candidates.push({ kind: "bold", m: bold });
    const em = rest.match(/\*([^*]+)\*/);
    if (em) candidates.push({ kind: "em", m: em });
    if (candidates.length === 0) {
      out.push(rest);
      break;
    }
    candidates.sort((a, b) => (a.m.index ?? 0) - (b.m.index ?? 0));
    const tok = candidates[0];
    const at = tok.m.index ?? 0;
    if (at > 0) out.push(rest.slice(0, at));
    const key = `${prefix}-${n++}`;
    const inner = tok.m[1];
    if (tok.kind === "code") {
      const href = links[inner];
      out.push(
        href ? (
          <Link key={key} to={href} className="lp-legal-link">
            {inner}
          </Link>
        ) : (
          <code key={key}>{inner}</code>
        ),
      );
    } else if (tok.kind === "bold") {
      out.push(<strong key={key}>{renderInline(inner, key, links)}</strong>);
    } else {
      out.push(<em key={key}>{renderInline(inner, key, links)}</em>);
    }
    rest = rest.slice(at + tok.m[0].length);
  }
  return out;
}

function tableCells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(row: string): boolean {
  return /^\s*\|?[\s|:-]+\|?\s*$/.test(row) && row.includes("-");
}

function joinParagraphs(rawLines: string[]): string[] {
  const paras: string[] = [];
  let current: string[] = [];
  for (const line of rawLines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paras.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) paras.push(current.join(" "));
  return paras;
}

function parseBlocks(source: string, links: Record<string, string>): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  const isBlockStart = (l: string): boolean =>
    /^#{1,3}\s/.test(l) || l.startsWith(">") || /^\s*\|/.test(l) || /^- /.test(l) || /^\d+\.\s/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2].trim(), `h-${k}`, links);
      blocks.push(
        level === 1 ? (
          <h1 key={k}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={k}>{content}</h2>
        ) : (
          <h3 key={k}>{content}</h3>
        ),
      );
      k++;
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const raw: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        raw.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const paras = joinParagraphs(raw);
      blocks.push(
        <blockquote key={k}>
          {paras.map((p, idx) => (
            <p key={idx}>{renderInline(p, `bq-${k}-${idx}`, links)}</p>
          ))}
        </blockquote>,
      );
      k++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].trim() !== "") {
        rows.push(lines[i]);
        i++;
      }
      const dataRows = rows.filter((r) => !isSeparatorRow(r));
      const [headRow, ...bodyRows] = dataRows;
      if (headRow) {
        blocks.push(
          <table key={k}>
            <thead>
              <tr>
                {tableCells(headRow).map((c, ci) => (
                  <th key={ci}>{renderInline(c, `th-${k}-${ci}`, links)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((r, ri) => (
                <tr key={ri}>
                  {tableCells(r).map((c, ci) => (
                    <td key={ci}>{renderInline(c, `td-${k}-${ri}-${ci}`, links)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        k++;
      }
      continue;
    }

    if (/^- /.test(line) || /^\d+\.\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const marker = ordered ? /^\d+\.\s+/ : /^- +/;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const isItem = ordered ? /^\d+\.\s/.test(l) : /^- /.test(l);
        if (isItem) {
          items.push(l.replace(marker, ""));
          i++;
        } else if (l.trim() !== "" && /^\s/.test(l) && items.length > 0) {
          items[items.length - 1] += " " + l.trim();
          i++;
        } else {
          break;
        }
      }
      const lis = items.map((it, idx) => (
        <li key={idx}>{renderInline(it, `li-${k}-${idx}`, links)}</li>
      ));
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      k++;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length > 0) {
      blocks.push(<p key={k}>{renderInline(buf.join(" "), `p-${k}`, links)}</p>);
      k++;
    } else {
      i++;
    }
  }
  return blocks;
}

export function Markdown({
  source,
  links = {},
}: {
  source: string;
  links?: Record<string, string>;
}) {
  return <>{parseBlocks(source, links)}</>;
}
