/**
 * Tests for the SSA shift-assignment integration.
 *
 * The SSA officer portal pushes a per-shift (radio → officer callsign + vehicle)
 * assignment into safeT-PTT. That assignment is applied at voice join so the
 * map, other radios, the recorder, and the AI dispatcher all attribute the
 * officer's callsign (e.g. "351") instead of the raw radio / vehicle number,
 * and it tags whether the radio is a car or a handheld.
 *
 * The DB-backed behaviour (the join override, the /locations overlay, the
 * transactional upsert) needs PostgreSQL and is exercised in integration; these
 * unit tests pin the parts that must hold WITHOUT a database:
 *
 *   1. `normalizeRadioKind` — the trust boundary between the portal's free-text
 *      `radio_kind` and the `car | handheld` allow-list the map badge relies on.
 *   2. Route wiring — the six new endpoints stay mounted with the right verbs so
 *      a refactor can't silently strand the portal or the admin key UI.
 *   3. Auth gates — the shift endpoints must reject anonymous callers, bogus
 *      keys, platform owners, and non-operator (radio) accounts, and the admin
 *      key endpoints must stay behind `requireAdmin`. A regression here would
 *      expose callsign rewriting to the wrong caller.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";

import { createApiRouter } from "../src/apiRoutes.js";
import { authenticate, signToken, type AuthUser } from "../src/auth.js";
import { clearAuthCache, setCachedAuth } from "../src/sessionCache.js";
import { normalizeRadioKind, RADIO_KINDS } from "../src/store.js";

// --- normalizeRadioKind -------------------------------------------------

test("normalizeRadioKind: canonical values round-trip", () => {
  for (const kind of RADIO_KINDS) {
    assert.equal(normalizeRadioKind(kind), kind);
  }
});

test("normalizeRadioKind: common synonyms fold to the right form-factor", () => {
  for (const car of ["car", "CAR", " Mobile ", "vehicle", "cruiser"]) {
    assert.equal(normalizeRadioKind(car), "car", `"${car}" should be a car`);
  }
  for (const ht of ["handheld", "Portable", "HT", "hand-held"]) {
    assert.equal(normalizeRadioKind(ht), "handheld", `"${ht}" should be a handheld`);
  }
});

test("normalizeRadioKind: unknown / empty values become null (never a garbage badge)", () => {
  for (const bad of ["", "  ", "truck", "drone", null, undefined, 42, {}]) {
    assert.equal(normalizeRadioKind(bad), null, `${JSON.stringify(bad)} should normalize to null`);
  }
});

// --- route wiring + auth gates ------------------------------------------

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
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
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

/** Seed the session cache so the router's account-enabled middleware doesn't hit Postgres. */
function seedSession(userId: number): void {
  setCachedAuth(userId, { tokenGeneration: 0, userDisabled: false, agencyDisabled: false });
}

test("SSA + admin shift-key routes stay registered with the expected verbs", () => {
  const router = createApiRouter();
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const registered = new Set<string>();
  for (const layer of layers) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) registered.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  for (const route of [
    "POST /ssa/shift",
    "POST /ssa/shift/end",
    "GET /ssa/shift",
    "GET /admin/shift-key",
    "POST /admin/shift-key",
    "DELETE /admin/shift-key",
  ]) {
    assert.ok(registered.has(route), `expected ${route} to be registered`);
  }
});

test("POST /v1/ssa/shift: rejects anonymous callers (no key, no token) with 401", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ radio_unit_id: "3351", officer_callsign: "351" }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error?: string }).error, "unauthorized");
  } finally {
    await close();
  }
});

test("POST /v1/ssa/shift: rejects a bogus shift key with 401", async () => {
  // With no database the key lookup throws; resolveShiftAgency swallows it and
  // treats the key as unknown — a caller must never get past auth on error.
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-safet-shift-key": "definitely-not-real" },
      body: JSON.stringify({ radio_unit_id: "3351", officer_callsign: "351" }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error?: string }).error, "unauthorized");
  } finally {
    await close();
  }
});

test("POST /v1/ssa/shift: rejects a radio-handset token with 403 (operators only)", async () => {
  // A handset's own JWT must never be able to rewrite callsigns from the portal
  // surface — only an agency admin/dispatcher (or the shift key) may.
  clearAuthCache();
  const radioUserId = 7_700_001;
  seedSession(radioUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenFor({ id: radioUserId, role: "radio" })}`,
      },
      body: JSON.stringify({ radio_unit_id: "3351", officer_callsign: "351" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error?: string }).error, "forbidden");
  } finally {
    await close();
  }
});

test("POST /v1/ssa/shift: rejects a platform-owner token (no agency) with 403", async () => {
  clearAuthCache();
  const ownerUserId = 7_700_002;
  seedSession(ownerUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenFor({ id: ownerUserId, role: "owner", agencyId: null })}`,
      },
      body: JSON.stringify({ radio_unit_id: "3351", officer_callsign: "351" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error?: string }).error, "forbidden");
  } finally {
    await close();
  }
});

test("POST /v1/ssa/shift: an operator with a missing body gets 400 before any DB call", async () => {
  clearAuthCache();
  const adminUserId = 7_700_003;
  seedSession(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenFor({ id: adminUserId, role: "admin" })}`,
      },
      body: JSON.stringify({ officer_callsign: "351" }), // radio_unit_id missing
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "missing_fields");
  } finally {
    await close();
  }
});

test("POST /v1/ssa/shift: a bad radio_kind is rejected with 400 before any DB call", async () => {
  clearAuthCache();
  const adminUserId = 7_700_004;
  seedSession(adminUserId);
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/ssa/shift`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenFor({ id: adminUserId, role: "admin" })}`,
      },
      body: JSON.stringify({ radio_unit_id: "3351", officer_callsign: "351", radio_kind: "spaceship" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error?: string }).error, "invalid_radio_kind");
  } finally {
    await close();
  }
});

test("GET /v1/admin/shift-key: requires an admin (401 without a token)", async () => {
  const { baseUrl, close } = await bootRouter();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/shift-key`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error?: string }).error, "unauthorized");
  } finally {
    await close();
  }
});
