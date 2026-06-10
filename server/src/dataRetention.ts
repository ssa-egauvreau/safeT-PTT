import { sweepAiDispatchLog } from "./aiDispatch/activityLog.js";
import { getPool } from "./db.js";
import { isPostgresDiskFullError } from "./postgresErrors.js";
import { sweepTransmissions, sweepTransmissionsPerAgency } from "./store.js";
import { sweepTen8WebhookLog } from "./ten8/store.js";
import { sweepVoiceLinkTelemetry } from "./voiceLinkTelemetryStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Debug webhook payloads — admin UI only shows the latest ~25 rows. */
const TEN8_WEBHOOK_LOG_RETENTION_MS = 30 * DAY_MS;
/** AI activity log — long enough for weekly triage, short enough to cap growth. */
const AI_DISPATCH_LOG_RETENTION_MS = 90 * DAY_MS;

function parseTransmissionRetentionDays(): number | null {
  const raw = process.env.TRANSMISSION_RETENTION_DAYS?.trim();
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return Math.min(3650, n);
}

/**
 * Periodic DELETE sweeps so Postgres tables do not grow without bound on small
 * Railway volumes. Idempotent — safe when multiple Node instances run it.
 */
export async function runDataRetentionSweeps(): Promise<void> {
  if (!getPool()) {
    return;
  }
  const sweeps: Array<{ name: string; run: () => Promise<number> }> = [
    {
      name: "voice_link_telemetry",
      run: () => sweepVoiceLinkTelemetry(7 * DAY_MS),
    },
    {
      name: "ten8_webhook_log",
      run: () => sweepTen8WebhookLog(TEN8_WEBHOOK_LOG_RETENTION_MS),
    },
    {
      name: "ai_dispatch_log",
      run: () => sweepAiDispatchLog(AI_DISPATCH_LOG_RETENTION_MS),
    },
  ];
  sweeps.push({
    name: "transmissions_per_agency",
    run: () => sweepTransmissionsPerAgency(),
  });
  const txDays = parseTransmissionRetentionDays();
  if (txDays != null) {
    sweeps.push({
      name: "transmissions_global",
      run: () => sweepTransmissions(txDays * DAY_MS),
    });
  }

  for (const { name, run } of sweeps) {
    try {
      const deleted = await run();
      if (deleted > 0) {
        console.log(`[data-retention] ${name}: deleted ${deleted} row(s)`);
      }
    } catch (error) {
      if (isPostgresDiskFullError(error)) {
        console.error(
          `[data-retention] ${name}: sweep failed — postgres disk full; free space on Railway`,
          error,
        );
        return;
      }
      console.warn(`[data-retention] ${name}: sweep failed`, error);
    }
  }
}
