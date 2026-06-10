import crypto from "node:crypto";
import { requirePool } from "../db.js";
import {
  createAgencyWithAdmin,
  generateRadioKey,
  uniqueAgencySlug,
} from "../store.js";
import { sendVerificationEmail } from "./email.js";
import { createStripeCustomer } from "./stripe.js";
import { emailAlreadyUsedTrial, markTrialEmailUsed } from "./subscription.js";
import type { PlanTier } from "./types.js";
import { TRIAL_DAYS } from "./types.js";

const CODE_TTL_MS = 30 * 60 * 1000;

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

export async function requestSignupVerification(email: string): Promise<{ ok: true } | { error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { error: "invalid_email" };
  }
  if (await emailAlreadyUsedTrial(normalized)) {
    return { error: "trial_already_used" };
  }

  const code = generateCode();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await requirePool().query(
    `INSERT INTO signup_verifications (email, code_hash, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at;`,
    [normalized, hashCode(code), expires],
  );

  const sent = await sendVerificationEmail(normalized, code);
  if (!sent) {
    return { error: "email_send_failed" };
  }
  return { ok: true };
}

async function verifyCode(email: string, code: string): Promise<boolean> {
  const res = await requirePool().query<{ code_hash: string; expires_at: string }>(
    `SELECT code_hash, expires_at FROM signup_verifications WHERE email = $1;`,
    [email.trim().toLowerCase()],
  );
  const row = res.rows[0];
  if (!row) {
    return false;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return false;
  }
  return row.code_hash === hashCode(code.trim());
}

export async function completeSignup(input: {
  agencyName: string;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  email: string;
  verificationCode: string;
  planTier: PlanTier;
  acceptTerms: boolean;
}): Promise<
  | { ok: true; agencySlug: string; adminUsername: string }
  | { error: string }
> {
  if (!input.acceptTerms) {
    return { error: "terms_required" };
  }
  const email = input.email.trim().toLowerCase();
  if (!(await verifyCode(email, input.verificationCode))) {
    return { error: "invalid_verification_code" };
  }
  if (await emailAlreadyUsedTrial(email)) {
    return { error: "trial_already_used" };
  }

  const slug = await uniqueAgencySlug(input.agencyName);
  const radioKey = generateRadioKey();
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { agency, admin } = await createAgencyWithAdmin({
    name: input.agencyName,
    slug,
    radioKey,
    adminUsername: input.adminUsername,
    adminDisplayName: input.adminDisplayName,
    adminPassword: input.adminPassword,
    billing: {
      email,
      planTier: input.planTier,
      subscriptionStatus: "trialing",
      trialEndsAt: trialEnds,
      transmissionRetentionDays: 3,
      logsUnlimited: false,
      trialEmailUsed: true,
      signupCompletedAt: new Date().toISOString(),
    },
  });

  const customer = await createStripeCustomer({
    email,
    name: agency.name,
    agencyId: agency.id,
    metadata: { trial: "true" },
  });
  if (customer) {
    const { updateAgencyBilling } = await import("../store.js");
    await updateAgencyBilling(agency.id, { stripeCustomerId: customer.id });
  }

  await markTrialEmailUsed(email);
  await requirePool().query(`DELETE FROM signup_verifications WHERE email = $1;`, [email]);

  return { ok: true, agencySlug: agency.slug, adminUsername: admin.username };
}
