// /api/workspaces/:workspaceId/members — list members and invite by email.
//
// GET contract (Phase 2):
//   200 { workspace: { id, name, slug }, members: [{ id, userId, email, displayName,
//         status, jobTitle, joinedAt, roles }] }
//   401 no valid session
//   403 the caller is not an ACTIVE member with `member.read` — the same fixed body
//       for "workspace does not exist" and "workspace belongs to someone else"
//       (fail-closed, TD-7F-R4)
//
// POST contract:
//   200 { id, email, roleKey, status: "pending", ...devEcho }
//   400 malformed body / invalid email / roleKey outside the enum
//   401 no valid session
//   403 missing CSRF token, or the caller is not a member / lacks `member.invite`
//   404 the workspace does not exist for this caller
//   409 the email is already an active member, or already has a pending invitation
//   429 per-user workspace-mutation rate limit exhausted
//
// Authority: `requirePermission` resolves the caller's membership in
// `:workspaceId` from the session. The workspace id in the path is only a claim; it
// never becomes the tenant of a query on its own.
//
// Flow: an invitation row (status PENDING) is created, not a membership. The raw
// token is hashed for storage. In a NON-PRODUCTION environment the response also
// echoes the raw token as `devToken` so accept-invitation can be tested end to end
// without a mail transport. That echo is deliberately absent in production and must
// be replaced by the real invitation email before any production use (TD-8-R3).

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { systemDb, withTenant, writeAudit } from "@affiliateos/database";

import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import {
  auditActorType,
  auditRequestFields,
  handleRouteError,
  isRoleKey,
  jsonFail,
  normalizeEmail,
  NO_STORE,
  readJsonObject,
  tenantContextFor,
} from "@/lib/auth/route-support";
import {
  workspaceMutationRateLimit,
  workspaceRateLimitResponse,
} from "@/lib/auth/workspace-rate-limit";
import { listWorkspaceMembers } from "@/lib/workspaces/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Invitations expire in seven days; mirrors the PRD's default window. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SHA-256 as the raw 32 bytes `workspace_invitations.token_hash` expects. */
function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(crypto.createHash("sha256").update(value, "utf8").digest());
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;

    // 401 for no session, 403 for both "not a member" and "no such workspace".
    const grant = await requirePermission(req, workspaceId, "member.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      req.headers.get("x-request-id"),
    );

    const result = await withTenant(ctx, async (db) => {
      const workspace = await db.workspace.findFirst({
        where: { id: ctx.tenantId },
        select: { id: true, name: true, slug: true },
      });
      if (workspace === null) return null;

      return { workspace, members: await listWorkspaceMembers(db) };
    });

    if (result === null) return jsonFail("Not found", 404);

    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;

    // Auth + authorization first: without a membership there is nothing to scope.
    const grant = await requirePermission(req, workspaceId, "member.invite");
    verifyCsrf(req);

    const limit = workspaceMutationRateLimit(grant.session.userId);
    if (!limit.allowed) return workspaceRateLimitResponse(limit);

    const payload = await readJsonObject(req);
    if (payload === null) return jsonFail("Invalid JSON body", 400);

    const email = normalizeEmail(payload.email);
    if (email === null) return jsonFail("A valid email is required", 400);

    if (!isRoleKey(payload.roleKey)) return jsonFail("Unknown role", 400);
    const roleKey = payload.roleKey;

    const requestId = req.headers.get("x-request-id");
    // A member's context carries the tenant the database resolved; a platform
    // admin's carries the workspace named in the path, which the existence check
    // inside the same tenant-scoped query then validates.
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, requestId);

    // SYSTEM: `users` is platform-global (no tenant_id), so the invited account is
    // resolved outside the tenant scope. Nothing about the tenant is read here.
    const invitedUser = await systemDb().user.findUnique({
      where: { email },
      select: { id: true },
    });

    // Kept outside the callback only so the dev echo below can use it. It is never
    // written to the database, the audit row, or a log line.
    let rawInvitationToken: string | null = null;

    const outcome = await withTenant(ctx, async (db) => {
      const workspace = await db.workspace.findFirst({
        where: { id: ctx.tenantId },
        select: { id: true },
      });
      if (workspace === null) return { kind: "not-found" } as const;

      if (invitedUser !== null) {
        const existingMember = await db.workspaceMember.findFirst({
          where: { userId: invitedUser.id },
          select: { id: true },
        });
        if (existingMember !== null) return { kind: "already-member" } as const;
      }

      const pending = await db.workspaceInvitation.findFirst({
        where: { email, status: "PENDING" },
        select: { id: true },
      });
      if (pending !== null) return { kind: "already-invited" } as const;

      // The raw token exists only here and in the dev-only echo below. It is hashed
      // for storage; it is never part of the audit metadata.
      const invitationToken = crypto.randomBytes(32).toString("base64url");
      rawInvitationToken = invitationToken;
      const invitationId = crypto.randomUUID();

      await db.workspaceInvitation.create({
        data: {
          id: invitationId,
          tenantId: ctx.tenantId,
          email,
          roleKey,
          tokenHash: sha256Bytes(invitationToken),
          status: "PENDING",
          invitedByUserId: grant.session.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
        select: { id: true },
      });

      return { kind: "created", invitationId } as const;
    });

    if (outcome.kind === "not-found") return jsonFail("Not found", 404);
    if (outcome.kind === "already-member") return jsonFail("Already a member of this workspace", 409);
    if (outcome.kind === "already-invited") return jsonFail("An invitation is already pending for this email", 409);

    await writeAudit({
      tenantId: ctx.tenantId,
      actorType: auditActorType(grant),
      actorUserId: grant.session.userId,
      actorMemberId: grant.member?.id ?? null,
      action: "member.invite",
      resourceType: "workspace_invitation",
      resourceId: outcome.invitationId,
      ...auditRequestFields(req),
      metadata: { email, roleKey },
    });

    return NextResponse.json(
      {
        id: outcome.invitationId,
        email,
        roleKey,
        status: "pending",
        // DEV ONLY. `next dev` and the test harness run with NODE_ENV=development.
        // Production must mail the token instead; this branch must stay dark there.
        ...(process.env.NODE_ENV !== "production" && rawInvitationToken !== null
          ? { devToken: rawInvitationToken, devTokenOnly: true }
          : {}),
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
