/**
 * Brute-force throttle for the `/v1/auth/login` endpoint.
 *
 * The login route is the one public, unauthenticated door into a platform that
 * guards emergency comms, so an unthrottled password check is a real risk: a
 * script can grind a single account (credential stuffing) or sweep many
 * accounts from one host. This module adds an in-memory, dependency-free
 * throttle with exponential lockout.
 *
 * It tracks two independent dimensions so neither attack shape slips through:
 *   - `ip:<addr>`     — catches one host trying many usernames.
 *   - `user:<name>`   — catches many hosts hammering one username.
 *
 * The login route checks BOTH keys before verifying a password and is blocked
 * if either is locked; it records a failure against both keys on a bad login,
 * and clears both on a good one. A legitimate user who mistypes a few times
 * waits out a short lockout that grows only under sustained failure.
 *
 * Why in-memory (no Redis / no new dep): the server already keeps per-process
 * state (session cache, presence) and runs as a single Railway instance, so a
 * Map is sufficient and matches the codebase's "no extra dep for cheap wins"
 * style. The tradeoff is that lockout state resets on redeploy and is not
 * shared across hypothetical future replicas — acceptable for a throttle whose
 * job is to blunt automated grinding, not to be a hard distributed quota.
 */

export interface LoginRateLimitConfig {
  /** Consecutive failures within `windowMs` that trip a lockout. */
  maxFailures: number;
  /**
   * Sliding reset window. If the gap since the last failure exceeds this, the
   * failure counter starts over — so occasional fat-finger typos hours apart
   * never accumulate into a lockout.
   */
  windowMs: number;
  /** Duration of the first lockout. Each subsequent lockout doubles it. */
  baseLockoutMs: number;
  /** Upper bound on a single lockout so a key is never bricked forever. */
  maxLockoutMs: number;
  /**
   * How long after a key goes fully idle (not locked, no recent failures)
   * before it is eligible for eviction, keeping the Map from growing without
   * bound under a wide IP sweep.
   */
  idleEvictionMs: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  baseLockoutMs: 60 * 1000,
  maxLockoutMs: 15 * 60 * 1000,
  idleEvictionMs: 60 * 60 * 1000,
};

interface KeyState {
  /** Consecutive failures in the current window (reset to 0 once a lock trips). */
  failures: number;
  /** Timestamp of the most recent recorded failure. */
  lastFailureAt: number;
  /** Lockout expiry; 0 when not locked. */
  lockedUntil: number;
  /** How many lockouts this key has served — drives the exponential backoff. */
  lockoutCount: number;
}

export class LoginRateLimiter {
  private readonly cfg: Required<Omit<LoginRateLimitConfig, "now">>;
  private readonly now: () => number;
  private readonly states = new Map<string, KeyState>();

  constructor(config: LoginRateLimitConfig = DEFAULT_LOGIN_RATE_LIMIT) {
    const { now, ...rest } = config;
    this.cfg = rest;
    this.now = now ?? Date.now;
  }

  /**
   * Milliseconds remaining on this key's lockout, or 0 if it is free to try.
   * Read-only — does not mutate state (beyond evicting an expired entry).
   */
  retryAfterMs(key: string): number {
    const state = this.states.get(key);
    if (!state) return 0;
    const now = this.now();
    if (state.lockedUntil > now) {
      return state.lockedUntil - now;
    }
    // Lock has expired (or never set) — opportunistically drop the entry if it
    // has also gone idle, so a one-off failed attempt doesn't linger forever.
    if (this.isEvictable(state, now)) {
      this.states.delete(key);
    }
    return 0;
  }

  /** True if any of the given keys is currently locked. */
  isLocked(keys: string[]): boolean {
    return keys.some((k) => this.retryAfterMs(k) > 0);
  }

  /** Largest remaining lockout across the given keys (0 if all are free). */
  retryAfterMsFor(keys: string[]): number {
    let max = 0;
    for (const k of keys) {
      const ms = this.retryAfterMs(k);
      if (ms > max) max = ms;
    }
    return max;
  }

  /**
   * Record one failed login against a key. Once `maxFailures` consecutive
   * failures land inside the window, the key is locked for an exponentially
   * growing duration (capped at `maxLockoutMs`) and the failure counter resets
   * so the next lockout requires a fresh run of failures.
   */
  recordFailure(key: string): void {
    const now = this.now();
    const state = this.states.get(key) ?? {
      failures: 0,
      lastFailureAt: 0,
      lockedUntil: 0,
      lockoutCount: 0,
    };
    // Stale window — failures too far apart to count as one brute-force run.
    if (now - state.lastFailureAt > this.cfg.windowMs) {
      state.failures = 0;
    }
    state.failures += 1;
    state.lastFailureAt = now;
    if (state.failures >= this.cfg.maxFailures) {
      const lockMs = Math.min(
        this.cfg.baseLockoutMs * 2 ** state.lockoutCount,
        this.cfg.maxLockoutMs,
      );
      state.lockedUntil = now + lockMs;
      state.lockoutCount += 1;
      state.failures = 0;
    }
    this.states.set(key, state);
  }

  /** Clear a key after a successful login so a legit user starts fresh. */
  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  /** Number of tracked keys — for tests and diagnostics. */
  size(): number {
    return this.states.size;
  }

  /** Drop all idle, unlocked entries. Safe to call periodically. */
  sweep(): void {
    const now = this.now();
    for (const [key, state] of this.states) {
      if (state.lockedUntil <= now && this.isEvictable(state, now)) {
        this.states.delete(key);
      }
    }
  }

  private isEvictable(state: KeyState, now: number): boolean {
    return state.lockedUntil <= now && now - state.lastFailureAt > this.cfg.idleEvictionMs;
  }
}

/** Process-wide limiter used by the login route. */
export const loginRateLimiter = new LoginRateLimiter();

/** Build the (ip, user) key pair the login route throttles on. */
export function loginRateLimitKeys(ip: string, username: string): string[] {
  const keys: string[] = [];
  if (ip) keys.push(`ip:${ip}`);
  const normUser = username.trim().toLowerCase();
  if (normUser) keys.push(`user:${normUser}`);
  return keys;
}
