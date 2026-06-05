#!/usr/bin/env node
/**
 * import-bridges.mjs — create (or update) one SafeT-PTT channel + one stream
 * bridge per talkgroup, from generated/bridges.json.
 *
 * Talks only to the SafeT admin REST API:
 *   POST /auth/login            -> { token }
 *   GET/POST /admin/channels    -> ensure a channel exists per talkgroup
 *   GET/POST/PATCH /admin/bridges -> ensure a stream_url bridge per talkgroup
 *
 * Idempotent: re-running reconciles instead of duplicating. Pass --dry-run to
 * preview without writing anything.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "generated", "bridges.json");
const DRY = process.argv.includes("--dry-run");

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(MANIFEST))
  die("generated/bridges.json not found — run `npm run generate` first.");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const safet = manifest.safet ?? {};
const baseUrl = String(safet.baseUrl ?? "").replace(/\/+$/, "");
if (!baseUrl) die("safet.baseUrl missing in config/system.json (e.g. http://127.0.0.1:8080/v1).");
if (!safet.username || !safet.password)
  die("safet.username / safet.password missing in config/system.json.");

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
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json.error ?? text}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function main() {
  if (DRY) console.log("\n  (dry run — no changes will be written)\n");

  // --- log in -------------------------------------------------------------
  let token;
  try {
    const login = await api("POST", "/auth/login", {
      body: {
        username: safet.username,
        password: safet.password,
        ...(safet.agencySlug ? { agency_slug: safet.agencySlug } : {}),
      },
    });
    token = login.token;
  } catch (e) {
    die(`login failed: ${e.message}\n    Check safet.baseUrl / username / password.`);
  }
  if (!token) die("login returned no token — is this an admin account?");
  console.log(`  ✓ authenticated to ${baseUrl}`);

  // --- existing state -----------------------------------------------------
  const existingChannels = (await api("GET", "/admin/channels", { token })).channels ?? [];
  const channelByName = new Map(existingChannels.map((c) => [c.name, c]));
  const existingBridges = (await api("GET", "/admin/bridges", { token })).bridges ?? [];
  const bridgeByName = new Map(existingBridges.map((b) => [b.name, b]));

  let createdCh = 0,
    createdBr = 0,
    updatedBr = 0,
    skipped = 0;

  for (const b of manifest.bridges) {
    // 1) ensure the channel exists
    if (!channelByName.has(b.channel)) {
      if (DRY) {
        console.log(`  + channel  "${b.channel}"  (would create)`);
      } else {
        const { channel } = await api("POST", "/admin/channels", {
          token,
          body: { name: b.channel },
        });
        channelByName.set(channel.name, channel);
        console.log(`  + channel  "${b.channel}"`);
      }
      createdCh++;
    }

    // 2) ensure the stream bridge exists (and points where we expect)
    const desired = {
      name: b.name,
      sourceType: "stream_url",
      sourceUrl: b.sourceUrl,
      targetChannel: b.channel,
      voxThreshold: b.voxThreshold,
      voxHangMs: b.voxHangMs,
      yieldToUnits: b.yieldToUnits,
      txMode: "passthrough",
      enabled: b.enabled,
    };
    const existing = bridgeByName.get(b.name);
    if (!existing) {
      if (DRY) {
        console.log(`  + bridge   "${b.name}"  -> ${b.channel}   ${b.sourceUrl}  (would create)`);
      } else {
        await api("POST", "/admin/bridges", { token, body: desired });
        console.log(`  + bridge   "${b.name}"  -> ${b.channel}   ${b.sourceUrl}`);
      }
      createdBr++;
    } else {
      const drift =
        existing.source_url !== b.sourceUrl ||
        existing.target_channel !== b.channel ||
        existing.enabled !== b.enabled;
      if (!drift) {
        skipped++;
        continue;
      }
      if (DRY) {
        console.log(`  ~ bridge   "${b.name}"  (would update url/channel/enabled)`);
      } else {
        await api("PATCH", `/admin/bridges/${existing.id}`, { token, body: desired });
        console.log(`  ~ bridge   "${b.name}"  (updated)`);
      }
      updatedBr++;
    }
  }

  console.log(
    `\n  Done. channels +${createdCh}, bridges +${createdBr} ~${updatedBr}, unchanged ${skipped}.` +
      (DRY ? "  (dry run)\n" : "\n"),
  );
  if (!DRY)
    console.log(
      "  The bridge worker picks up new/changed bridges within ~15s. Watch levels in\n" +
        "  the console's Bridges tab — a mount goes 'keyed' when a call comes through.\n",
    );
}

main().catch((e) => die(e.message));
