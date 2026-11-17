// POST /api/workspaces — create a workspace (P0.8).
//
// Contract:
//   201 { id, name, slug }
//   400 malformed body / invalid name / invalid slug
//   401 no valid session
//   403 missing or mismatched CSRF token
//   409 slug already taken (platform-wide unique)
//
// Why this route uses `systemDb()`: the workspace row *is* the tenant, so there is
// no tenant context to scope the insert to yet. Provisioning (six default roles, the
// owner membership, its owner role assignment) is the same kind of platform work as
// `seedPermissionCatalog`, which is why each call is marked SYSTEM.
//
// Everything that can fail after the workspace insert rolls back by deleting the
// workspace: roles, members and role assignments cascade, so a half-provisioned
// workspace is never left behind. No migration is involved.
//
// The audit row names the workspace as its tenant (not null) and records the new
// owner membership as the actor, so "who created this workspace" is answerable.

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  createDefaultRolesForWorkspace,
  systemDb,
  writeAudit,
} from "@affiliateos/database";
import { ROLES } from "@affiliateos/permissions";

import { verifyCsrf } from "@/lib/auth/csrf";
import { requireAuth } from "@/lib/auth/middleware";
import {
  auditRequestFields,
  handleRouteError,
  jsonFail,
  normalizeSlug,
  normalizeWorkspaceName,
  NO_STORE,
  readJsonObject,
} from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAuth(req);
    verifyCsrf(req);

    const payload = await readJsonObject(req);
    if (payload === null) return jsonFail("Invalid JSON body", 400);

    const name = normalizeWorkspaceName(payload.name);
    const slug = normalizeSlug(payload.slug);
    if (name === null) return jsonFail("Name must be 1-150 characters", 400);
    if (slug === null) return jsonFail("Slug must be 1-64 lowercase letters, digits or hyphens", 400);

    const workspaceId = crypto.randomUUID();
    const memberId = crypto.randomUUID();

    try {
      // SYSTEM: the workspace is being created, so it cannot scope its own insert.
      await systemDb().workspace.create({
        data: { id: workspaceId, slug, name },
        select: { id: true },
      });
    } catch (error) {
      // P2002 = unique violation. The driver message is not echoed back.
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
        return jsonFail("Slug already taken", 409);
      }
      throw error;
    }

    try {
      // SYSTEM: provisioning a workspace that has no members yet.
      await createDefaultRolesForWorkspace(workspaceId);

      // SYSTEM: same provisioning step; the rows belong to the new workspace.
      const ownerRole = await systemDb().role.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: workspaceId, key: ROLES.WORKSPACE_OWNER } },
        select: { id: true },
      });

      // SYSTEM: the creator's membership is the first row in the new tenant.
      await systemDb().workspaceMember.create({
        data: {
          id: memberId,
          tenantId: workspaceId,
          userId: session.userId,
          status: "ACTIVE",
          joinedAt: new Date(),
        },
        select: { id: true },
      });

      // SYSTEM: assigning the owner role to the membership just created.
      await systemDb().memberRole.create({
        data: { tenantId: workspaceId, memberId, roleId: ownerRole.id },
      });
    } catch (error) {
      // SYSTEM: compensating delete — roles, members and assignments cascade.
      // A failure here must not hide the original error, hence the swallow.
      await systemDb()
        .workspace.delete({ where: { id: workspaceId } })
        .catch(() => undefined);
      throw error;
    }

    await writeAudit({
      tenantId: workspaceId,
      actorType: "USER",
      actorUserId: session.userId,
      actorMemberId: memberId,
      action: "workspace.create",
      resourceType: "workspace",
      resourceId: workspaceId,
      ...auditRequestFields(req),
      metadata: { name, slug },
    });

    return NextResponse.json({ id: workspaceId, name, slug }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}
