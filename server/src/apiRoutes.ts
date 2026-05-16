import { Router } from "express";
import type { Request, Response } from "express";
import { requireAdmin, requireAuth, signToken, verifyPassword, type AuthUser, type Role } from "./auth.js";
import {
  countActiveAdmins,
  clearAlert,
  clearEmergenciesFromUnit,
  createAlert,
  listAlerts,
  listInboxAlerts,
  listPositions,
  upsertPosition,
  createChannel,
  createUser,
  deleteChannel,
  deleteUser,
  getTransmissionAudio,
  getUserById,
  getUserByUsername,
  listAudit,
  listTransmissions,
  listChannels,
  listChannelsForUser,
  listMemberships,
  listUsers,
  PERMISSIONS,
  ROLES,
  removeMembership,
  renameChannel,
  setMembership,
  updateUser,
  writeAudit,
  type Permission,
} from "./store.js";

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "").trim();
}

function fail(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "database_unavailable") {
    res.status(503).json({ error: "database_unavailable" });
    return;
  }
  if ((error as { code?: string } | null)?.code === "23505") {
    res.status(409).json({ error: "duplicate" });
    return;
  }
  console.error("API error", error);
  res.status(500).json({ error: "server_error" });
}

function asRole(value: unknown): Role | null {
  return ROLES.includes(value as Role) ? (value as Role) : null;
}

function asPermission(value: unknown): Permission | null {
  return PERMISSIONS.includes(value as Permission) ? (value as Permission) : null;
}

/** Router for account/auth and admin endpoints, mounted at `/v1`. */
export function createApiRouter(): Router {
  const router = Router();

  // --- authentication ----------------------------------------------------

  router.post("/auth/login", async (req, res) => {
    try {
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!username || !password) {
        res.status(400).json({ error: "missing_credentials" });
        return;
      }
      const user = await getUserByUsername(username);
      if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
        await writeAudit({
          actorUserId: user?.id ?? null,
          actorName: username,
          action: "login_failed",
          ip: clientIp(req),
        });
        res.status(401).json({ error: "invalid_login" });
        return;
      }
      const authUser: AuthUser = {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        unitId: user.unit_id,
      };
      await writeAudit({ actorUserId: user.id, actorName: user.username, action: "login", ip: clientIp(req) });
      res.json({ token: signToken(authUser), user: authUser });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.authUser });
  });

  // --- channels the caller may use (console + radios) --------------------

  router.get("/me/channels", requireAuth, async (req, res) => {
    try {
      const me = req.authUser!;
      if (me.role === "admin" || me.role === "dispatcher") {
        const all = await listChannels();
        res.json({ channels: all.map((c) => ({ id: c.id, name: c.name, permission: "talk_priority" })) });
        return;
      }
      res.json({ channels: await listChannelsForUser(me.id) });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: accounts ---------------------------------------------------

  router.get("/admin/users", requireAdmin, async (_req, res) => {
    try {
      res.json({ users: await listUsers() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/users", requireAdmin, async (req, res) => {
    try {
      const username = String(req.body?.username ?? "").trim();
      const displayName = String(req.body?.displayName ?? "").trim() || username;
      const password = String(req.body?.password ?? "");
      const role = asRole(req.body?.role) ?? "radio";
      const unitId = req.body?.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      if (!username || !password) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      if (await getUserByUsername(username)) {
        res.status(409).json({ error: "username_taken" });
        return;
      }
      const user = await createUser({ username, displayName, password, role, unitId });
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_create",
        target: username,
        detail: { role, unitId },
        ip: clientIp(req),
      });
      res.status(201).json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getUserById(id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const patch: { displayName?: string; role?: Role; unitId?: string | null; disabled?: boolean; password?: string } = {};
      if (req.body?.displayName !== undefined) patch.displayName = String(req.body.displayName);
      if (req.body?.role !== undefined) {
        const role = asRole(req.body.role);
        if (!role) {
          res.status(400).json({ error: "bad_role" });
          return;
        }
        patch.role = role;
      }
      if (req.body?.unitId !== undefined) {
        patch.unitId = req.body.unitId ? String(req.body.unitId).trim().toUpperCase() : null;
      }
      if (req.body?.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
      if (req.body?.password) patch.password = String(req.body.password);

      const demotesAdmin = existing.role === "admin" && patch.role !== undefined && patch.role !== "admin";
      const disablesAdmin = existing.role === "admin" && patch.disabled === true;
      if ((demotesAdmin || disablesAdmin) && (await countActiveAdmins()) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }

      const user = await updateUser(id, patch);
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_update",
        target: existing.username,
        detail: { fields: Object.keys(patch) },
        ip: clientIp(req),
      });
      res.json({ user });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getUserById(id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (existing.id === req.authUser!.id) {
        res.status(409).json({ error: "cannot_delete_self" });
        return;
      }
      if (existing.role === "admin" && (await countActiveAdmins()) <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
      await deleteUser(id);
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "user_delete",
        target: existing.username,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: channels ---------------------------------------------------

  router.get("/admin/channels", requireAdmin, async (_req, res) => {
    try {
      res.json({ channels: await listChannels() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/admin/channels", requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      const channel = await createChannel(name);
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_create",
        target: name,
        ip: clientIp(req),
      });
      res.status(201).json({ channel });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/admin/channels/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      const channel = await renameChannel(id, name);
      if (!channel) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_rename",
        target: name,
        detail: { id },
        ip: clientIp(req),
      });
      res.json({ channel });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/channels/:id", requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const ok = await deleteChannel(id);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "channel_delete",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: channel assignments / permissions --------------------------

  router.get("/admin/memberships", requireAdmin, async (_req, res) => {
    try {
      res.json({ memberships: await listMemberships() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put("/admin/memberships", requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.body?.userId);
      const channelId = Number(req.body?.channelId);
      const permission = asPermission(req.body?.permission);
      if (!Number.isFinite(userId) || !Number.isFinite(channelId) || !permission) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      await setMembership(userId, channelId, permission);
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "membership_set",
        target: `user:${userId} channel:${channelId}`,
        detail: { permission },
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/admin/memberships", requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.query.userId);
      const channelId = Number(req.query.channelId);
      if (!Number.isFinite(userId) || !Number.isFinite(channelId)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const ok = await removeMembership(userId, channelId);
      await writeAudit({
        actorUserId: req.authUser!.id,
        actorName: req.authUser!.username,
        action: "membership_remove",
        target: `user:${userId} channel:${channelId}`,
        ip: clientIp(req),
      });
      res.json({ ok });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- admin: audit log --------------------------------------------------

  router.get("/admin/audit", requireAdmin, async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 200);
      res.json({ entries: await listAudit(Number.isFinite(limit) ? limit : 200) });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- transmissions (recorded audio + transcripts) ----------------------

  router.get("/transmissions", requireAuth, async (req, res) => {
    try {
      const me = req.authUser!;
      const limit = Number(req.query.limit ?? 100);
      if (me.role === "admin" || me.role === "dispatcher") {
        res.json({ transmissions: await listTransmissions({ limit }) });
        return;
      }
      const channels = await listChannelsForUser(me.id);
      res.json({
        transmissions: await listTransmissions({ channelNames: channels.map((c) => c.name), limit }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/transmissions/:id/audio", requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const record = await getTransmissionAudio(id);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.setHeader("Content-Type", record.mime);
      res.setHeader("Content-Disposition", `inline; filename="transmission-${id}.wav"`);
      res.send(record.audio);
    } catch (error) {
      fail(res, error);
    }
  });

  // --- radio endpoints (handsets, shared-key auth) -----------------------

  router.post("/radio/location", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unitId = String(body.unit_id ?? "").trim().toUpperCase();
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      if (!unitId || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      const optionalNumber = (value: unknown): number | null => {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };
      await upsertPosition({
        unitId,
        userId: req.authUser?.id ?? null,
        displayName: body.display_name ? String(body.display_name) : req.authUser?.displayName ?? null,
        channelName: body.channel ? String(body.channel) : null,
        lat,
        lon,
        accuracyM: optionalNumber(body.accuracy_m),
        heading: optionalNumber(body.heading),
        speedMps: optionalNumber(body.speed_mps),
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/radio/inbox", async (req, res) => {
    try {
      const unit = String(req.query.unit ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      const channel = req.query.channel ? String(req.query.channel) : null;
      const since = Number(req.query.since ?? 0);
      const alerts = await listInboxAlerts(unit, channel, Number.isFinite(since) ? since : 0);
      const lastId = alerts.length > 0 ? alerts[alerts.length - 1]!.id : Number.isFinite(since) ? since : 0;
      res.json({ alerts, lastId });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/radio/emergency", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const unit = String(body.unit_id ?? "").trim().toUpperCase();
      if (!unit) {
        res.status(400).json({ error: "missing_unit" });
        return;
      }
      if (body.active === false) {
        const cleared = await clearEmergenciesFromUnit(unit, unit);
        res.json({ ok: true, cleared });
        return;
      }
      const alert = await createAlert({
        kind: "emergency",
        channelName: body.channel ? String(body.channel) : null,
        targetUnit: null,
        fromUserId: null,
        fromName: body.display_name ? String(body.display_name) : unit,
        fromUnit: unit,
        message: body.message ? String(body.message) : "Emergency activated",
      });
      res.status(201).json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- console: live map + alerts ----------------------------------------

  router.get("/locations", requireAuth, async (_req, res) => {
    try {
      res.json({ positions: await listPositions() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/alerts", requireAuth, async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      res.json({ alerts: await listAlerts(Number.isFinite(limit) ? limit : 100) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/alerts", requireAuth, async (req, res) => {
    try {
      const me = req.authUser!;
      const kind = req.body?.kind === "page" ? "page" : "emergency";
      if (kind === "page" && me.role !== "admin" && me.role !== "dispatcher") {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const channelName = req.body?.channelName ? String(req.body.channelName).trim() : null;
      const targetUnit = req.body?.targetUnit ? String(req.body.targetUnit).trim().toUpperCase() : null;
      const message = req.body?.message ? String(req.body.message).trim() : null;
      if (kind === "page" && !message) {
        res.status(400).json({ error: "missing_message" });
        return;
      }
      const alert = await createAlert({
        kind,
        channelName,
        targetUnit,
        fromUserId: me.id,
        fromName: me.displayName,
        fromUnit: me.unitId,
        message: message ?? (kind === "emergency" ? "Emergency" : null),
      });
      await writeAudit({
        actorUserId: me.id,
        actorName: me.username,
        action: `alert_${kind}`,
        target: channelName ?? targetUnit ?? "all channels",
        detail: { message },
        ip: clientIp(req),
      });
      res.status(201).json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/alerts/:id/clear", requireAuth, async (req, res) => {
    try {
      const me = req.authUser!;
      const id = Number(req.params.id);
      const alert = await clearAlert(id, me.displayName);
      if (!alert) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await writeAudit({
        actorUserId: me.id,
        actorName: me.username,
        action: "alert_clear",
        target: String(id),
        ip: clientIp(req),
      });
      res.json({ alert });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
