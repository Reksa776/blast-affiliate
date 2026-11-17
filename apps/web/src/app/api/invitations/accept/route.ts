// POST /api/invitations/accept — turn a PENDING invitation into an ACTIVE
// membership (Phase 2, item 2.2).
//
// Contract:
//   200 { workspaceId, memberId, roleKey, status: "active" }
//   400 malformed body / unknown token / expired token / already-used token
//   401 no valid session
//   403 missing CSRF token, or the signed-in email does not match the invitation
//   409 the account is already an ACTIVE member, or the invitation was consumed
//
// Token handling:
//   - the request carries the RAW token; only its SHA-256 is stored in
//     `workspace_invitations.token_hash`, and the lookup below is by that hash;
//   - a wrong token, a non-PENDING invitation and an expired invitation all return
//     the same 400 body, so the endpoint is not an invitation oracle;
//   - the raw token never enters the audit metadata. It appears only in the
//     dev-only echo on the invite route (TD-8-R3).
//
// Authority: the tenant used by `withTenant` comes from the invited row, not from
// the request body. The signed-in user must already be the invitation's addressee;
// accepting cannot enroll a different account.
//
// Atomicity: membership activation and invitation consumption are two statements,
// not one transaction (TD-8-R2). The ordering favours the user: a crash after
// activation leaves an ACTIVE member with a still-PENDING invitation, which is
// recoverable, rather than a consumed invitation with no membership.

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { systemDb, withTenant, writeAudit } from "@affiliateos/database";

import { getSessionCookieName } from "@/lib/auth/cookie-name";
import { verifyCsrf } from "@/lib/auth/csrf";
import { getClientIp, requireAuth } from "@/lib/auth/middleware";
import { rotateSession, sessionCookieOptions } from "@/lib/auth/session";
import {
  auditRequestFields,
  handleRouteError,
  jsonFail,
  NO_STORE,
  readJsonObject,
} from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";
import { tenantContextForWorkspace } from "@/lib/workspaces/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVALID_INVITATION = "Invalid or expired invitation";

/** SHA-256 as the raw 32 bytes `workspace_invitations.token_hash` expects. */
function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(crypto.createHash("sha256").update(value, "utf8").digest());
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAuth(req);
    verifyCsrf(req);

    const limited = await enforceApiRateLimit(req, {
      scope: "user",
      key: session.userId,
      route: "invitations.accept",
    });
    if (limited !== null) return limited;

    const payload = await readJsonObject(req);
    if (payload === null) return jsonFail("Invalid JSON body", 400);

    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    if (token === "" || token.length > 512) return jsonFail(INVALID_INVITATION, 400);

    // SYSTEM: the invitation is found by its secret hash before any tenant is known;
    // this lookup is what establishes the tenant context for everything below.
    const invitation = await systemDb().workspaceInvitation.findUnique({
      where: { tokenHash: sha256Bytes(token) },
      select: {
        id: true,
        tenantId: true,
        email: true,
        roleKey: true,
        status: true,
        expiresAt: true,
      },
    });

    if (
      invitation === null ||
      invitation.status !== "PENDING" ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      return jsonFail(INVALID_INVITATION, 400);
    }

    // Case-insensitive on purpose: `normalizeEmail` (invite route) lowercases, but a
    // database row written by a future import might not be normalized.
    if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
      return jsonFail("Forbidden", 403);
    }

    // SYSTEM: the actor's membership in the invitation's tenant is the value a
    // TenantContext needs; this lookup precedes the context by necessity.
    const existing = await systemDb().workspaceMember.findUnique({
      where: { tenantId_userId: { tenantId: invitation.tenantId, userId: session.userId } },
      select: { id: true, status: true, joinedAt: true },
    });

    if (existing !== null && existing.status === "ACTIVE") {
      return jsonFail("Already a member of this workspace", 409);
    }
    // A suspended/removed membership is an administrative decision; accepting an
    // invitation must not silently undo it.
    if (existing !== null && existing.status !== "INVITED") {
      return jsonFail("Cannot accept invitation", 409);
    }

    const memberId = existing?.id ?? crypto.randomUUID();
    const ctx = tenantContextForWorkspace(
      invitation.tenantId,
      session.userId,
      memberId,
      req.headers.get("x-request-id") ?? "invitation-accept",
    );

    const outcome = await withTenant(ctx, async (db) => {
      const role = await db.role.findFirst({
        where: { key: invitation.roleKey },
        select: { id: true },
      });
      if (role === null) return { kind: "role-missing" } as const;

      const now = new Date();

      if (existing === null) {
        try {
          await db.workspaceMember.create({
            data: {
              id: memberId,
              tenantId: ctx.tenantId,
              userId: session.userId,
              status: "ACTIVE",
              joinedAt: now,
            },
          });
        } catch (error) {
          if (isUniqueViolation(error)) return { kind: "already-member" } as const;
          throw error;
        }
      } else {
        await db.workspaceMember.updateMany({
          where: { id: memberId },
          data: { status: "ACTIVE", joinedAt: existing.joinedAt ?? now },
        });
      }

      try {
        await db.memberRole.create({
          data: { tenantId: ctx.tenantId, memberId, roleId: role.id },
        });
      } catch (error) {
        // Already holds this exact role: accepting again is not an error.
        if (!isUniqueViolation(error)) throw error;
      }

      const consumed = await db.workspaceInvitation.updateMany({
        where: { id: invitation.id, status: "PENDING" },
        data: {
          status: "ACCEPTED",
          acceptedAt: now,
          acceptedByUserId: session.userId,
        },
      });

      return consumed.count === 1
        ? ({ kind: "accepted" } as const)
        : ({ kind: "not-pending" } as const);
    });

    if (outcome.kind === "role-missing") {
      return jsonFail("Workspace is not ready", 500);
    }
    if (outcome.kind !== "accepted") {
      return jsonFail("Invitation can no longer be accepted", 409);
    }

    await writeAudit({
      tenantId: invitation.tenantId,
      actorType: "USER",
      actorUserId: session.userId,
      actorMemberId: memberId,
      action: "member.accept_invite",
      resourceType: "workspace_invitation",
      resourceId: invitation.id,
      ...auditRequestFields(req),
      // No token, no token hash, no email credential: only the fact of acceptance.
      metadata: { email: invitation.email, roleKey: invitation.roleKey },
    });

    // The acceptance is a privilege change for the caller (a membership was just
    // activated), so the session is rotated and the new cookie is returned with this
    // response — accepting must not sign the user out.
    const rotated = await rotateSession(
      req.cookies.get(getSessionCookieName())?.value ?? "",
      session.userId,
      getClientIp(req),
      req.headers.get("user-agent") ?? "",
    );

    const response = NextResponse.json(
      {
        workspaceId: invitation.tenantId,
        memberId,
        roleKey: invitation.roleKey,
        status: "active",
      },
      { status: 200, headers: NO_STORE },
    );
    response.cookies.set(getSessionCookieName(), rotated.token, sessionCookieOptions(rotated.expiresAt));

    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
