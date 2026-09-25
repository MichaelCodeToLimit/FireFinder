import { hmacSha256Hex } from './crypto.ts';
import type { SolutionStore } from './store.ts';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

export interface RateLimitCheck {
  key: string;
  limit: number;
}

/**
 * Pluggable rate limiting. Pick the backend that matches the deployment:
 *  - MemoryRateLimiter: a single long-running process (Node server).
 *  - StoreRateLimiter: many short-lived instances sharing one database
 *    (Supabase Edge Functions, serverless).
 * A Redis/Upstash limiter can implement the same interface later.
 */
export interface RateLimiter {
  /** Counts one hit against every key, in a single round trip where the backend allows. */
  hit(checks: RateLimitCheck[], windowSeconds: number): Promise<RateLimitDecision[]>;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitPolicy {
  /** POST /search, GET /solutions... */
  read: RateLimitRule;
  /** POST /solutions, confirm, report. */
  write: RateLimitRule;
  /** Per-IP limits are this multiple of the per-client limits (several clients can share an IP). */
  perIpMultiplier: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  read: { limit: 60, windowSeconds: 60 },
  write: { limit: 20, windowSeconds: 60 },
  perIpMultiplier: 5,
};

function secondsUntilReset(windowSeconds: number, nowMs: number): number {
  const windowMs = windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, { windowStart: number; hits: number }>();
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(options: { now?: () => number; maxKeys?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 50_000;
  }

  async hit(checks: RateLimitCheck[], windowSeconds: number): Promise<RateLimitDecision[]> {
    const now = this.#now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - (now % windowMs);

    return checks.map(({ key, limit }) => {
      let entry = this.#windows.get(key);
      if (!entry || entry.windowStart !== windowStart) {
        if (!entry && this.#windows.size >= this.#maxKeys) this.#evictExpired(now, windowMs);
        entry = { windowStart, hits: 0 };
        this.#windows.set(key, entry);
      }
      entry.hits++;
      return decision(entry.hits, limit, windowSeconds, now);
    });
  }

  #evictExpired(now: number, windowMs: number): void {
    for (const [key, entry] of this.#windows) {
      if (entry.windowStart + windowMs <= now) this.#windows.delete(key);
    }
    // Still full: drop the oldest entries rather than grow without bound.
    while (this.#windows.size >= this.#maxKeys) this.#windows.delete(this.#windows.keys().next().value!);
  }
}

export class StoreRateLimiter implements RateLimiter {
  readonly #store: SolutionStore;
  readonly #keySecret: string;

  /**
   * @param keySecret Bucket keys contain IP addresses and client ids; they are
   *   stored only as an HMAC under this secret, never in readable form.
   */
  constructor(store: SolutionStore, keySecret: string) {
    if (keySecret.length < 16) throw new Error('StoreRateLimiter keySecret must be at least 16 characters');
    this.#store = store;
    this.#keySecret = keySecret;
  }

  async hit(checks: RateLimitCheck[], windowSeconds: number): Promise<RateLimitDecision[]> {
    const buckets = await Promise.all(
      checks.map(async ({ key }) => (await hmacSha256Hex(this.#keySecret, `ratelimit:${key}`)).slice(0, 40)),
    );
    // One statement for all buckets: no extra connection on a cold serverless instance.
    const hits = await this.#store.rateLimitHits(buckets, windowSeconds);
    const now = Date.now();
    return checks.map(({ limit }, i) => decision(hits[i] ?? 0, limit, windowSeconds, now));
  }
}

/** Disables rate limiting (tests, trusted private deployments). */
export class NoopRateLimiter implements RateLimiter {
  async hit(checks: RateLimitCheck[]): Promise<RateLimitDecision[]> {
    return checks.map(({ limit }) => ({ allowed: true, limit, remaining: limit, resetSeconds: 0 }));
  }
}

function decision(hits: number, limit: number, windowSeconds: number, now: number): RateLimitDecision {
  return {
    allowed: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    resetSeconds: secondsUntilReset(windowSeconds, now),
  };
}
