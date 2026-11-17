// /api/workspaces — list and create workspaces.
//
// GET contract (Phase 2):
//   200 { workspaces: [{ id, slug, name, status, plan, membershipId, joinedAt, roles }] }
//       Only workspaces where the session user holds an ACTIVE membership.
//   401 no valid session
//
// POST contract:
//   201 { id, name, slug }
//   400 malformed body / invalid name / invalid slug
//   401 no valid session
//   403 missing or mismatched CSRF token
//   409 slug already taken (platform-wide unique)
//   429 per-user rate limit exhausted (Retry-After header)
//
// Why POST uses `systemDb()`: the workspace row *is* the tenant, so there is
// no tenant context to scope the insert to yet. Provisioning (six default roles, the
// owner membership, its owner role assignment) is the same kind of platform work as
// `seedPermissionCatalog`, which is why each call is marked SYSTEM.
//
// GET is different: membership discovery is SYSTEM (it has to run before a tenant is
// known), but every workspace row and role assignment is then read through
// `withTenant()`, so the missing-list half of TD-7F-R4 is closed for this route.
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

import { getSessionCookieName } from "@/lib/auth/cookie-name";
import { verifyCsrf } from "@/lib/auth/csrf";
import { getClientIp, requireAuth } from "@/lib/auth/middleware";
import { rotateSession, sessionCookieOptions } from "@/lib/auth/session";
import {
  auditRequestFields,
  handleRouteError,
  jsonFail,
  normalizeSlug,
  normalizeWorkspaceName,
  NO_STORE,
  readJsonObject,
} from "@/lib/auth/route-support";
import {
  workspaceMutationRateLimit,
  workspaceRateLimitResponse,
} from "@/lib/auth/workspace-rate-limit";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";
import { listWorkspacesForUser } from "@/lib/workspaces/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAuth(req);

    const limited = await enforceApiRateLimit(req, {
      scope: "user",
      key: session.userId,
      route: "workspaces.list",
    });
    if (limited !== null) return limited;

    const workspaces = await listWorkspacesForUser(session);
    return NextResponse.json({ workspaces }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAuth(req);
    verifyCsrf(req);

    const limited = await enforceApiRateLimit(req, {
      scope: "user",
      key: session.userId,
      route: "workspaces.create",
    });
    if (limited !== null) return limited;

    // Per-user, shared across workspace mutations (Phase 2, item 2.4).
    const limit = workspaceMutationRateLimit(session.userId);
    if (!limit.allowed) return workspaceRateLimitResponse(limit);

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

    // Privilege change for the caller: the owner role just came into existence. The
    // session is rotated so the cookie in the browser is newer than the privilege it
    // exercises; the fresh token is delivered in this same response. Other sessions
    // of the same user are left alone (nothing about them changed).
    const rotated = await rotateSession(
      req.cookies.get(getSessionCookieName())?.value ?? "",
      session.userId,
      getClientIp(req),
      req.headers.get("user-agent") ?? "",
    );

    const response = NextResponse.json({ id: workspaceId, name, slug }, { status: 201, headers: NO_STORE });
    response.cookies.set(getSessionCookieName(), rotated.token, sessionCookieOptions(rotated.expiresAt));

    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
