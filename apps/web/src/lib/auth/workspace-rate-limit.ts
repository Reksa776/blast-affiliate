// AffiliateOS — per-user rate limit for workspace mutations (Phase 2, item 2.4).
//
// Why a user bucket and not an IP bucket: the login limiter keys on the client
// address because login happens before a user is known. Workspace create/invite/role
// change happen AFTER `requireAuth`, so the stable, non-spoofable key is the user id.
// A shared office NAT therefore no longer makes one member's retries throttle
// everyone else, and rotating `x-forwarded-for` no longer resets the counter.
//
// The three routes share ONE bucket on purpose: together they are "workspace
// mutations", and the point is to stop a single account from hammering the
// provisioning path, not to tune each endpoint separately.
//
// This reuses the existing fixed-window limiter. It does NOT make that limiter
// distributed — the counter is still per process (TD-7C-A1), so a multi-instance
// deployment multiplies the effective limit by the instance count.

import { NextResponse } from "next/server";

import { consumeRateLimit, type RateLimitDecision } from "./rate-limit.ts";

export const WORKSPACE_RATE_LIMIT_MAX_DEFAULT = 60;
export const WORKSPACE_RATE_LIMIT_WINDOW_MS_DEFAULT = 60_000;

/** Reads a positive integer override; invalid values fall back instead of throwing. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Limits are read per call so tests (and an operator restart with a different env)
 * can change them without rebuilding; the bucket itself lives in the shared map.
 */
export function workspaceMutationRateLimit(userId: string): RateLimitDecision {
  const limit = positiveIntFromEnv("WORKSPACE_RATE_LIMIT_MAX", WORKSPACE_RATE_LIMIT_MAX_DEFAULT);
  const windowMs = positiveIntFromEnv(
    "WORKSPACE_RATE_LIMIT_WINDOW_MS",
    WORKSPACE_RATE_LIMIT_WINDOW_MS_DEFAULT,
  );

  return consumeRateLimit(`workspace-mutation:${userId}`, limit, windowMs);
}

/** The 429 response, including a `Retry-After` the client can act on. */
export function workspaceRateLimitResponse(decision: RateLimitDecision): NextResponse {
  return NextResponse.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(decision.retryAfterSeconds),
      },
    },
  );
}
