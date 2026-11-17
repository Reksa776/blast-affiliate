// POST /api/workspaces/:workspaceId/members — invite by email (P0.8).
//
// Contract:
//   200 { id, email, roleKey, status: "pending" }
//   400 malformed body / invalid email / roleKey outside the enum
//   401 no valid session
//   403 missing CSRF token, or the caller is not a member / lacks `member.invite`
//   404 the workspace does not exist for this caller
//   409 the email is already an active member, or already has a pending invitation
//
// Authority: `requirePermission` resolves the caller's membership in
// `:workspaceId` from the session. The workspace id in the path is only a claim; it
// never becomes the tenant of a query on its own.
//
// Flow: an invitation row (status PENDING) is created, not a membership. Accepting
// it is a separate endpoint that does not exist yet, so this route deliberately does
// not activate anyone. The raw invite token is generated, hashed and discarded —
// Phase 1 has no mail transport, and returning it would hand the caller a credential
// they could use to bypass the accept step later.

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Invitations expire in seven days; mirrors the PRD's default window. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SHA-256 as the raw 32 bytes `workspace_invitations.token_hash` expects. */
function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(crypto.createHash("sha256").update(value, "utf8").digest());
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

      // The raw token exists only here: it is hashed for storage and never leaves
      // this function (no mail transport in Phase 1, and no token in the response).
      const invitationToken = crypto.randomBytes(32).toString("base64url");
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
      { id: outcome.invitationId, email, roleKey, status: "pending" },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
