import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!title || title.length > 160 || !text || text.length > 30000) return jsonFail("Judul dan isi brief wajib diisi", 400);
    const record = await withTenant(ctx, async (db) => {
      const campaign = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!campaign) return null;
      const latest = await db.campaignContent.findFirst({ where: { campaignId, kind: "BRIEF", deletedAt: null }, orderBy: { version: "desc" }, select: { version: true } });
      return db.campaignContent.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, campaignId, kind: "BRIEF", version: (latest?.version ?? 0) + 1, title, body: text, createdByMemberId: grant.member?.id ?? null }, select: { id: true, version: true, title: true, body: true, createdAt: true } });
    });
    if (!record) return jsonFail("Campaign tidak ditemukan", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "campaign.brief_create", resourceType: "campaign_content", resourceId: record.id, ...auditRequestFields(req), metadata: { campaignId, version: record.version, title } });
    return NextResponse.json(record, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return jsonFail("Brief baru saja diperbarui. Coba lagi.", 409);
    return handleRouteError(error);
  }
}
