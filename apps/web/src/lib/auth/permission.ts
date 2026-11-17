// AffiliateOS — server-side permission enforcement (P0.6).
//
// Evaluation: session → workspace_members(status ACTIVE) → member_roles →
// role_permissions → permission key. That is three nested selects in ONE Prisma
// query (plus the session lookup), not a per-role loop, so a member with several
// roles costs the same as a member with one.
//
// Platform-wide access is NOT a workspace role (docs/08 §5.3): a live
// `platform_admin_grants` row grants the whole catalog. That check runs only when
// the membership path would deny, so the normal request pays nothing for it — and
// a tenant owner still cannot mint platform access.
//
// Every failure is a 403 with a fixed message. "Not a member" and "missing
// permission" deliberately share the status, and the permission name is not echoed
// to the client by the route layer (it is in the thrown error for logs only).

import { systemDb } from "@affiliateos/database";
import { ALL_PERMISSIONS, isPermission, type Permission } from "@affiliateos/permissions";

// Explicit `.ts` extensions: the test harness runs these modules through Node's
// type stripping, where extensionless specifiers do not resolve. Turbopack accepts
// them too (verified by `next build`).
import { requireAuth, type SessionCookieRequest } from "./middleware.ts";
import type { ValidatedSession } from "./session.ts";

export class PermissionError extends Error {
  readonly status = 403 as const;

  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export type PermissionGrant = {
  session: ValidatedSession;
  member: { id: string; tenantId: string; userId: string } | null;
  permissions: string[];
  platformAdmin: boolean;
};

/**
 * Resolves the caller's permissions in one workspace and requires `permission`.
 *
 * Throws `AuthError` (401) when there is no valid session and `PermissionError`
 * (403) for every authorization failure.
 */
export async function requirePermission(
  req: SessionCookieRequest,
  tenantId: string,
  permission: Permission,
): Promise<PermissionGrant> {
  if (!isPermission(permission)) {
    // Guard against a caller passing a value that is not in the catalog; without
    // it a typo would be a silent deny, which is safe but very hard to debug.
    throw new PermissionError("Unknown permission");
  }

  const session = await requireAuth(req);

  // SYSTEM: the membership of the *requested* workspace must be looked up before a
  // TenantContext exists — that lookup is exactly what establishes the tenant.
  const member = await systemDb().workspaceMember.findUnique({
    where: { tenantId_userId: { tenantId, userId: session.userId } },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      status: true,
      roleAssignments: {
        select: {
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });

  const held = new Set<string>();
  if (member !== null && member.status === "ACTIVE") {
    for (const assignment of member.roleAssignments) {
      for (const grant of assignment.role.permissions) held.add(grant.permission.key);
    }
  }

  const memberAllows = member !== null && member.status === "ACTIVE" && held.has(permission);
  if (memberAllows) {
    return {
      session,
      member: { id: member.id, tenantId: member.tenantId, userId: member.userId },
      permissions: [...held],
      platformAdmin: false,
    };
  }

  // SYSTEM: platform-admin grants are global by design (no tenant column).
  const platformGrant = await systemDb().platformAdminGrant.findFirst({
    where: { userId: session.userId, revokedAt: null },
    select: { id: true },
  });

  if (platformGrant !== null) {
    return {
      session,
      member: member === null ? null : { id: member.id, tenantId: member.tenantId, userId: member.userId },
      permissions: [...ALL_PERMISSIONS],
      platformAdmin: true,
    };
  }

  if (member === null || member.status !== "ACTIVE") {
    throw new PermissionError("Not a member of this workspace");
  }

  throw new PermissionError(`Missing permission: ${permission}`);
}
