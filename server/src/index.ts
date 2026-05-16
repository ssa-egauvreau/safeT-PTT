import { createServer } from "node:http";
import express from "express";
import { DEFAULT_GREEN_CHANNELS } from "./defaultChannels.js";
import { ensureChannelSchema, listChannelsFromDb } from "./db.js";
import { countPresence, heartbeatPresence } from "./presence.js";
import { VOICE_WS_PATH, attachVoiceRelay, peekVoiceTransmittingUnit } from "./voiceRelay.js";

const app = express();
app.use(express.json());

const radioApiKey = process.env.RADIO_API_KEY?.trim();

function requireApiKeyUnlessDisabled(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!radioApiKey) {
    next();
    return;
  }
  if (req.path === "/health") {
    next();
    return;
  }
  const provided = req.header("x-radio-key");
  if (provided !== radioApiKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.use(requireApiKeyUnlessDisabled);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "security-radio-api" });
});

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

const port = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  await ensureChannelSchema().catch((error) => {
    console.error("Database bootstrap failed (continuing without DB)", error);
  });

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
