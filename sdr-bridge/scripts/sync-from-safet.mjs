#!/usr/bin/env node
/**
 * sync-from-safet.mjs — CONSOLE path (the friendly one).
 *
 * Reads the stream bridges you created in the SafeT console (Bridges → Import
 * from RadioReference), works out which talkgroup each one is by parsing the
 * `…/tg<NNN>` mount in its stream URL, and regenerates the local runtime files
 * (trunk-recorder config, icecast.xml, ffmpeg streamers) to match.
 *
 * So the talkgroup list lives in ONE place — the SafeT console — and this PC
 * just follows it. No config/system.json `bridges[]` editing required; that file
 * only supplies the RF/Icecast settings.
 *
 * Auto-repoint: if env SDR_STREAM_BASE is set (the launcher passes the live
 * cloudflared URL), every SDR bridge's stream URL is rewritten to
 * `<SDR_STREAM_BASE>/tg<NNN>` so a tunnel URL that changed since you created the
 * bridges in the console is fixed automatically — no manual edit each session.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifacts, tgidFromMount } from "./lib/build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "system.json");

/** Optional live stream base (e.g. the current cloudflared URL) to repoint bridges to. */
const REPOINT_BASE = (process.env.SDR_STREAM_BASE ?? "").trim().replace(/\/+$/, "");

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(CONFIG))
  die("config/system.json not found — copy config/system.example.json and set sdr/icecast/safet.");

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const safet = cfg.safet ?? {};
const baseUrl = String(safet.baseUrl ?? "").replace(/\/+$/, "");
if (!baseUrl || !safet.username || !safet.password)
  die("config/system.json needs safet.baseUrl / username / password to read your bridges.");

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error ?? text}`);
  return json;
}

async function main() {
  let token;
  try {
    token = (
      await api("POST", "/auth/login", {
        body: {
          username: safet.username,
          password: safet.password,
          ...(safet.agencySlug ? { agency_slug: safet.agencySlug } : {}),
        },
      })
    ).token;
  } catch (e) {
    die(`login failed: ${e.message}`);
  }
  if (!token) die("login returned no token — is this an admin account?");

  const bridges = (await api("GET", "/admin/bridges", { token })).bridges ?? [];

  if (REPOINT_BASE && !/^https?:\/\//.test(REPOINT_BASE))
    die(`SDR_STREAM_BASE must start with http(s):// — got "${REPOINT_BASE}".`);

  // Keep only enabled stream bridges whose mount looks like /tg<NNN>.
  const plan = [];
  const seen = new Set();
  const skipped = [];
  for (const b of bridges) {
    if (b.source_type !== "stream_url" || !b.enabled) continue;
    const tgid = tgidFromMount(b.source_url ?? "");
    if (tgid === null) {
      skipped.push(b.name);
      continue;
    }
    if (seen.has(tgid)) continue;
    seen.add(tgid);
    plan.push({ id: b.id, tgid, mount: `tg${tgid}`, channel: b.target_channel || b.name, sourceUrl: b.source_url });
  }

  if (plan.length === 0)
    die(
      "No SDR bridges found. In the SafeT console: Bridges → Import from RadioReference,\n" +
        "    pick talkgroups, and Create. Then run this again.",
    );

  // Repoint stale stream URLs to the live tunnel base, if one was passed.
  let repointed = 0;
  if (REPOINT_BASE) {
    for (const p of plan) {
      const want = `${REPOINT_BASE}/${p.mount}`;
      if (p.sourceUrl === want) continue;
      try {
        await api("PATCH", `/admin/bridges/${p.id}`, { token, body: { sourceUrl: want } });
        p.sourceUrl = want;
        repointed++;
      } catch (e) {
        console.warn(`  ! could not repoint ${p.channel} (TG ${p.tgid}): ${e.message}`);
      }
    }
  }

  const withPorts = writeArtifacts(ROOT, cfg, plan);

  console.log(`\n  ✓ Synced ${withPorts.length} talkgroup(s) from SafeT:\n`);
  for (const p of withPorts)
    console.log(`    • ${String(p.channel).padEnd(18)} TGID ${String(p.tgid).padEnd(6)} udp:${p.udpPort} -> /${p.mount}`);
  if (REPOINT_BASE)
    console.log(`\n  ↻ Repointed ${repointed} bridge URL(s) to ${REPOINT_BASE}`);
  if (skipped.length)
    console.log(`\n  (ignored ${skipped.length} non-SDR bridge(s): ${skipped.join(", ")})`);
  console.log("");
}

main().catch((e) => die(e.message));
