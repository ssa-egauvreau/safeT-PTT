import type { Request, Response } from "express";
import { getPool } from "../db.js";
import { getAgencyBySlug, getAgencyIntegrationValue } from "../store.js";
import { upsertTen8Incident, insertTen8WebhookLog } from "./store.js";

function bearerToken(req: Request): string | null {
  const h = req.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  // 10-8 Systems' webhook config can't send custom headers, so also accept the shared secret as a
  // URL query param (?token= / ?secret= / ?key=) appended to the webhook URL. Sent over HTTPS.
  for (const key of ["token", "secret", "key"] as const) {
    const v = req.query[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

async function resolveWebhookAgency(req: Request): Promise<number | null> {
  const slug = String(req.query.agency ?? req.headers["x-safet-agency"] ?? "").trim().toLowerCase();
  if (slug) {
    const ag = await getAgencyBySlug(slug);
    return ag && !ag.disabled ? ag.id : null;
  }
  const envSlug = process.env.TEN8_WEBHOOK_AGENCY_SLUG?.trim();
  if (envSlug) {
    const ag = await getAgencyBySlug(envSlug);
    return ag && !ag.disabled ? ag.id : null;
  }
  return null;
}

async function verifyWebhookAuth(req: Request, agencyId: number): Promise<boolean> {
  const token = bearerToken(req);
  const global = process.env.TEN8_WEBHOOK_SECRET?.trim();
  if (global && token === global) {
    return true;
  }
  const perAgency = await getAgencyIntegrationValue(agencyId, "ten8_webhook_secret");
  if (perAgency?.trim() && token === perAgency.trim()) {
    return true;
  }
  // Explicit opt-in for 10-8 configs that cannot send any auth. Open to anyone who knows the URL
  // and agency slug, so it's off unless deliberately enabled (env var or per-agency setting).
  const allowOpenEnv = process.env.TEN8_WEBHOOK_ALLOW_UNAUTHENTICATED?.trim().toLowerCase();
  if (allowOpenEnv === "1" || allowOpenEnv === "true") {
    return true;
  }
  const allowOpenAgency = (
    await getAgencyIntegrationValue(agencyId, "ten8_webhook_allow_unauthenticated")
  )?.trim().toLowerCase();
  if (allowOpenAgency === "1" || allowOpenAgency === "true") {
    return true;
  }
  if (!global && !perAgency?.trim()) {
    return process.env.NODE_ENV !== "production";
  }
  return false;
}

export async function handleTen8Webhook(req: Request, res: Response): Promise<void> {
  if (!getPool()) {
    res.status(503).json({ error: "database_unavailable" });
    return;
  }
  const agencyId = await resolveWebhookAgency(req);
  if (agencyId == null) {
    res.status(400).json({ error: "unknown_agency", hint: "Add ?agency=your-agency-slug to the webhook URL" });
    return;
  }
  if (!(await verifyWebhookAuth(req, agencyId))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = String(body.action ?? "unknown");
  const incident = (body.incident ?? null) as Record<string, unknown> | null;
  const callId = incident ? String(incident.callID ?? incident.callId ?? "").trim() : "";

  await insertTen8WebhookLog({ agencyId, action, callId: callId || null, payload: body });

  if (callId) {
    const isClosed = Number(incident?.isClosed) === 1 || action === "closed";
    await upsertTen8Incident({
      agencyId,
      callId,
      action,
      isClosed,
      incidentType: incident?.type ? String(incident.type) : null,
      priority: incident?.priority ? String(incident.priority) : null,
      status: incident?.status ? String(incident.status) : null,
      location: incident?.location ? String(incident.location) : null,
      payload: body,
    });
  }

  res.json({ ok: true, callId: callId || null, action });
}

export async function handleTen8WebhookGet(_req: Request, res: Response): Promise<void> {
  res.json({
    ok: true,
    message:
      "10-8 webhook endpoint. POST JSON incident exports. Auth via Bearer header OR a ?token= query param matching TEN8_WEBHOOK_SECRET / ten8_webhook_secret.",
    url_hint: "POST /v1/webhooks/10-8?agency=YOUR_AGENCY_SLUG&token=YOUR_WEBHOOK_SECRET",
  });
}
