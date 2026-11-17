// AffiliateOS — request rate limiting (P0.5).
//
// Fixed window, in memory, per process. That is enough to blunt a single-process
// password-guessing loop and nothing more: the counter is lost on restart, and a
// second instance has its own map. Tracked as TD-7C-A1 (HIGH) until P1.3 moves it
// to Redis — do not treat this as a distributed control.
//
// A fixed window is used rather than a sliding log because the brute-force risk
// here is repeated attempts, not a precisely shaped burst. The trade-off is that
// an attacker can make `limit` attempts at the end of one window and `limit` at
// the start of the next.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * The result of one rate-limit decision.
 *
 * `retryAfterSeconds` is the value a 429 response should put in `Retry-After`: a
 * whole number of seconds, never zero, so a client cannot be told to retry
 * immediately inside an exhausted window.
 */
export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * Consumes one slot and returns the decision plus reset information.
 *
 * The first call in a window creates the bucket with count 1. A non-positive limit
 * denies everything (fail-closed) instead of accidentally allowing unlimited use.
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitDecision {
  const now = Date.now();

  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: false, limit: 0, remaining: 0, retryAfterSeconds: 1 };
  }

  const bucket = buckets.get(key);

  if (bucket === undefined || bucket.resetAt <= now) {
    const resetAt = now + Math.max(1, windowMs);
    buckets.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: secondsUntil(resetAt, now),
    };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: secondsUntil(bucket.resetAt, now),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: secondsUntil(bucket.resetAt, now),
  };
}

/**
 * Returns true when the call is allowed, false when the window is exhausted.
 * Kept as the stable boolean form used by the existing login limiter.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  return consumeRateLimit(key, limit, windowMs).allowed;
}

/** Drops expired buckets. Safe to call at any time; intended for a worker tick. */
export function cleanupRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Number of tracked keys. Diagnostics only — never keyed by a secret. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
