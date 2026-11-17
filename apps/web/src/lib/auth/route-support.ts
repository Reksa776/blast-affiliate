// AffiliateOS — shared plumbing for mutating API routes (P0.8).
//
// Three concerns, each of which is easy to get subtly wrong per route:
//
//   1. error → status mapping. `AuthError` is 401, `CsrfError` and `PermissionError`
//      are both 403 with a FIXED body: the caller must not learn whether the
//      workspace exists, whether they are a member, or which permission is missing.
//      That is also why a cross-tenant request and a request to a workspace that
//      does not exist are indistinguishable — no existence oracle.
//   2. the tenant context handed to `withTenant()`. Its tenantId comes from the
//      membership row resolved by `requirePermission` (a database fact), never from
//      the URL or the body. The URL only says which workspace the caller *claims*;
//      `requirePermission` decides whether that claim is real.
//   3. audit context. The request id comes from the edge/proxy and the IP is passed
//      to `writeAudit`, which hashes it — plaintext addresses never reach the table.
//
// Explicit `.ts` extensions: these modules run under Node's type stripping in the
// test harness, where extensionless specifiers do not resolve.

import { createTenantContext, type TenantContext } from "@affiliateos/database";
import { ALL_ROLES, type WorkspaceRole } from "@affiliateos/permissions";
import { NextResponse, type NextRequest } from "next/server";

import { log } from "../logger.ts";
import { CsrfError } from "./csrf.ts";
import { getClientIp } from "./client-ip.ts";
import { AuthError } from "./middleware.ts";
import { PermissionError, type PermissionGrant } from "./permission.ts";

/** Mutating responses must never be cached by a proxy or the browser. */
export const NO_STORE = { "cache-control": "no-store" } as const;

export function jsonFail(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Translates the auth/csrf/permission failures into responses.
 *
 * Anything else is re-thrown: a database error must surface as a 500 and be logged,
 * not be dressed up as a client error.
 */
export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof AuthError) return jsonFail("Unauthorized", error.status);
  if (error instanceof CsrfError) return jsonFail(error.message, 403);
  if (error instanceof PermissionError) return jsonFail("Forbidden", 403);

  // Unexpected failure: the response is deliberately opaque (a driver message can
  // name tables, hosts or query values), but the operator still needs one line.
  // `log` redacts credential-shaped keys and text before it reaches stdout.
  log("error", "route.unhandled", {
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { value: String(error) },
  });

  throw error;
}

/** Body as a plain object, or null when it is not one. */
export async function readJsonObject(req: NextRequest): Promise<Record<string, unknown> | null> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Audit fields every workspace route passes to `writeAudit`.
 *
 * The IP goes through `getClientIp` for the same reason the rate limiter does: proxy
 * headers are attacker-controlled unless `TRUST_PROXY=true`, and an audit trail full
 * of forged addresses is worse than one that says "unknown". `writeAudit` hashes it.
 */
export function auditRequestFields(req: NextRequest): {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
} {
  return {
    requestId: req.headers.get("x-request-id"),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  };
}

/**
 * Builds the context `withTenant()` accepts.
 *
 * `tenantId` must be a value the database produced: `grant.member.tenantId` for a
 * normal member. It is passed in rather than defaulted so a caller cannot silently
 * fall back to a request parameter.
 *
 * A platform admin has no membership row (docs/08 §5.3), so the context is minted
 * with actorType `system` and an empty membershipId — which `createTenantContext`
 * only allows for that actor type.
 */
export function tenantContextFor(
  grant: PermissionGrant,
  tenantId: string,
  requestId: string | null,
): TenantContext {
  return createTenantContext({
    tenantId,
    userId: grant.session.userId,
    membershipId: grant.member?.id ?? "",
    actorType: grant.member === null ? "system" : "user",
    requestId: requestId === null || requestId.trim() === "" ? "unattributed" : requestId,
    permissions: grant.permissions,
  });
}

/** The actor type written to the audit row for this grant. */
export function auditActorType(grant: PermissionGrant): "USER" | "SUPER_ADMIN" {
  return grant.member === null ? "SUPER_ADMIN" : "USER";
}

export function isRoleKey(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (ALL_ROLES as readonly string[]).includes(value);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email === "" || email.length > 320 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export const SLUG_MAX_LENGTH = 64; // workspaces.slug is VARCHAR(64); see checkpoint report
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (slug === "" || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return null;
  return slug;
}

export const WORKSPACE_NAME_MAX_LENGTH = 150;

export function normalizeWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > WORKSPACE_NAME_MAX_LENGTH) return null;
  return name;
}
