import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_GREEN_CHANNELS } from "./defaultChannels.js";
import { ensureSchema, getPool, listChannelsFromDb } from "./db.js";
import { getAgencyById, resolveAgencyByKey, seedInitialAccounts } from "./store.js";
import { startRecorder } from "./recorder.js";
import { recoverPendingTranscriptions } from "./transcribe.js";
import { initServerImbe } from "./imbeServerCodec.js";
import { authenticate } from "./auth.js";
import { createApiRouter } from "./apiRoutes.js";
import { countPresence, heartbeatPresence } from "./presence.js";
import { VOICE_WS_PATH, attachVoiceRelay, peekVoiceTransmittingTalker } from "./voiceRelay.js";
import { startBridgeWorker } from "./bridgeWorker.js";

const app = express();
// Behind Railway / Cloudflare / any reverse proxy, `req.ip`, `req.protocol`, and `req.hostname`
// otherwise reflect the upstream proxy IP/scheme instead of the real client. clientIp() already
// parses X-Forwarded-For manually, but downstream code (req.secure, req.hostname, future rate
// limiters) wants Express's built-ins to be correct too. "trust proxy: true" honors X-Forwarded-*
// from any upstream — fine on Railway where the only ingress is the LB.
app.set("trust proxy", true);
// HSTS — Railway is HTTPS-always, so tell browsers to refuse plaintext for a year. Skip in dev
// where the operator might hit localhost over plain HTTP.
if (process.env.NODE_ENV === "production") {
  app.use((_req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
}
app.use(express.json({ limit: "2mb" }));
app.use(authenticate);

const radioApiKey = process.env.RADIO_API_KEY?.trim();

/**
 * Handset / radio endpoints. Each request is bound to an agency: a console JWT
 * carries its agency, while an Android handset presents a per-agency radio key
 * (the legacy global `RADIO_API_KEY` still maps to the default agency).
 * The console/admin/owner API authenticates with per-account JWTs instead.
 */
const LEGACY_RADIO_PATHS = new Set([
  "/v1/channels",
  "/v1/air",
  "/v1/presence/heartbeat",
  "/v1/presence/count",
  "/v1/talk-activity",
  "/v1/radio/location",
  "/v1/radio/transmissions",
  "/v1/radio/inbox",
  "/v1/radio/emergency",
]);

app.use(async (req, res, next) => {
  if (!LEGACY_RADIO_PATHS.has(req.path)) {
    next();
    return;
  }
  try {
    // Signed-in handset or console bearer token — agency comes from the account.
    if (req.authUser?.agencyId != null) {
      const fromToken = await getAgencyById(req.authUser.agencyId).catch(() => null);
      if (fromToken && !fromToken.disabled) {
        req.agency = { id: fromToken.id, name: fromToken.name, slug: fromToken.slug };
        next();
        return;
      }
    }

    const headerRaw = req.headers["x-radio-key"];
    const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const key = headerVal ?? (typeof req.query.key === "string" ? req.query.key : null);
    if (!getPool()) {
      // No database — per-agency keys can't be resolved, but the global
      // RADIO_API_KEY (env, DB-independent) must still gate handset endpoints.
      if (!radioApiKey || key === radioApiKey) {
        next();
        return;
      }
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Handset endpoints are gated by the radio key, never by a console JWT —
    // a bearer token may still ride along and is used only for attribution.
    const ag = await resolveAgencyByKey(key, radioApiKey);
    if (!ag) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.agency = { id: ag.id, name: ag.name, slug: ag.slug };
    next();
  } catch (error) {
    console.error("Agency resolution failed", error);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "safet-ptt-api" });
});

// Console + admin API. Unmatched paths fall through to the legacy routes below.
app.use("/v1", createApiRouter());

app.get("/v1/channels", async (req, res) => {
  try {
    const rows = await listChannelsFromDb(req.agency?.id ?? 0);
    const channels = rows && rows.length > 0 ? rows : [...DEFAULT_GREEN_CHANNELS];
    res.json({ channels });
  } catch (error) {
    console.error("Failed to read channels", error);
    res.status(500).json({ error: "channel_query_failed" });
  }
});

/**
 * Busy / Permit hint for PTT.
 * Optional `?channel=Green 1`: uses live PCM activity from voice relay (+ optional AIR_OCCUPIED simulation).
 */
app.get("/v1/air", (req, res) => {
  const raw = process.env.AIR_OCCUPIED?.trim().toLowerCase();
  const envBusy = raw === "1" || raw === "true" || raw === "yes";

  const chQ = typeof req.query.channel === "string" ? req.query.channel : "";
  const talker = peekVoiceTransmittingTalker(req.agency?.id ?? 0, chQ);
  const occupied = envBusy || talker !== null;

  res.json({
    occupied,
    transmitting_unit_id: talker?.unit_id ?? null,
    transmitting_display_name: talker?.display_name ?? null,
  });
});

/** Registers (or refreshes TTL for) this unit on its tuned channel via periodic Android heartbeats. */
app.post("/v1/presence/heartbeat", (req, res) => {
  const hb = heartbeatPresence(req.agency?.id ?? 0, req.body?.unit_id, req.body?.channel);
  if (!hb.ok) {
    res.status(400).json({ error: hb.error ?? "presence_refused" });
    return;
  }
  res.json({ ok: true });
});

/** Returns distinct units whose heartbeats arrived within TTL for the queried channel label. */
app.get("/v1/presence/count", (req, res) => {
  const channelRaw = typeof req.query.channel === "string" ? req.query.channel : "";
  const count = countPresence(req.agency?.id ?? 0, channelRaw);
  res.json({
    channel: channelRaw.trim(),
    count,
  });
});

/**
 * Talker hints for UI ("who is keyed") from live voice relay air state.
 * Query: `home` = tuned channel; `scan` = comma-separated side channels to watch.
 */
app.get("/v1/talk-activity", (req, res) => {
  const agencyId = req.agency?.id ?? 0;
  const homeRaw = typeof req.query.home === "string" ? req.query.home.trim() : "";
  const scanRaw = typeof req.query.scan === "string" ? req.query.scan.trim() : "";

  const mainTalker = homeRaw ? peekVoiceTransmittingTalker(agencyId, homeRaw) : null;

  const scanChannels = scanRaw
    ? scanRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  let scanChannel = "";
  let scanTalker: { unit_id: string; display_name: string | null } | null = null;
  for (const ch of scanChannels) {
    const talker = peekVoiceTransmittingTalker(agencyId, ch);
    if (talker) {
      scanChannel = ch;
      scanTalker = talker;
      break;
    }
  }

  res.json({
    main: {
      channel: homeRaw,
      active: mainTalker !== null,
      unit_id: mainTalker?.unit_id ?? null,
      username: mainTalker?.display_name ?? null,
    },
    scan: {
      channel: scanChannel,
      active: scanTalker !== null,
      unit_id: scanTalker?.unit_id ?? null,
      username: scanTalker?.display_name ?? null,
    },
  });
});

// Serve the built web console (and let it own client-side routing) when present.
// web-console builds into server/dist/web-public, beside the compiled server,
// so Railway includes it in the deployed image.
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "web-public");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/v1/") || req.path === "/health") {
      next();
      return;
    }
    res.sendFile(join(webDist, "index.html"));
  });
  console.log(`Web console served from ${webDist}`);
} else {
  console.log(`Web console build not found at ${webDist} (build it, or run the Vite dev server).`);
}

const port = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  await ensureSchema().catch((error) => {
    console.error("Database bootstrap failed (continuing without DB)", error);
  });
  await seedInitialAccounts().catch((error) => {
    console.error("Initial account seed failed", error);
  });

  startRecorder();
  void recoverPendingTranscriptions();
  void initServerImbe();

  const server = createServer(app);
  // Bound memory in the face of a header-bombing attack — Node's default is unlimited and a
  // single connection could otherwise queue thousands of huge headers before they're parsed.
  server.maxHeadersCount = 100;
  attachVoiceRelay(server, { radioApiKey });

  server.listen(port, () => {
    console.log(`safeT PTT API listening on ${port}`);
    console.log(`RADIO_API_KEY ${radioApiKey ? "enabled" : "disabled"}`);
    console.log(`Voice relay WebSocket path ${VOICE_WS_PATH}`);
    console.log(`DATABASE_URL ${process.env.DATABASE_URL ? "configured" : "not set (in-memory defaults)"}`);
    // The radio-bridge worker ingests stream-URL bridges onto their channels.
    startBridgeWorker({ port });
  });
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
