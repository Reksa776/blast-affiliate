// AffiliateOS — session/permission access for Server Components (Phase 2).
//
// The admin pages must be authorized by the SAME code path as the API routes. They
// therefore call `requireAuth` and `requirePermission` directly, using a minimal
// request object built from the `next/headers` cookie jar. Nothing here invents a
// second permission model, and the workspace id supplied by a page is only a claim
// until `requirePermission` resolves the caller's membership from the database.
//
// Server Components cannot set cookies, so this module only reads. A missing or
// invalid session throws `AuthError`; the page decides whether to render an
// "unauthorized" state or redirect.

import { cookies } from "next/headers";
import type { Permission } from "@affiliateos/permissions";

import { requireAuth, type SessionCookieRequest } from "./middleware.ts";
import { requirePermission, type PermissionGrant } from "./permission.ts";
import type { ValidatedSession } from "./session.ts";

/** A request-shaped view over the read-only Server Component cookie jar. */
export async function cookieRequest(): Promise<SessionCookieRequest> {
  const jar = await cookies();

  return {
    cookies: {
      get(name: string) {
        const cookie = jar.get(name);
        return cookie === undefined ? undefined : { value: cookie.value };
      },
    },
  };
}

/** Resolves the page visitor's session, or throws `AuthError` (401). */
export async function requirePageAuth(): Promise<ValidatedSession> {
  return requireAuth(await cookieRequest());
}

/**
 * Resolves the visitor's membership in `workspaceId` and requires `permission`.
 * Throws `AuthError` (401) or `PermissionError` (403) exactly like the API.
 */
export async function requirePagePermission(
  workspaceId: string,
  permission: Permission,
): Promise<PermissionGrant> {
  return requirePermission(await cookieRequest(), workspaceId, permission);
}
