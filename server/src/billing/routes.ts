import { Router } from "express";
import type { Response } from "express";
import { requireAdmin, requireAuth } from "../auth.js";
import { getAgencyById } from "../store.js";
import { billingEnabled } from "./config.js";
import {
  changePlan,
  getBillingStatus,
  startCheckout,
  openBillingPortal,
} from "./subscription.js";
import { completeSignup, requestSignupVerification } from "./signup.js";
import type { PlanTier } from "./types.js";
import { PLAN_TIERS } from "./types.js";

function fail(res: Response, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg === "database_unavailable") {
    res.status(503).json({ error: "database_unavailable" });
    return;
  }
  console.error("[billing]", error);
  res.status(500).json({ error: "internal_error" });
}

export function createBillingRouter(): Router {
  const router = Router();

  router.post("/signup/verify-email", async (req, res) => {
    try {
      const email = String(req.body?.email ?? "").trim();
      const result = await requestSignupVerification(email);
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/signup", async (req, res) => {
    try {
      const body = req.body ?? {};
      const planRaw = String(body.plan_tier ?? "basic");
      const planTier = (PLAN_TIERS.includes(planRaw as PlanTier) ? planRaw : "basic") as PlanTier;
      const result = await completeSignup({
        agencyName: String(body.agency_name ?? "").trim(),
        adminUsername: String(body.admin_username ?? "").trim(),
        adminDisplayName: String(body.admin_display_name ?? "").trim() || String(body.admin_username ?? "").trim(),
        adminPassword: String(body.admin_password ?? ""),
        email: String(body.email ?? "").trim(),
        verificationCode: String(body.verification_code ?? "").trim(),
        planTier,
        acceptTerms: body.accept_terms === true,
      });
      if ("error" in result) {
        const status =
          result.error === "trial_already_used" || result.error === "invalid_verification_code"
            ? 400
            : 400;
        res.status(status).json({ error: result.error });
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/billing/status", requireAuth, requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId;
      if (agencyId == null) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const agency = await getAgencyById(agencyId);
      if (!agency) {
        res.status(404).json({ error: "agency_not_found" });
        return;
      }
      res.json(await getBillingStatus(agency));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/billing/checkout", requireAuth, requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId;
      if (agencyId == null) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const body = req.body ?? {};
      const planRaw = String(body.plan_tier ?? "basic");
      const planTier = (PLAN_TIERS.includes(planRaw as PlanTier) ? planRaw : "basic") as PlanTier;
      const logsUnlimited = body.logs_unlimited === true;
      const result = await startCheckout({
        agencyId,
        planTier,
        logsUnlimited,
        includeTrial: false,
      });
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/billing/portal", requireAuth, requireAdmin, async (req, res) => {
    try {
      const agencyId = req.authUser!.agencyId;
      if (agencyId == null) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const result = await openBillingPortal(agencyId);
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/billing/plan", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!billingEnabled()) {
        res.status(503).json({ error: "billing_not_configured" });
        return;
      }
      const agencyId = req.authUser!.agencyId;
      if (agencyId == null) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const body = req.body ?? {};
      const planRaw = String(body.plan_tier ?? "basic");
      const planTier = (PLAN_TIERS.includes(planRaw as PlanTier) ? planRaw : "basic") as PlanTier;
      const logsUnlimited = body.logs_unlimited === true;
      const result = await changePlan({ agencyId, planTier, logsUnlimited });
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
