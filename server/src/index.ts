import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express, { raw } from "express";
import { DEFAULT_GREEN_CHANNELS } from "./defaultChannels.js";
import { ensureSchema, getPool, listChannelsFromDb } from "./db.js";
import { getAgencyById, resolveAgencyByKey, seedInitialAccounts } from "./store.js";
import { startRecorder } from "./recorder.js";
import { recoverPendingTranscriptions } from "./transcribe.js";
import { initServerImbe } from "./imbeServerCodec.js";
import { initServerCodec2 } from "./codec2ServerCodec.js";
import { initServerOpus } from "./opusServerCodec.js";
import { initServerAmbe } from "./ambeServerCodec.js";
import { authenticate } from "./auth.js";
import { createApiRouter } from "./apiRoutes.js";
import { countPresence, heartbeatPresence } from "./presence.js";
import {
  VOICE_WS_PATH,
  attachVoiceRelay,
  closeAllVoiceConnections,
  peekVoiceTransmittingTalker,
} from "./voiceRelay.js";
import { backfillAiDispatchActivityLog, configureAiDispatchEngine } from "./aiDispatch/engine.js";
import { startDispatchWatchdog } from "./aiDispatch/dispatchWatchdog.js";
import { getAiDispatchPlatformStatus } from "./aiDispatch/platformConfig.js";
import { scheduleAllAgencyTtsPrecache } from "./aiDispatch/ttsPrecache.js";
import { getTranscriptionDiagnostics } from "./transcribe.js";
import { getEmbeddingDiagnostics, warmEmbeddings } from "./aiDispatch/knowledgeBase/embeddings.js";
import { recoverPendingKbIngests } from "./aiDispatch/knowledgeBase/ingest.js";
import { startBridgeWorker } from "./bridgeWorker.js";
import { runDataRetentionSweeps } from "./dataRetention.js";
import { runTrialBillingSweep } from "./billing/trialSweep.js";
import { handleStripeWebhook } from "./billing/webhooks.js";

/** How often retention DELETE sweeps run (~10 min). */
const DATA_RETENTION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Knowledge-base retrieval is on unless explicitly disabled (mirrors KB_ENABLED in retrieve.ts). */
const KB_ENABLED = (process.env.KB_ENABLED ?? "on").trim().toLowerCase() !== "off";

const app = express();
// Tiny info-leak (and a few free bytes per response) — Express ships this header by default.
app.disable("x-powered-by");
// Behind Railway / Cloudflare / any reverse proxy, `req.ip`, `req.protocol`, and `req.hostname`
// otherwise reflect the upstream proxy IP/scheme instead of the real client. clientIp() already
// parses X-Forwarded-For manually, but downstream code (req.secure, req.hostname, future rate
// limiters) wants Express's built-ins to be correct too. "trust proxy: true" honors X-Forwarded-*
// from any upstream — fine on Railway where the only ingress is the LB.
app.set("trust proxy", true);
// Lightweight security headers — no extra dep, just static response headers on every reply.
// X-Content-Type-Options stops browsers from MIME-sniffing a JSON response as HTML/JS.
// X-Frame-Options blocks embedding the console in an iframe (cheap clickjacking guard).
// Referrer-Policy keeps the URL out of cross-origin Referer headers (no tokens leak in URLs).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
// HSTS — Railway is HTTPS-always, so tell browsers to refuse plaintext for a year. Skip in dev
// where the operator might hit localhost over plain HTTP.
if (process.env.NODE_ENV === "production") {
  app.use((_req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
}
// gzip every response above ~1 KB (default threshold). Most of what's served is JSON state polls
// and the Vite bundle — both compress ~70-80 %, which is real money on Railway egress + faster
// page loads. Excludes the voice WebSocket path (handled outside Express).
app.use(compression());
// Stripe webhook needs the raw body for signature verification — register before express.json().
app.post("/v1/billing/webhook", raw({ type: "application/json" }), (req, res) => {
  void handleStripeWebhook(req, res);
});
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
  // Strip a trailing slash so `/v1/channels/` matches the same handler as `/v1/channels` —
  // otherwise a hand-typed trailing slash would skip the agency-resolution middleware entirely
  // and the downstream handler would see a missing `req.agency`.
  const normalizedPath = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  if (!LEGACY_RADIO_PATHS.has(normalizedPath)) {
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
  const ai = getAiDispatchPlatformStatus();
  const tx = getTranscriptionDiagnostics();
  const ok =
    tx.database_configured &&
    (!tx.enabled || tx.state === "ready" || tx.state === "loading" || tx.queue_depth === 0);
  res.json({
    status: ok ? "ok" : "degraded",
    service: "safet-ptt-api",
    database: tx.database_configured,
    transcription: tx,
    ai_dispatch: {
      enabled: ai.enabled,
      llm_configured: ai.llmConfigured,
      provider: ai.llmProvider,
    },
    knowledge_base: { enabled: KB_ENABLED, embeddings: getEmbeddingDiagnostics() },
  });
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
    /** When true, the keyed station is a bridge/AI that yields — handsets may talk over. */
    transmitting_yields: talker?.yields ?? false,
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
  app.use(
    express.static(webDist, {
      // Vite emits content-hashed filenames into /assets — safe to cache forever, so the browser
      // stops re-downloading the bundle on every navigation. index.html itself stays at the
      // express.static default (no Cache-Control) so the SPA shell is always fresh and can
      // point at the latest /assets hashes.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${"/"}assets${"/"}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
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
  void initServerCodec2();
  void initServerOpus();
  void initServerAmbe();
  // Load the KB embedding model in the background so the first retrieval at
  // dispatch time isn't stuck waiting on a cold load, and re-queue any documents
  // left mid-ingest by a previous crash/restart.
  if (KB_ENABLED) {
    warmEmbeddings();
    void recoverPendingKbIngests();
  }
  void (async () => {
    try {
      const { warmAiDispatchChannelCache } = await import("./aiDispatch/channelCache.js");
      const { listAllChannelAiDispatchEnabledRows } = await import("./store.js");
      warmAiDispatchChannelCache(await listAllChannelAiDispatchEnabledRows());
    } catch (e) {
      console.warn("[ai-dispatch] channel cache warm failed", e);
    }
  })();

  // Rolling retention sweeps (telemetry, webhook debug log, AI activity log, optional transmissions).
  void runDataRetentionSweeps().catch((e) => {
    console.warn("[data-retention] initial sweep failed", e);
  });
  setInterval(() => {
    void runDataRetentionSweeps().catch((e) => {
      console.warn("[data-retention] periodic sweep failed", e);
    });
  }, DATA_RETENTION_SWEEP_INTERVAL_MS).unref();

  void runTrialBillingSweep().catch((e) => {
    console.warn("[billing] initial trial sweep failed", e);
  });
  const TRIAL_SWEEP_MS = 60 * 60 * 1000;
  setInterval(() => {
    void runTrialBillingSweep().catch((e) => {
      console.warn("[billing] periodic trial sweep failed", e);
    });
  }, TRIAL_SWEEP_MS).unref();

  const server = createServer(app);
  // Match an upstream LB / edge proxy's idle timeout (Railway / Cloudflare default ~60 s).
  // Node's default keepAliveTimeout is 5 s — too short to let a connection survive between LB
  // reuses, which surfaces as spurious 502s. headersTimeout must be strictly greater so an
  // already-active connection has time to finish reading request headers.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
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
    configureAiDispatchEngine({ port });
    startDispatchWatchdog();
    void scheduleAllAgencyTtsPrecache();
    setTimeout(() => void backfillAiDispatchActivityLog(), 15_000);
    startBridgeWorker({ port });
  });

  /**
   * Graceful shutdown so a Railway redeploy doesn't drop voice mid-frame:
   *   1. Close every voice WS with code 1001 — Android + console reconnect logic treats this as
   *      a transient drop and retries, instead of seeing a TCP reset.
   *   2. Stop accepting new HTTP / WS connections.
   *   3. Give in-flight HTTP requests up to 10 s to finish, then force-exit.
   */
  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, draining for graceful shutdown`);
    const closedSockets = closeAllVoiceConnections();
    console.log(`Closed ${closedSockets} voice socket(s) with code 1001`);
    server.close((err) => {
      if (err) console.error("server.close error", err);
      process.exit(0);
    });
    setTimeout(() => {
      console.warn("Shutdown drain timed out; forcing exit");
      process.exit(0);
    }, 10_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
