#!/usr/bin/env node
/**
 * sdrtrunk-harden-channels.mjs — enforce the OOM-safe SDRTrunk channel config.
 *
 * WHY: SafeT SDR runs SDRTrunk v0.6.1 on 3 RTL-SDRs covering the OC CCCS
 * Countywide cell (control 856.7125 / 857.4625) plus the 853 MHz secondary-cell
 * controls (North, South, Carbon Canyon, Northwest, Southwest). The secondary
 * cells' *voice* grants land on ~851 MHz — OUTSIDE every dongle's tuned window.
 * When those control channels are given a non-zero traffic_channel_pool_size,
 * SDRTrunk tries to FOLLOW the grant, can't find a tuner, and loops
 * "Unable to source channel ... searching for another tuner" hundreds of times
 * an hour. That floods the event-log buffer (~4 GB) and walks the Java heap up
 * to the -Xmx cap until it OOM-crashes and takes the whole feed down (including
 * Countywide).
 *
 * FIX: keep the secondary controls DECODING (talkgroup awareness preserved) but
 * following ZERO voice grants — traffic_channel_pool_size="0". Countywide keeps
 * its pool (30) so it still follows voice. This script makes that config
 * reproducible and idempotent: for every enabled <channel> whose site is NOT
 * Countywide, it sets the decode_configuration's traffic_channel_pool_size to 0.
 *
 * This ONLY edits channels — it never touches the alias list that
 * sdrtrunk-playlist.mjs generates. The two are independent.
 *
 * Usage (run from sdr-bridge/):
 *   node scripts/sdrtrunk-harden-channels.mjs [playlist.xml]
 *   SDRTRUNK_PLAYLIST=C:\path\OCCCCs.xml node scripts/sdrtrunk-harden-channels.mjs
 *   npm run harden:sdrtrunk
 *
 * Playlist path resolution: argv[2] -> $SDRTRUNK_PLAYLIST -> ~/SDRTrunk/playlist/OCCCCs.xml.
 * A timestamped .bak is written before any change. The patch is line-targeted
 * string replacement (NOT a full XML re-serialize), so the file's original
 * encoding, BOM, and CRLF line endings are preserved verbatim.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Countywide cell is the only site whose voice is in-band, so it's the only
// one that should follow grants. Match on a substring so a "Countywide",
// "Countywide Tower", "Countywide (simulcast)" etc. site is all protected —
// zeroing Countywide's pool would stop it following voice and defeat the feed.
export const PROTECTED_SITE_SUBSTRING = "countywide";

/**
 * Harden one SDRTrunk playlist XML string. Returns { xml, changed } where
 * `changed` is [{ name, site, from }] for each channel actually modified (a
 * channel already at 0 is left alone, so a second run reports nothing).
 *
 * SDRTrunk serializes traffic_channel_pool_size as an attribute on
 * <decode_configuration>; some builds/hand-edits use a child element. Both
 * forms are handled. `site` and `enabled` may likewise be attributes on
 * <channel> or child elements. All matching is done per-channel-block so a
 * value in one channel can't leak into another.
 */
export function hardenPlaylist(xml) {
  const changed = [];
  const out = xml.replace(/<channel\b[\s\S]*?<\/channel>/g, (block) => {
    if (!isEnabled(block)) return block;
    const site = getSite(block);
    if (site.toLowerCase().includes(PROTECTED_SITE_SUBSTRING)) return block;

    let from = null;
    const patched = block
      .replace(/(traffic_channel_pool_size=")(\d+)(")/g, (m, pre, val, post) => {
        if (val === "0") return m;
        from = val;
        return `${pre}0${post}`;
      })
      .replace(/(<traffic_channel_pool_size>)\s*(\d+)\s*(<\/traffic_channel_pool_size>)/g, (m, pre, val, post) => {
        if (val === "0") return m;
        from = val;
        return `${pre}0${post}`;
      });
    if (from !== null) changed.push({ name: getName(block), site, from });
    return patched;
  });
  return { xml: out, changed };
}

function isEnabled(block) {
  const open = block.match(/<channel\b[^>]*>/)?.[0] ?? "";
  if (/\benabled\s*=\s*"false"/i.test(open)) return false;
  if (/<enabled>\s*false\s*<\/enabled>/i.test(block)) return false;
  return /\benabled\s*=\s*"true"/i.test(open) || /<enabled>\s*true\s*<\/enabled>/i.test(block);
}

function getSite(block) {
  const open = block.match(/<channel\b[^>]*>/)?.[0] ?? "";
  const attr = open.match(/\bsite\s*=\s*"([^"]*)"/i)?.[1];
  if (attr != null) return attr.trim();
  const el = block.match(/<site>([\s\S]*?)<\/site>/i)?.[1];
  return (el ?? "").trim();
}

function getName(block) {
  const open = block.match(/<channel\b[^>]*>/)?.[0] ?? "";
  const attr = open.match(/\bname\s*=\s*"([^"]*)"/i)?.[1];
  if (attr != null) return attr.trim();
  const el = block.match(/<name>([\s\S]*?)<\/name>/i)?.[1];
  return (el ?? "(unnamed channel)").trim();
}

function defaultPlaylistPath() {
  return process.argv[2] || process.env.SDRTRUNK_PLAYLIST || join(homedir(), "SDRTrunk", "playlist", "OCCCCs.xml");
}

// A filesystem-safe timestamp for the .bak name: 2026-07-01T12-30-00-000Z.
function backupStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function main() {
  const path = defaultPlaylistPath();
  let xml;
  try {
    xml = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[harden] cannot read playlist ${path}: ${e.message}`);
    console.error(`[harden] pass the path as an argument or set SDRTRUNK_PLAYLIST.`);
    process.exit(1);
  }

  const { xml: patched, changed } = hardenPlaylist(xml);
  if (!changed.length) {
    console.log(`[harden] ${path}: already hardened — no channel needed changing.`);
    return;
  }

  const bak = `${path}.${backupStamp(new Date())}.bak`;
  writeFileSync(bak, xml); // byte-for-byte copy of the original before we touch it
  writeFileSync(path, patched);

  console.log(`[harden] ${path}`);
  console.log(`[harden] backup -> ${bak}`);
  console.log(`[harden] set traffic_channel_pool_size="0" on ${changed.length} secondary-cell channel(s):`);
  for (const c of changed) console.log(`  - ${c.name}  [site: ${c.site || "?"}]  ${c.from} -> 0`);
  console.log(`[harden] Countywide channels left unchanged (they still follow voice grants).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
