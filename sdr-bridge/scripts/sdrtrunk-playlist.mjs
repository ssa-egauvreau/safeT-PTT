#!/usr/bin/env node
/**
 * sdrtrunk-playlist.mjs — generate a sdrtrunk ALIAS LIST you import once.
 *
 * "App launches sdrtrunk" deliberately does NOT regenerate your tuner/channel
 * config — that's the part that already decodes this simulcast system
 * perfectly, and it's hardware-specific. We only add the streaming glue: an
 * alias list that (1) tags each talkgroup with the SafeT broadcast channel so
 * sdrtrunk uploads its finished calls to us, and (2) gives each a readable
 * label that rides along to the Scan All feed.
 *
 * Writes sdrtrunk/safet-aliases.xml. Import it in sdrtrunk's Playlist Editor
 * (Aliases tab -> Import), point the import at the alias list your channel
 * uses (default name "OCCCS"), and add the one RdioScanner stream the README
 * documents. The bridge routes each uploaded call to its SafeT channel by
 * talkgroup id, so only talkgroups that map to a SafeT channel need uploading.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAYLIST_VERSION = 4; // sdrtrunk PlaylistManager.PLAYLIST_CURRENT_VERSION

export function escapeXml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

/**
 * Build a sdrtrunk alias-list playlist (aliases only — safe to import without
 * touching your channels or tuner). `talkgroups`: [{ tgid, label, group? }].
 * Each alias tags the talkgroup with the broadcast channel `streamName` so
 * sdrtrunk uploads its calls to the SafeT bridge.
 */
export function buildAliasList(talkgroups, { listName = "OCCCS", streamName = "SafeT" } = {}) {
  const seen = new Set();
  const aliases = [];
  for (const tg of talkgroups) {
    const id = Number(tg.tgid);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const name = escapeXml(tg.label || `TG ${id}`);
    const group = escapeXml(tg.group || "SDR");
    aliases.push(
      `  <alias color="-1" list="${escapeXml(listName)}" name="${name}" group="${group}">\n` +
        `    <id protocol="APCO25" type="talkgroup" value="${id}"/>\n` +
        `    <id channel="${escapeXml(streamName)}" type="broadcastChannel"/>\n` +
        `  </alias>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<playlist version="${PLAYLIST_VERSION}">\n${aliases.join("\n")}\n</playlist>\n`;
}

/** tgid -> { label, group } from config/occcs-talkgroups.csv (Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category). */
function loadReferenceTalkgroups(root) {
  const out = new Map();
  try {
    const lines = readFileSync(join(root, "config", "occcs-talkgroups.csv"), "utf8").split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const id = Number((c[0] ?? "").trim());
      if (Number.isFinite(id) && id > 0 && c[2]) out.set(id, { label: c[2].trim(), group: (c[6] ?? "").trim() || "OC CCCS" });
    }
  } catch {
    /* reference list is optional */
  }
  return out;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cfg = JSON.parse(readFileSync(join(root, "config", "system.json"), "utf8"));
  const ref = loadReferenceTalkgroups(root);

  // Prefer the talkgroups the SafeT bridges actually map to channels; fall back
  // to the offline `bridges` list in config. Either way, label from the
  // reference CSV when available so Scan All shows names, not numbers.
  const ids = new Set();
  const fromBridges = (b) => {
    const m = String(b.source_url ?? "").match(/\/tg(\d+)\/?$/i);
    if (m) ids.add(Number(m[1]));
    else if (Number.isFinite(Number(b.tgid))) ids.add(Number(b.tgid));
  };
  try {
    const safet = cfg.safet ?? {};
    const base = String(safet.baseUrl ?? "").replace(/\/+$/, "");
    const r = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: safet.username, password: safet.password, ...(safet.agencySlug ? { agency_slug: safet.agencySlug } : {}) }),
    });
    const token = (await r.json())?.token;
    const br = await fetch(`${base}/admin/bridges`, { headers: { authorization: `Bearer ${token}` } });
    for (const b of (await br.json())?.bridges ?? []) fromBridges(b);
  } catch {
    for (const b of cfg.bridges ?? []) fromBridges(b);
  }
  if (!ids.size) for (const b of cfg.bridges ?? []) fromBridges(b);

  const streamName = cfg.sdrtrunk?.streamName || "SafeT";
  const listName = cfg.sdrtrunk?.aliasList || "OCCCS";
  const talkgroups = [...ids].map((id) => ({ tgid: id, ...(ref.get(id) || { label: `TG ${id}`, group: "SDR" }) }));
  const xml = buildAliasList(talkgroups, { listName, streamName });

  const outDir = join(root, "sdrtrunk");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "safet-aliases.xml");
  writeFileSync(outFile, xml);
  console.log(`[sdrtrunk] wrote ${talkgroups.length} alias(es) -> ${outFile}`);
  console.log(`[sdrtrunk] import into alias list "${listName}", broadcast channel/stream "${streamName}".`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[sdrtrunk] playlist generation failed:", e.message);
    process.exit(1);
  });
}
