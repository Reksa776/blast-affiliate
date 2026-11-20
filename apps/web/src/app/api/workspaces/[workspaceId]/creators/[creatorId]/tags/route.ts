import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COLOR = /^#[0-9a-fA-F]{6}$/;

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    const label = typeof body?.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
    const color = body?.color === undefined || body.color === null || body.color === "" ? null : typeof body.color === "string" && COLOR.test(body.color) ? body.color : undefined;
    if (!label || label.length > 64 || color === undefined) return jsonFail("Nama tag atau warna tidak valid", 400);
    const result = await withTenant(ctx, async (db) => {
      const creator = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true } });
      if (!creator) return null;
      let tag = await db.creatorTag.findFirst({ where: { label }, select: { id: true, label: true, color: true } });
      if (!tag) tag = await db.creatorTag.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, label, color }, select: { id: true, label: true, color: true } });
      const assigned = await db.creatorTagAssignment.findFirst({ where: { creatorId, tagId: tag.id }, select: { creatorId: true } });
      if (!assigned) await db.creatorTagAssignment.create({ data: { tenantId: ctx.tenantId, creatorId, tagId: tag.id } });
      return tag;
    });
    if (!result) return jsonFail("Kreator tidak ditemukan", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.tag_add", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { tagId: result.id, label } });
    return NextResponse.json(result, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return jsonFail("Tag dengan nama ini sudah digunakan", 409);
    return handleRouteError(error);
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    if (!body || typeof body.tagId !== "string") return jsonFail("Tag tidak valid", 400);
    const deleted = await withTenant(ctx, (db) => db.creatorTagAssignment.deleteMany({ where: { creatorId, tagId: body.tagId as string } }));
    if (deleted.count === 0) return jsonFail("Tag tidak ditemukan pada kreator", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.tag_remove", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { tagId: body.tagId } });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
