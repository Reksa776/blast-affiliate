// PATCH /api/workspaces/:workspaceId/members/:memberId/role — change a member's
// role (P0.8).
//
// Contract:
//   200 { memberId, roleKey }
//   400 malformed body / unknown role / caller is the target member
//   401 no valid session
//   403 missing CSRF token, or the caller is not a member / lacks `member.manage`
//   404 the member does not belong to this workspace (same answer for "no such
//       member" and "member of another workspace" — no existence oracle)
//   429 per-user workspace-mutation rate limit exhausted
//
// Authority: `requirePermission` resolves the caller's membership in `:workspaceId`.
// The member is then looked up through `withTenant()`, so the scope is merged into
// the `where` by the query extension: passing another workspace's member id finds
// nothing, even though the id is a valid UUID in that other workspace.
//
// Self-change is refused with 400. The brief's rule (no downgrade of yourself) is
// implemented in its strict form — no self change at all — because the owner
// lock-out it protects against is a lock-out, not a downgrade: an owner who moves
// themselves to VIEWER can no longer manage the workspace, and no endpoint can undo
// it. Demoting yourself is an administrative action for another owner to perform.
//
// Ordering that matters: the new assignment is inserted BEFORE the old ones are
// deleted, so a failure halfway through leaves the member with their old role plus
// the new one (recoverable) instead of no role at all (locked out).

import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";

import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import {
  auditActorType,
  auditRequestFields,
  handleRouteError,
  isRoleKey,
  jsonFail,
  NO_STORE,
  readJsonObject,
  tenantContextFor,
} from "@/lib/auth/route-support";
import {
  workspaceMutationRateLimit,
  workspaceRateLimitResponse,
} from "@/lib/auth/workspace-rate-limit";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string; memberId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId, memberId } = await context.params;

    const grant = await requirePermission(req, workspaceId, "member.manage");
    verifyCsrf(req);

    const limited = await enforceApiRateLimit(req, {
      scope: "user",
      key: grant.session.userId,
      route: "members.role",
    });
    if (limited !== null) return limited;

    const limit = workspaceMutationRateLimit(grant.session.userId);
    if (!limit.allowed) return workspaceRateLimitResponse(limit);

    const payload = await readJsonObject(req);
    if (payload === null) return jsonFail("Invalid JSON body", 400);

    if (!isRoleKey(payload.roleKey)) return jsonFail("Unknown role", 400);
    const roleKey = payload.roleKey;

    if (grant.member !== null && grant.member.id === memberId) {
      return jsonFail("You cannot change your own role", 400);
    }

    const requestId = req.headers.get("x-request-id");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, requestId);
    const actorMemberId = grant.member?.id ?? null;

    const outcome = await withTenant(ctx, async (db) => {
      const member = await db.workspaceMember.findFirst({
        where: { id: memberId },
        select: {
          id: true,
          userId: true,
          roleAssignments: { select: { role: { select: { key: true } } } },
        },
      });
      if (member === null) return { kind: "not-found" } as const;

      const role = await db.role.findFirst({ where: { key: roleKey }, select: { id: true } });
      if (role === null) return { kind: "unknown-role" } as const;

      const previousKeys = member.roleAssignments.map((assignment) => assignment.role.key).sort();
      if (previousKeys.length === 1 && previousKeys[0] === roleKey) {
        return { kind: "unchanged", previousKeys } as const;
      }

      try {
        await db.memberRole.create({
          data: {
            tenantId: ctx.tenantId,
            memberId,
            roleId: role.id,
            assignedByMemberId: actorMemberId,
          },
        });
      } catch (error) {
        // The assignment already exists: the member already holds this role too.
        if (typeof error !== "object" || error === null || (error as { code?: string }).code !== "P2002") {
          throw error;
        }
      }

      // Drop every other role; the scope extension adds tenantId to this where.
      await db.memberRole.deleteMany({ where: { memberId, roleId: { not: role.id } } });

      return { kind: "changed", previousKeys, targetUserId: member.userId } as const;
    });

    if (outcome.kind === "not-found") return jsonFail("Not found", 404);
    if (outcome.kind === "unknown-role") return jsonFail("Unknown role", 400);

    if (outcome.kind === "changed") {
      // Privilege change: every live session of the affected user is revoked, so a
      // cookie issued under the old role cannot keep exercising it. The caller's own
      // session is untouched (role change on oneself is refused above anyway).
      await revokeAllSessionsForUser(outcome.targetUserId);

      await writeAudit({
        tenantId: ctx.tenantId,
        actorType: auditActorType(grant),
        actorUserId: grant.session.userId,
        actorMemberId,
        action: "role.change",
        resourceType: "workspace_member",
        resourceId: memberId,
        ...auditRequestFields(req),
        metadata: { from: outcome.previousKeys.join(",") || null, to: roleKey },
      });
    }

    return NextResponse.json({ memberId, roleKey }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}
