import { getPool } from "../db.js";
import { resolveElevenLabsApiKey } from "./elevenLabsCreds.js";
import { buildPrecachePhraseList, normalizeForTtsPrecache } from "./speech/precachePhrases.js";
import { synthesizeElevenLabsMp3 } from "./tts.js";

const PRECACHE_CONCURRENCY = 3;
const PRECACHE_STARTUP_DELAY_MS = 5000;

type PrecacheEntry = { buffer: Buffer; generatedMs: number };

const cacheByAgency = new Map<number, Map<string, PrecacheEntry>>();
const scheduledAgencies = new Set<number>();

export function getTtsPrecacheHit(agencyId: number, text: string): Buffer | null {
  const key = normalizeForTtsPrecache(text);
  const hit = cacheByAgency.get(agencyId)?.get(key);
  return hit?.buffer ?? null;
}

async function precachePhrase(agencyId: number, phrase: string): Promise<void> {
  const key = normalizeForTtsPrecache(phrase);
  const t0 = Date.now();
  const buf = await synthesizeElevenLabsMp3(agencyId, phrase, {
    skipPrecache: true,
    profile: "expressive",
    speechKind: "radio_ack",
  });
  if (!buf || buf.length === 0) {
    return;
  }
  let agencyCache = cacheByAgency.get(agencyId);
  if (!agencyCache) {
    agencyCache = new Map();
    cacheByAgency.set(agencyId, agencyCache);
  }
  agencyCache.set(key, { buffer: buf, generatedMs: Date.now() - t0 });
}

async function runPrecacheJob(agencyId: number): Promise<void> {
  const apiKey = await resolveElevenLabsApiKey(agencyId);
  if (!apiKey?.trim()) {
    return;
  }
  const phrases = buildPrecachePhraseList();
  console.log(`[tts-precache] agency=${agencyId} starting ${phrases.length} phrases`);
  const queue = [...phrases];
  const workers = Array.from({ length: PRECACHE_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const phrase = queue.shift();
      if (!phrase) {
        break;
      }
      await precachePhrase(agencyId, phrase);
    }
  });
  await Promise.all(workers);
  const cached = cacheByAgency.get(agencyId)?.size ?? 0;
  console.log(`[tts-precache] agency=${agencyId} complete: ${cached} cached`);
}

export function scheduleAgencyTtsPrecache(agencyId: number): void {
  if (scheduledAgencies.has(agencyId)) {
    return;
  }
  scheduledAgencies.add(agencyId);
  setTimeout(() => {
    void runPrecacheJob(agencyId).catch((e) => {
      console.warn(`[tts-precache] agency=${agencyId} failed`, e);
    });
  }, PRECACHE_STARTUP_DELAY_MS);
}

export async function scheduleAllAgencyTtsPrecache(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    return;
  }
  const res = await pool.query<{ agency_id: number }>(
    `SELECT DISTINCT agency_id
     FROM agency_integrations
     WHERE integration_key = 'elevenlabs_api_key'
       AND value IS NOT NULL
       AND trim(value) <> '';`,
  );
  for (const row of res.rows) {
    scheduleAgencyTtsPrecache(row.agency_id);
  }
}
