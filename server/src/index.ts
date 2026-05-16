import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULT_GREEN_CHANNELS } from "./defaultChannels.js";
import { ensureSchema, listChannelsFromDb } from "./db.js";
import { seedInitialAdmin } from "./store.js";
import { startRecorder } from "./recorder.js";
import { recoverPendingTranscriptions } from "./transcribe.js";
import { authenticate } from "./auth.js";
import { createApiRouter } from "./apiRoutes.js";
import { countPresence, heartbeatPresence } from "./presence.js";
import { VOICE_WS_PATH, attachVoiceRelay, peekVoiceTransmittingUnit } from "./voiceRelay.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(authenticate);

const radioApiKey = process.env.RADIO_API_KEY?.trim();

/**
 * Legacy Android endpoints stay behind the shared `RADIO_API_KEY`.
 * The console/admin API (`/v1/auth`, `/v1/admin`, `/v1/me`) authenticates with per-account JWTs instead.
 */
const LEGACY_KEYED_PATHS = new Set([
  "/v1/channels",
  "/v1/air",
  "/v1/presence/heartbeat",
  "/v1/presence/count",
  "/v1/talk-activity",
  "/v1/radio/location",
  "/v1/radio/inbox",
  "/v1/radio/emergency",
]);

app.use((req, res, next) => {
  if (!radioApiKey || !LEGACY_KEYED_PATHS.has(req.path)) {
    next();
    return;
  }
  if (req.header("x-radio-key") !== radioApiKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "security-radio-api" });
});

// Console + admin API. Unmatched paths fall through to the legacy routes below.
app.use("/v1", createApiRouter());

app.get("/v1/channels", async (_req, res) => {
  try {
    const rows = await listChannelsFromDb();
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
  const transmitting = peekVoiceTransmittingUnit(chQ);
  const occupied = envBusy || transmitting !== null;

  res.json({
    occupied,
    transmitting_unit_id: transmitting ?? null,
  });
});

/** Registers (or refreshes TTL for) this unit on its tuned channel via periodic Android heartbeats. */
app.post("/v1/presence/heartbeat", (req, res) => {
  const hb = heartbeatPresence(req.body?.unit_id, req.body?.channel);
  if (!hb.ok) {
    res.status(400).json({ error: hb.error ?? "presence_refused" });
    return;
  }
  res.json({ ok: true });
});

/** Returns distinct units whose heartbeats arrived within TTL for the queried channel label. */
app.get("/v1/presence/count", (req, res) => {
  const channelRaw = typeof req.query.channel === "string" ? req.query.channel : "";
  const count = countPresence(channelRaw);
  res.json({
    channel: channelRaw.trim(),
    count,
  });
});

/**
 * Optional talker hints for UI ("who is keyed"). Android merges with main vs scan priority locally.
 * Railway env (optional):
 *   MOCK_TALK_MAIN_ACTIVE, MOCK_TALK_MAIN_CHANNEL, MOCK_TALK_MAIN_UNIT, MOCK_TALK_MAIN_USER
 *   MOCK_TALK_SCAN_ACTIVE, MOCK_TALK_SCAN_CHANNEL, MOCK_TALK_SCAN_UNIT, MOCK_TALK_SCAN_USER
 */
app.get("/v1/talk-activity", (_req, res) => {
  const truthy = (v: string | undefined): boolean => {
    const t = (v ?? "").trim().toLowerCase();
    return t === "1" || t === "true" || t === "yes";
  };

  const mainActive = truthy(process.env.MOCK_TALK_MAIN_ACTIVE);
  const scanActive = truthy(process.env.MOCK_TALK_SCAN_ACTIVE);

  res.json({
    main: {
      channel: (process.env.MOCK_TALK_MAIN_CHANNEL ?? "Green 1").trim(),
      active: mainActive,
      unit_id: process.env.MOCK_TALK_MAIN_UNIT?.trim() ?? null,
      username: process.env.MOCK_TALK_MAIN_USER?.trim() ?? null,
    },
    scan: {
      channel: (process.env.MOCK_TALK_SCAN_CHANNEL ?? "Green 2").trim(),
      active: scanActive,
      unit_id: process.env.MOCK_TALK_SCAN_UNIT?.trim() ?? null,
      username: process.env.MOCK_TALK_SCAN_USER?.trim() ?? null,
    },
  });
});

// Serve the built web console (and let it own client-side routing) when present.
// web-console builds into server/web-public so it ships with this service.
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../web-public");
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
  await seedInitialAdmin().catch((error) => {
    console.error("Initial admin seed failed", error);
  });

  startRecorder();
  void recoverPendingTranscriptions();

  const server = createServer(app);
  attachVoiceRelay(server, { radioApiKey });

  server.listen(port, () => {
    console.log(`Security Radio API listening on ${port}`);
    console.log(`RADIO_API_KEY ${radioApiKey ? "enabled" : "disabled"}`);
    console.log(`Voice relay WebSocket path ${VOICE_WS_PATH}`);
    console.log(`DATABASE_URL ${process.env.DATABASE_URL ? "configured" : "not set (in-memory defaults)"}`);
  });
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
