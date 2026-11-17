// AffiliateOS — general API rate limits (Phase 1 HIGH #2, completing TD-8-R4).
//
// Phase 2 already limited workspace *mutations* per user (60/min, one shared
// bucket). That left the rest of the API unthrottled: a member could loop any
// authenticated read route, and a tenant could be hammered across many users.
// This module adds two general scopes:
//
//   user   300 requests/minute per user per route
//   tenant 100 requests/minute per tenant per heavy route (office settings)
//
// The login/register limiters stay as they are: they run before a user is known
// and therefore key on the client IP (10/15 min and 5/min respectively).
//
// The backing store is the same in-process fixed-window map as P0.5
// (`lib/auth/rate-limit.ts`). That is deliberately NOT distributed: N instances
// multiply the effective limit by N (TD-7C-A1, still open until Redis in P1.3).
// The bucket key carries the scope, the id and the route, so exhausting one route
// never locks a user out of another.
//
// No Next.js import lives here on purpose: the unit test runs this file through
// Node's type stripping, where `@/` path aliases and `next/server` would be extra
// moving parts. The HTTP-shaped helpers are in `./middleware.ts`.

import { consumeRateLimit, type RateLimitDecision } from "../auth/rate-limit.ts";

export const API_USER_LIMIT_DEFAULT = 300;
export const API_USER_WINDOW_MS_DEFAULT = 60_000;
export const API_TENANT_LIMIT_DEFAULT = 100;
export const API_TENANT_WINDOW_MS_DEFAULT = 60_000;
export const API_IP_LIMIT_DEFAULT = 300;
export const API_IP_WINDOW_MS_DEFAULT = 60_000;

export type ApiRateLimitScope = "user" | "tenant" | "ip";

/**
 * Limits are read per call, not frozen at import time, so tests (and an operator
 * changing an env value before restart) can tune them without rebuilding. Invalid
 * or non-positive values fall back to the documented default instead of throwing.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The effective limit/window for a scope, after env overrides. */
export function apiRateLimitConfig(scope: ApiRateLimitScope): { limit: number; windowMs: number } {
  if (scope === "tenant") {
    return {
      limit: positiveIntFromEnv("API_RATE_LIMIT_TENANT_MAX", API_TENANT_LIMIT_DEFAULT),
      windowMs: positiveIntFromEnv("API_RATE_LIMIT_TENANT_WINDOW_MS", API_TENANT_WINDOW_MS_DEFAULT),
    };
  }

  if (scope === "ip") {
    return {
      limit: positiveIntFromEnv("API_RATE_LIMIT_IP_MAX", API_IP_LIMIT_DEFAULT),
      windowMs: positiveIntFromEnv("API_RATE_LIMIT_IP_WINDOW_MS", API_IP_WINDOW_MS_DEFAULT),
    };
  }

  return {
    limit: positiveIntFromEnv("API_RATE_LIMIT_USER_MAX", API_USER_LIMIT_DEFAULT),
    windowMs: positiveIntFromEnv("API_RATE_LIMIT_USER_WINDOW_MS", API_USER_WINDOW_MS_DEFAULT),
  };
}

/**
 * Stable bucket key. `route` is a code-owned label (`workspaces.list`), never a
 * raw URL: a caller-controlled path with random suffixes would mint a fresh bucket
 * per request and defeat the limit.
 */
export function apiRateLimitKey(scope: ApiRateLimitScope, id: string, route: string): string {
  return `api-${scope}:${id}:${route}`;
}

/** Consumes one slot for `scope`/`id`/`route` and returns the decision. */
export function apiRateLimit(
  scope: ApiRateLimitScope,
  id: string,
  route: string,
): RateLimitDecision {
  const { limit, windowMs } = apiRateLimitConfig(scope);
  return consumeRateLimit(apiRateLimitKey(scope, id, route), limit, windowMs);
}
