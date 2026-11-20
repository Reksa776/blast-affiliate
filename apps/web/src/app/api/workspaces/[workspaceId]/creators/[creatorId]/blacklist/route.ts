import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.blacklist");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 255) return jsonFail("Alasan wajib diisi (maksimal 255 karakter)", 400);
    const outcome = await withTenant(ctx, async (db) => {
      const creator = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true, status: true, blacklist: { select: { id: true, revokedAt: true } } } });
      if (!creator) return { kind: "missing" } as const;
      if (creator.blacklist && creator.blacklist.revokedAt === null) return { kind: "exists" } as const;
      if (creator.blacklist) await db.creatorBlacklist.update({ where: { id: creator.blacklist.id }, data: { reason, revokedAt: null, createdAt: new Date(), createdByMemberId: grant.member?.id ?? null }, select: { id: true } });
      else await db.creatorBlacklist.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, reason, createdByMemberId: grant.member?.id ?? null }, select: { id: true } });
      if (creator.status !== "BLACKLISTED") {
        await db.creator.update({ where: { id: creatorId }, data: { status: "BLACKLISTED" }, select: { id: true } });
        await db.creatorStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, fromStatus: creator.status, toStatus: "BLACKLISTED", reason, changedByMemberId: grant.member?.id ?? null } });
      }
      return { kind: "updated" } as const;
    });
    if (outcome.kind === "missing") return jsonFail("Kreator tidak ditemukan", 404);
    if (outcome.kind === "exists") return jsonFail("Kreator sudah masuk blacklist", 409);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.blacklist", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { reason } });
    return NextResponse.json({ id: creatorId, status: "BLACKLISTED" }, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.blacklist");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const restoredStatus = await withTenant(ctx, async (db) => {
      const creator = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true, status: true, blacklist: { select: { id: true, revokedAt: true } } } });
      if (!creator || !creator.blacklist || creator.blacklist.revokedAt !== null) return null;
      await db.creatorBlacklist.update({ where: { id: creator.blacklist.id }, data: { revokedAt: new Date() }, select: { id: true } });
      const prior = await db.creatorStatusHistory.findFirst({ where: { creatorId, toStatus: { not: "BLACKLISTED" } }, orderBy: { changedAt: "desc" }, select: { toStatus: true } });
      const status = prior?.toStatus ?? "NEW";
      await db.creator.update({ where: { id: creatorId }, data: { status }, select: { id: true } });
      await db.creatorStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, fromStatus: "BLACKLISTED", toStatus: status, reason: "Blacklist dicabut", changedByMemberId: grant.member?.id ?? null } });
      return status;
    });
    if (!restoredStatus) return jsonFail("Kreator aktif tidak ditemukan di blacklist", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.unblacklist", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { restoredStatus } });
    return NextResponse.json({ id: creatorId, status: restoredStatus }, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
