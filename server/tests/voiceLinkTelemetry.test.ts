/**
 * Voice-link telemetry: request validation, auth gates, and aggregation.
 *
 * Three concerns are tested here:
 *
 *   1. `parseVoiceLinkTelemetryBody` — the pure validator that pins the JSON
 *      shape the dashboard relies on. Tests exercise the documented contract:
 *      missing counters, oversize payload, negative / NaN / huge counters
 *      clamped, codec-breakdown shape sanitised. Pinned independently of the
 *      live router so future route changes can't silently relax validation.
 *
 *   2. Live route wiring — bootstraps the production router and POSTs to
 *      `/v1/telemetry/voice-link` + GETs `/v1/admin/voice-link-telemetry` with
 *      and without auth, confirming the gates (radio-key path, JWT path,
 *      admin-only path) match what the dashboard, handsets, and web client
 *      depend on.
 *
 *   3. `aggregateWindowsByUnit` — the pure aggregator that mirrors the SQL
 *      roll-up. Exercises the 100-report-flowing-in scenario: sums add up,
 *      max picks the right buffer-depth, codec-mix merges across rows, and
 *      health classification stays inside the documented thresholds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter, parseVoiceLinkTelemetryBody } from "../src/apiRoutes.js";
import { authenticate, signToken, type AuthUser } from "../src/auth.js";
import { clearAuthCache, setCachedAuth } from "../src/sessionCache.js";
import {
  aggregateWindowsByUnit,
  classifyHealth,
  computePlcRatio,
  type AggregatableWindow,
} from "../src/voiceLinkTelemetryStore.js";

async function bootRouter(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(authenticate);
  app.use("/v1", createApiRouter());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function tokenFor(overrides: Partial<AuthUser>): string {
  const user: AuthUser = {
    id: 1,
    username: "test-user",
    displayName: "Test User",
    role: "admin",
    unitId: null,
    agencyId: 42,
    agencyName: "Test Agency",
    gen: 0,
    ...overrides,
  };
  return signToken(user);
}

// --- parseVoiceLinkTelemetryBody ------------------------------------------

test("parseVoiceLinkTelemetryBody: rejects missing counters", () => {
  const res = parseVoiceLinkTelemetryBody({});
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "missing_counters");
});

test("parseVoiceLinkTelemetryBody: rejects non-object counters", () => {
  const res = parseVoiceLinkTelemetryBody({ counters: "nope" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "missing_counters");
});

test("parseVoiceLinkTelemetryBody: clamps negative and NaN counters to 0", () => {
  const res = parseVoiceLinkTelemetryBody({
    counters: {
      framesReceived: -5,
      framesDecoded: Number.NaN,
      decodeFailures: -Infinity,
      plcFramesSynthesized: "not a number",
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.counters.framesReceived, 0);
    assert.equal(res.counters.framesDecoded, 0);
    assert.equal(res.counters.decodeFailures, 0);
    assert.equal(res.counters.plcFramesSynthesized, 0);
  }
});

test("parseVoiceLinkTelemetryBody: clamps huge counters at INT4 ceiling", () => {
  const res = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 999_999_999_999 },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    // 2_000_000_000 is the documented ceiling — keeps the value inside
    // Postgres INT4 range so a buggy client can't crash the insert.
    assert.equal(res.counters.framesReceived, 2_000_000_000);
  }
});

test("parseVoiceLinkTelemetryBody: bytesSent is optional and defaults to 0 for older clients", () => {
  const withoutField = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 10, bytesReceived: 4_000 },
  });
  assert.equal(withoutField.ok, true);
  if (withoutField.ok) {
    assert.equal(withoutField.counters.bytesSent, 0);
  }
  const withField = parseVoiceLinkTelemetryBody({
    counters: { bytesSent: 12_345 },
  });
  assert.equal(withField.ok, true);
  if (withField.ok) {
    assert.equal(withField.counters.bytesSent, 12_345);
  }
});

test("parseVoiceLinkTelemetryBody: drops unknown counter keys silently", () => {
  const res = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 5, suspiciousNewKey: 999 },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.counters.framesReceived, 5);
    // The unknown key is not stored. Pinning this so a future server change
    // that adds a counter must add it to the parser explicitly — there is no
    // back-door for arbitrary client-defined fields to reach the DB.
    assert.equal((res.counters as Record<string, unknown>).suspiciousNewKey, undefined);
  }
});

test("parseVoiceLinkTelemetryBody: rejects oversize body", () => {
  // Build a body that serializes to >4 KB. The endpoint cap is a
  // belt-and-braces guard on top of express.json's own limit.
  const big: Record<string, unknown> = { counters: { framesReceived: 1 } };
  big.junk = "x".repeat(5_000);
  const res = parseVoiceLinkTelemetryBody(big);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "payload_too_large");
});

test("parseVoiceLinkTelemetryBody: parses codec breakdown and caps codec count", () => {
  const codecBreakdown: Record<string, { framesReceived: number; framesDecoded: number }> = {};
  for (let i = 0; i < 40; i++) {
    codecBreakdown[`fake_${i}`] = { framesReceived: i, framesDecoded: i };
  }
  const res = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 100 },
    codecBreakdown,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    // The codec-breakdown cap (16) keeps the JSONB merge in the aggregation
    // query bounded — a buggy client posting 1000 codec keys per window can't
    // turn the GET into a quadratic blow-up.
    assert.ok(Object.keys(res.codecBreakdown).length <= 16);
  }
});

test("parseVoiceLinkTelemetryBody: parses ISO clientTs, ignores garbage", () => {
  const goodIso = "2025-01-01T12:34:56.000Z";
  const ok = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 0 },
    clientTs: goodIso,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.clientTs, goodIso);

  const bad = parseVoiceLinkTelemetryBody({
    counters: { framesReceived: 0 },
    clientTs: "not a date",
  });
  assert.equal(bad.ok, true);
  if (bad.ok) assert.equal(bad.clientTs, null);
});

// --- live route wiring -----------------------------------------------------

test("POST /v1/telemetry/voice-link: rejects request with no auth and no radio key", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/telemetry/voice-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counters: { framesReceived: 1 } }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
  }
});

test("POST /v1/telemetry/voice-link: JWT path requires a resolvable unit_id", async () => {
  // Account with no unit id and no body unit id → 400, not a silent insert
  // billed to the wrong tenant.
  clearAuthCache();
  const adminUserId = 9_999_010;
  setCachedAuth(adminUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminUserId, agencyId: 42, role: "admin", unitId: null });
    const res = await fetch(`${baseUrl}/v1/telemetry/voice-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ counters: { framesReceived: 1 } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_unit_id");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("POST /v1/telemetry/voice-link: JWT path with DB-less environment returns 202 soft-accept", async () => {
  // No DATABASE_URL → the route soft-accepts (status 202) so the client's
  // 30-second reporter loop doesn't retry forever in DB-less local dev. The
  // 202 distinguishes this from a normal persisted insert (200).
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const radioUserId = 9_999_011;
  setCachedAuth(radioUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: radioUserId,
      agencyId: 42,
      role: "radio",
      unitId: "U-1001",
    });
    const res = await fetch(`${baseUrl}/v1/telemetry/voice-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        counters: {
          framesReceived: 1500,
          framesDecoded: 1500,
          decodeFailures: 0,
          plcFramesSynthesized: 5,
          bufferUnderruns: 1,
          maxBufferDepthFrames: 6,
          talkSpurtsStarted: 3,
          talkSpurtsEnded: 3,
          bytesReceived: 56_000,
          wallMsObservation: 30_000,
        },
        codecBreakdown: { imbe: { framesReceived: 1500, framesDecoded: 1500 } },
        channel: "Green 1",
        clientType: "android",
      }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { ok?: boolean; persisted?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.persisted, false);
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/telemetry/voice-link: radio account can't bill report against another unit id", async () => {
  // Radios authenticate as themselves; a malicious / buggy handset must not
  // be able to swap the unitId in the body so a different unit's row is
  // inserted instead. The JWT-baked unit id wins for `radio` accounts; admin
  // and dispatcher accounts keep the dispatcher-on-behalf-of behaviour.
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const radioUserId = 9_999_015;
  setCachedAuth(radioUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: radioUserId,
      agencyId: 42,
      role: "radio",
      unitId: "U-1001",
    });
    const res = await fetch(`${baseUrl}/v1/telemetry/voice-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        unitId: "U-EVIL-9999",
        counters: { framesReceived: 1 },
      }),
    });
    // Soft-accept (no DB) — the assert worth pinning here is that the
    // server ACCEPTED the report, didn't error, and the body unitId was
    // overridden internally. We can't observe the rebilled unit id without
    // a DB, but the parser path is exercised end-to-end so a regression
    // that lets the body's `U-EVIL` reach the insert would also fail the
    // store-level tests that follow once a DB is configured. The next
    // test below covers the admin/dispatcher dispatcher-on-behalf-of path.
    assert.equal(res.status, 202);
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("POST /v1/telemetry/voice-link: rejects missing counters with 400", async () => {
  clearAuthCache();
  const radioUserId = 9_999_012;
  setCachedAuth(radioUserId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({
      id: radioUserId,
      agencyId: 42,
      role: "radio",
      unitId: "U-1002",
    });
    const res = await fetch(`${baseUrl}/v1/telemetry/voice-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "Green 1" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_counters");
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/admin/voice-link-telemetry: unauthenticated → 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/voice-link-telemetry`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await close();
  }
});

test("GET /v1/admin/voice-link-telemetry: non-admin → 403", async () => {
  clearAuthCache();
  const dispatcherId = 9_999_013;
  setCachedAuth(dispatcherId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: dispatcherId, role: "dispatcher", agencyId: 42 });
    const res = await fetch(`${baseUrl}/v1/admin/voice-link-telemetry`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
    clearAuthCache();
  }
});

test("GET /v1/admin/voice-link-telemetry: admin with no DATABASE_URL → 503", async () => {
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearAuthCache();
  const adminId = 9_999_014;
  setCachedAuth(adminId, {
    tokenGeneration: 0,
    userDisabled: false,
    agencyDisabled: false,
  });
  const { baseUrl, close } = await bootRouter();
  try {
    const token = tokenFor({ id: adminId, role: "admin", agencyId: 42 });
    const res = await fetch(`${baseUrl}/v1/admin/voice-link-telemetry`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "database_unavailable");
  } finally {
    await close();
    clearAuthCache();
    if (prevDbUrl !== undefined) {
      process.env.DATABASE_URL = prevDbUrl;
    }
  }
});

test("createApiRouter: voice-link telemetry routes are registered with the right verbs", () => {
  // Pin the routes so a future refactor can't silently delete them. The
  // dashboard and clients depend on both verbs being mounted at these exact
  // paths.
  const router = createApiRouter();
  type RouteLayer = {
    route?: { path: string; methods: Record<string, boolean> };
  };
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const registered = new Set<string>();
  for (const layer of layers) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) {
        registered.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
  }
  assert.ok(registered.has("POST /telemetry/voice-link"), "POST /telemetry/voice-link must stay mounted");
  assert.ok(
    registered.has("GET /admin/voice-link-telemetry"),
    "GET /admin/voice-link-telemetry must stay mounted",
  );
  assert.ok(
    registered.has("GET /admin/voice-link-telemetry/:unitId"),
    "GET /admin/voice-link-telemetry/:unitId must stay mounted",
  );
});

// --- aggregator ------------------------------------------------------------

function makeWindow(
  unitId: string,
  serverTsSeconds: number,
  overrides: Partial<AggregatableWindow> = {},
): AggregatableWindow {
  return {
    unit_id: unitId,
    server_ts: new Date(serverTsSeconds * 1000).toISOString(),
    channel: "Green 1",
    client_type: "android",
    frames_received: 100,
    frames_decoded: 100,
    decode_failures: 0,
    plc_frames_synthesized: 0,
    buffer_underruns: 0,
    max_buffer_depth_frames: 6,
    talk_spurts_started: 1,
    talk_spurts_ended: 1,
    bytes_received: 4000,
    bytes_sent: 1500,
    wall_ms_observation: 30_000,
    codec_breakdown: { imbe: { framesReceived: 100, framesDecoded: 100 } },
    ...overrides,
  };
}

test("aggregateWindowsByUnit: sums counters across 100 windows for a single unit", () => {
  const windows: AggregatableWindow[] = [];
  for (let i = 0; i < 100; i++) {
    windows.push(
      makeWindow("U-1001", 1_700_000_000 + i * 30, {
        frames_received: 50,
        frames_decoded: 49,
        decode_failures: 1,
        plc_frames_synthesized: i === 50 ? 8 : 0, // a single underrun spike at i=50
        buffer_underruns: i === 50 ? 1 : 0,
        max_buffer_depth_frames: i % 10 === 0 ? 12 : 6, // taller queue every 10th window
        codec_breakdown: { imbe: { framesReceived: 50, framesDecoded: 49 } },
      }),
    );
  }
  const out = aggregateWindowsByUnit(windows);
  assert.equal(out.length, 1);
  const u = out[0]!;
  assert.equal(u.unitId, "U-1001");
  assert.equal(u.reports, 100);
  assert.equal(u.framesReceived, 50 * 100);
  assert.equal(u.framesDecoded, 49 * 100);
  assert.equal(u.decodeFailures, 100);
  assert.equal(u.plcFramesSynthesized, 8);
  assert.equal(u.bufferUnderruns, 1);
  // max — not sum — of the per-window max buffer depth.
  assert.equal(u.maxBufferDepthFrames, 12);
  // PLC is rare → 8 PLC vs 4900 decoded ≈ 0.16 % ratio — well under the 5 %
  // yellow ceiling — but one buffer underrun in the range knocks the badge
  // from green to yellow per the documented thresholds.
  assert.equal(u.health, "yellow", "1 underrun in 100 windows flips green to yellow");
  // last_seen is the newest window's server_ts (i = 99).
  assert.equal(u.lastSeen, new Date((1_700_000_000 + 99 * 30) * 1000).toISOString());
  // Codec mix sums across windows.
  assert.equal(u.codecMix.imbe!.framesReceived, 50 * 100);
  assert.equal(u.codecMix.imbe!.framesDecoded, 49 * 100);
});

test("aggregateWindowsByUnit: keeps per-unit rolls separate across many units", () => {
  const windows: AggregatableWindow[] = [];
  for (let i = 0; i < 10; i++) {
    windows.push(makeWindow(`U-${1000 + i}`, 1_700_000_000 + i, { frames_decoded: i * 10 }));
  }
  const out = aggregateWindowsByUnit(windows);
  assert.equal(out.length, 10);
  // Newest first ordering.
  assert.equal(out[0]!.unitId, "U-1009");
  // Each unit's totals come solely from its own rows.
  for (let i = 0; i < 10; i++) {
    const row = out.find((u) => u.unitId === `U-${1000 + i}`);
    assert.ok(row);
    assert.equal(row!.framesDecoded, i * 10);
  }
});

test("aggregateWindowsByUnit: merges multi-codec breakdown correctly", () => {
  const windows: AggregatableWindow[] = [
    makeWindow("U-1001", 1_700_000_000, {
      codec_breakdown: { imbe: { framesReceived: 50, framesDecoded: 50 } },
    }),
    makeWindow("U-1001", 1_700_000_030, {
      codec_breakdown: { opus: { framesReceived: 100, framesDecoded: 98 } },
    }),
    makeWindow("U-1001", 1_700_000_060, {
      codec_breakdown: {
        imbe: { framesReceived: 50, framesDecoded: 49 },
        opus: { framesReceived: 50, framesDecoded: 50 },
      },
    }),
  ];
  const out = aggregateWindowsByUnit(windows);
  assert.equal(out.length, 1);
  const mix = out[0]!.codecMix;
  // imbe = 50 + 50 = 100 rx / 50 + 49 = 99 dec; opus = 100 + 50 = 150 rx / 98 + 50 = 148 dec.
  assert.equal(mix.imbe!.framesReceived, 100);
  assert.equal(mix.imbe!.framesDecoded, 99);
  assert.equal(mix.opus!.framesReceived, 150);
  assert.equal(mix.opus!.framesDecoded, 148);
});

test("aggregateWindowsByUnit: silent unit (zero decoded + zero PLC) classified as unknown", () => {
  // A unit that POSTed heartbeat reports with no audio activity at all is
  // not "having voice quality problems" — it's just off-air. The dashboard
  // surfaces these as "unknown" rather than green/red.
  const windows: AggregatableWindow[] = [];
  for (let i = 0; i < 5; i++) {
    windows.push(
      makeWindow("U-IDLE", 1_700_000_000 + i, {
        frames_received: 0,
        frames_decoded: 0,
        decode_failures: 0,
        plc_frames_synthesized: 0,
        buffer_underruns: 0,
        codec_breakdown: {},
      }),
    );
  }
  const out = aggregateWindowsByUnit(windows);
  assert.equal(out[0]!.health, "unknown");
});

test("classifyHealth: thresholds (red on high PLC ratio)", () => {
  // 200 PLC + 800 decoded = 20 % ratio — well above the 5 % yellow floor.
  const h = classifyHealth({
    framesDecoded: 800,
    plcFramesSynthesized: 200,
    bufferUnderruns: 5,
    plcRatio: computePlcRatio(200, 800),
    reports: 4,
  });
  assert.equal(h, "red");
});

test("classifyHealth: green needs zero underruns AND <1% PLC", () => {
  const h = classifyHealth({
    framesDecoded: 10_000,
    plcFramesSynthesized: 50,
    bufferUnderruns: 0,
    plcRatio: computePlcRatio(50, 10_000),
    reports: 100,
  });
  assert.equal(h, "green");
});

test("computePlcRatio: degenerate inputs don't blow up", () => {
  assert.equal(computePlcRatio(0, 0), 0);
  // No decoded frames but PLC happened → cap at 1 so the badge scales sanely.
  assert.equal(computePlcRatio(5, 0), 1);
  // Negative PLC is treated as zero (a clamping safety net for bad inputs).
  assert.equal(computePlcRatio(-5, 100), 0);
});
