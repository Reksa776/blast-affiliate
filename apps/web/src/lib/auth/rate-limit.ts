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
 * Returns true when the call is allowed, false when the window is exhausted.
 * The first call in a window creates the bucket with count 1.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (bucket === undefined || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) return false;

  bucket.count += 1;
  return true;
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
