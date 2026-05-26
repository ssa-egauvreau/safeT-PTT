/**
 * In-process auth cache so the disabled-account / session-supersede check in
 * [createApiRouter]'s router-level middleware doesn't have to hit Postgres on every authenticated
 * request. At Android's poll cadence (AIR 250 ms, talk-activity 1.2 s, inbox 2 s, presence 12 s)
 * a single online handset is ~5 requests/sec — multiplied by every active user and the auth
 * lookup alone burns a chunk of pg's connection pool.
 *
 * Trade-off: an admin disabling a user / disabling an agency takes up to [TTL_MS] to propagate
 * (cache TTL). Login invalidates explicitly so the "newest sign-in wins" semantic stays instant.
 */
const TTL_MS = 15_000;

interface CachedAuth {
  tokenGeneration: number;
  userDisabled: boolean;
  agencyDisabled: boolean;
  expiresAt: number;
}

const cache = new Map<number, CachedAuth>();

export function getCachedAuth(userId: number): Omit<CachedAuth, "expiresAt"> | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

export function setCachedAuth(
  userId: number,
  value: Omit<CachedAuth, "expiresAt">,
): void {
  const now = Date.now();
  const existing = cache.get(userId);
  if (existing) {
    if (existing.expiresAt < now) {
      cache.delete(userId);
    } else if (existing.tokenGeneration > value.tokenGeneration) {
      // A stale in-flight request must never overwrite a fresher post-login generation.
      return;
    }
  }
  cache.set(userId, { ...value, expiresAt: now + TTL_MS });
}

/**
 * Force the next authenticated request from this user to re-fetch the truth from Postgres.
 * Called after a fresh login bumps token_generation so the "session superseded" check fires
 * immediately on the old device's next call instead of waiting up to TTL_MS.
 */
export function invalidateCachedAuth(userId: number): void {
  cache.delete(userId);
}

/** Drops everyone — used when running tests / shutting down. Idempotent. */
export function clearAuthCache(): void {
  cache.clear();
}
