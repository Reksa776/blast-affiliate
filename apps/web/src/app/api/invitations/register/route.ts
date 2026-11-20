import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { systemDb, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { getClientIp } from "@/lib/auth/middleware";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject } from "@/lib/auth/route-support";
import { getSessionCookieName } from "@/lib/auth/cookie-name";
import { createSession, sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(crypto.createHash("sha256").update(value, "utf8").digest());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { verifyCsrf(req); } catch { return jsonFail("Missing or invalid CSRF token", 403); }
  const ip = getClientIp(req);
  const limit = consumeRateLimit(`invitation-register:${ip}`, 5, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSeconds) } });
  const body = await readJsonObject(req);
  if (!body) return jsonFail("Invalid JSON body", 400);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return jsonFail("Undangan tidak valid atau sudah kedaluwarsa", 400);
  if (!name || name.length > 120 || password.length < PASSWORD_MIN_LENGTH) return jsonFail(`Isi nama dan password minimal ${PASSWORD_MIN_LENGTH} karakter`, 400);

  const invitationTokenHash = sha256Bytes(token);
  const now = new Date();
  // SYSTEM: validate the one-time secret before spending CPU on an Argon2 hash.
  const preliminary = await systemDb().workspaceInvitation.findUnique({ where: { tokenHash: invitationTokenHash }, select: { status: true, expiresAt: true } });
  if (!preliminary || preliminary.status !== "PENDING" || preliminary.expiresAt <= now) return jsonFail("Undangan tidak valid atau sudah kedaluwarsa", 400);
  const passwordHash = await hashPassword(password);
  try {
    // SYSTEM: the unguessable invitation token resolves the tenant and authorizes
    // this first account + membership creation as one transaction.
    const outcome = await systemDb().$transaction(async (tx) => {
      const invitation = await tx.workspaceInvitation.findUnique({ where: { tokenHash: invitationTokenHash }, select: { id: true, tenantId: true, email: true, roleKey: true, status: true, expiresAt: true } });
      if (!invitation || invitation.status !== "PENDING" || invitation.expiresAt <= now) return { kind: "invalid" } as const;
      const existingUser = await tx.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
      if (existingUser) return { kind: "existing-user" } as const;
      const consumed = await tx.workspaceInvitation.updateMany({ where: { id: invitation.id, status: "PENDING", expiresAt: { gt: now } }, data: { status: "ACCEPTED", acceptedAt: now } });
      if (consumed.count !== 1) return { kind: "invalid" } as const;
      const userId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const user = await tx.user.create({ data: { id: userId, email: invitation.email, displayName: name, passwordHash }, select: { id: true, email: true, displayName: true } });
      await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedByUserId: userId } });
      const role = await tx.role.findFirst({ where: { tenantId: invitation.tenantId, key: invitation.roleKey }, select: { id: true } });
      if (!role) throw new Error("Invitation role is missing from workspace setup.");
      await tx.workspaceMember.create({ data: { id: memberId, tenantId: invitation.tenantId, userId, status: "ACTIVE", joinedAt: now } });
      await tx.memberRole.create({ data: { tenantId: invitation.tenantId, memberId, roleId: role.id } });
      return { kind: "created", user, memberId, workspaceId: invitation.tenantId, roleKey: invitation.roleKey, invitationId: invitation.id } as const;
    });
    if (outcome.kind === "invalid") return jsonFail("Undangan tidak valid atau sudah kedaluwarsa", 400);
    if (outcome.kind === "existing-user") return jsonFail("Akun dengan email ini sudah ada. Masuk, lalu terima undangan.", 409);

    await writeAudit({ tenantId: outcome.workspaceId, actorType: "USER", actorUserId: outcome.user.id, actorMemberId: outcome.memberId, action: "member.accept_invite", resourceType: "workspace_invitation", resourceId: outcome.invitationId, ...auditRequestFields(req), metadata: { email: outcome.user.email, roleKey: outcome.roleKey, accountCreatedFromInvite: true } });
    const session = await createSession(outcome.user.id, ip, req.headers.get("user-agent") ?? "");
    const response = NextResponse.json({ workspaceId: outcome.workspaceId, memberId: outcome.memberId, roleKey: outcome.roleKey, status: "active" }, { status: 201, headers: NO_STORE });
    response.cookies.set(getSessionCookieName(), session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return jsonFail("Akun sudah ada atau undangan sudah digunakan", 409);
    return handleRouteError(error);
  }
}
