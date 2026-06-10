import { getPool } from "../db.js";
import { updateAgencyBilling } from "../store.js";
/**
 * Disables agencies whose local trial has expired and who have not converted to
 * a paid Stripe subscription. Runs hourly from index.ts.
 */
export async function runTrialBillingSweep(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    return;
  }

  const res = await pool.query<{ id: number }>(
    `SELECT id FROM agencies
      WHERE subscription_status = 'trialing'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < now()
        AND stripe_subscription_id IS NULL
        AND disabled = FALSE;`,
  );

  for (const row of res.rows) {
    await updateAgencyBilling(row.id, {
      disabled: true,
      subscriptionStatus: "canceled",
    });
    console.log(`[billing] trial expired — disabled agency id=${row.id}`);
  }
}
