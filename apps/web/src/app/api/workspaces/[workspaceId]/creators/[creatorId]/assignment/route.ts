import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.assign");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    if (!body || typeof body.memberId !== "string" || body.memberId.length > 36) return jsonFail("Anggota tim tidak valid", 400);
    const result = await withTenant(ctx, async (db) => {
      const creator = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true } });
      if (!creator) return { kind: "missing-creator" } as const;
      const member = await db.workspaceMember.findFirst({ where: { id: body.memberId as string, status: "ACTIVE" }, select: { id: true } });
      if (!member) return { kind: "missing-member" } as const;
      const current = await db.creatorAssignment.findFirst({ where: { creatorId, isActive: true }, select: { id: true, memberId: true } });
      if (current?.memberId === member.id) return { kind: "unchanged", memberId: member.id } as const;
      if (current) await db.creatorAssignment.update({ where: { id: current.id }, data: { isActive: false, unassignedAt: new Date() }, select: { id: true } });
      await db.creatorAssignment.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, memberId: member.id, assignedByMemberId: grant.member?.id ?? null }, select: { id: true } });
      await db.creatorActivity.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, type: "ASSIGNMENT", summary: "PIC kreator diperbarui", actorMemberId: grant.member?.id ?? null, metadata: { memberId: member.id } } });
      return { kind: "assigned", memberId: member.id } as const;
    });
    if (result.kind === "missing-creator") return jsonFail("Kreator tidak ditemukan", 404);
    if (result.kind === "missing-member") return jsonFail("Anggota aktif tidak ditemukan di workspace ini", 404);
    if (result.kind === "assigned") await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.assign", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { memberId: result.memberId } });
    return NextResponse.json({ creatorId, memberId: result.memberId }, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.assign");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const current = await withTenant(ctx, async (db) => {
      const active = await db.creatorAssignment.findFirst({ where: { creatorId, isActive: true }, select: { id: true, memberId: true } });
      if (!active) return null;
      await db.creatorAssignment.update({ where: { id: active.id }, data: { isActive: false, unassignedAt: new Date() }, select: { id: true } });
      await db.creatorActivity.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, type: "ASSIGNMENT", summary: "PIC kreator dilepas", actorMemberId: grant.member?.id ?? null, metadata: { memberId: active.memberId } } });
      return active.memberId;
    });
    if (!current) return jsonFail("Kreator belum memiliki PIC", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.unassign", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { memberId: current } });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
