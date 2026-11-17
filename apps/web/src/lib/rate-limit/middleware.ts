// AffiliateOS — HTTP surface for the general API rate limiter (P1 HIGH #2).
//
// Routes call `enforceApiRateLimit` once they know the caller (after
// `requireAuth`/`requirePermission`) and pass a code-owned route label. A non-null
// return value IS the response to send; null means "continue".
//
// Why the check happens in the route and not in `proxy.ts`: the proxy sees a
// cookie but cannot resolve a user or a tenant without a database round-trip on
// every request (including static pages). The route already performed that lookup
// for authorization, so keying there costs nothing extra and cannot be spoofed by
// a header.
//
// Ordering rule used by the mutating routes: authentication → CSRF → rate limit →
// validation → mutation. A caller without a CSRF token gets 403 regardless of how
// many slots they burned, and a throttled caller learns nothing about the body
// validation they would have hit.

import { NextResponse, type NextRequest } from "next/server";

import { consumeRateLimit } from "../auth/rate-limit.ts";
import {
  apiRateLimitConfig,
  apiRateLimitKey,
  type ApiRateLimitScope,
} from "./general.ts";

export type CheckRateLimitOptions = {
  limit: number;
  windowMs: number;
  /** The user id, tenant id or IP address this bucket belongs to. */
  key: string;
  scope: ApiRateLimitScope;
  /** Code-owned route label, e.g. `members.invite`. */
  route: string;
};

export type CheckRateLimitResult = {
  allowed: boolean;
  /** Whole seconds until the window resets; present only when blocked. */
  retryAfter?: number;
  remaining: number;
  limit: number;
};

/**
 * The primitive requested by the brief. Kept `async` so a future Redis-backed
 * implementation can await without changing every call site.
 *
 * `req` is accepted for that future use (per-request tracing, trusted-proxy
 * address) and is intentionally unused today; the key is supplied by the caller
 * because only the caller knows the resolved user/tenant.
 */
export async function checkRateLimit(
  req: NextRequest,
  options: CheckRateLimitOptions,
): Promise<CheckRateLimitResult> {
  void req;

  const decision = consumeRateLimit(
    apiRateLimitKey(options.scope, options.key, options.route),
    options.limit,
    options.windowMs,
  );

  return {
    allowed: decision.allowed,
    retryAfter: decision.allowed ? undefined : decision.retryAfterSeconds,
    remaining: decision.remaining,
    limit: decision.limit,
  };
}

export type EnforceApiRateLimitOptions = {
  scope: ApiRateLimitScope;
  key: string;
  route: string;
  /** Override the scope default; used by tests and deliberately tiny limits. */
  limit?: number;
  windowMs?: number;
};

/**
 * Consumes one slot and returns the 429 response when the bucket is exhausted,
 * or null when the caller may continue.
 *
 * The 429 body matches the existing limiters (`{ error: "Too many requests" }`)
 * and carries `Retry-After` plus `X-RateLimit-*` headers so a client can back off
 * without guessing.
 */
export async function enforceApiRateLimit(
  req: NextRequest,
  options: EnforceApiRateLimitOptions,
): Promise<NextResponse | null> {
  const config = apiRateLimitConfig(options.scope);

  const result = await checkRateLimit(req, {
    limit: options.limit ?? config.limit,
    windowMs: options.windowMs ?? config.windowMs,
    key: options.key,
    scope: options.scope,
    route: options.route,
  });

  if (result.allowed) return null;

  return NextResponse.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(result.retryAfter ?? 1),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-scope": options.scope,
      },
    },
  );
}
