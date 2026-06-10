// Merge SafeT-generated aliases into a user's existing sdrtrunk playlist XML.
//
// Newer sdrtrunk builds have no alias "Import" button, so the desktop app
// writes the aliases straight into the playlist file (with sdrtrunk closed,
// after a backup). Text-level surgery, deliberately conservative: we only
// APPEND <alias> elements before </playlist> and never touch the user's
// channels, streams, or existing aliases.
//
// Plain CommonJS with no Electron imports so it stays unit-testable.

/** Pull whole <alias …>…</alias> elements out of a playlist/alias XML. */
function extractAliases(xml) {
  return String(xml).match(/<alias\b[^>]*>[\s\S]*?<\/alias>|<alias\b[^>]*\/>/g) || [];
}

/** Talkgroup ids already aliased in the target (any alias list). */
function existingTalkgroups(xml) {
  const ids = new Set();
  for (const m of String(xml).matchAll(/<id\b[^>]*type="talkgroup"[^>]*value="(\d+)"[^>]*\/?>/g)) ids.add(Number(m[1]));
  // attribute order can differ (value before type)
  for (const m of String(xml).matchAll(/<id\b[^>]*value="(\d+)"[^>]*type="talkgroup"[^>]*\/?>/g)) ids.add(Number(m[1]));
  return ids;
}

/** The alias list name the user's playlist actually uses: the most common
 *  list="…" among existing aliases (their channel points at it). */
function dominantListName(xml) {
  const counts = new Map();
  for (const m of String(xml).matchAll(/<alias\b[^>]*\blist="([^"]*)"/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  let best = null;
  for (const [name, n] of counts) if (name && (!best || n > counts.get(best))) best = name;
  return best;
}

/**
 * Merge `aliasXml`'s aliases into `targetXml`. Aliases whose talkgroup id is
 * already present anywhere in the target are skipped (no duplicates / no
 * monitoring conflicts). Incoming aliases are re-pointed at the target's own
 * alias list when one exists. Returns { xml, added, skipped, list }.
 */
function mergePlaylist(targetXml, aliasXml) {
  const target = String(targetXml);
  const closeIdx = target.lastIndexOf("</playlist>");
  if (closeIdx < 0) throw new Error("target is not a sdrtrunk playlist (no </playlist>)");

  const have = existingTalkgroups(target);
  const list = dominantListName(target);
  const incoming = [];
  let skipped = 0;
  for (const alias of extractAliases(aliasXml)) {
    const tg = /<id\b[^>]*type="talkgroup"[^>]*value="(\d+)"/.exec(alias) || /<id\b[^>]*value="(\d+)"[^>]*type="talkgroup"/.exec(alias);
    if (tg && have.has(Number(tg[1]))) {
      skipped++;
      continue;
    }
    incoming.push(list ? alias.replace(/(<alias\b[^>]*\blist=")[^"]*(")/, `$1${list}$2`) : alias);
  }
  if (!incoming.length) return { xml: target, added: 0, skipped, list };

  const block = `\n${incoming.map((a) => "  " + a).join("\n")}\n`;
  const xml = target.slice(0, closeIdx) + block + target.slice(closeIdx);
  return { xml, added: incoming.length, skipped, list };
}

module.exports = { mergePlaylist, extractAliases, existingTalkgroups, dominantListName };
