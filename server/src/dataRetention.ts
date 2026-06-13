import { sweepAiDispatchLog } from "./aiDispatch/activityLog.js";
import { getPool } from "./db.js";
import { isPostgresDiskFullError } from "./postgresErrors.js";
import { sweepTransmissions, sweepTransmissionsPerAgency, expireStaleEmergencies } from "./store.js";
import { sweepTen8WebhookLog } from "./ten8/store.js";
import { sweepVoiceLinkTelemetry } from "./voiceLinkTelemetryStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * How long an unresolved emergency stays `active` before the periodic sweep
 * auto-clears it, from `EMERGENCY_AUTO_CLEAR_HOURS` (default 6 h). A handset that
 * crashes mid-emergency otherwise leaves a row that haunts every radio's status
 * line forever. Returns milliseconds, or `0` to disable (env `0` / `off`).
 * Exported for unit testing — a regression returning 0/NaN as "enabled" would
 * either disable the self-heal or hand a 0 ms window that clears live emergencies.
 */
export function parseEmergencyAutoClearMs(): number {
  const raw = process.env.EMERGENCY_AUTO_CLEAR_HOURS?.trim();
  if (raw === undefined || raw === "") {
    return 6 * HOUR_MS;
  }
  if (raw === "0" || raw.toLowerCase() === "off") {
    return 0; // explicitly disabled
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 6 * HOUR_MS;
  }
  // Cap at 30 days so a fat-fingered value can't effectively disable the sweep.
  return Math.min(n, 24 * 30) * HOUR_MS;
}

/** Debug webhook payloads — admin UI only shows the latest ~25 rows. */
const TEN8_WEBHOOK_LOG_RETENTION_MS = 30 * DAY_MS;
/** AI activity log — long enough for weekly triage, short enough to cap growth. */
const AI_DISPATCH_LOG_RETENTION_MS = 90 * DAY_MS;

/**
 * Parses `TRANSMISSION_RETENTION_DAYS` env var into an integer day count, or
 * `null` to mean "no global sweep". Exported for unit testing — a regression
 * that returns 0/NaN/negative as a finite number would hand a 0-day cutoff to
 * `sweepTransmissions` and erase the table on every cron tick.
 */
export function parseTransmissionRetentionDays(): number | null {
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

  // Emergency auto-expiry. Distinct from the DELETE sweeps above (it UPDATEs the
  // row's `active` flag, not deletes it), so it runs separately with its own
  // logging. Clears emergencies nobody resolved so a crashed/powered-off handset
  // can't strand "EMERGENCY <unit>" on every radio's display indefinitely.
  const emergencyMs = parseEmergencyAutoClearMs();
  if (emergencyMs > 0) {
    try {
      const cleared = await expireStaleEmergencies(emergencyMs);
      if (cleared > 0) {
        console.log(`[emergency-expiry] auto-cleared ${cleared} stale emergency alert(s)`);
      }
    } catch (error) {
      console.warn("[emergency-expiry] sweep failed", error);
    }
  }
}
