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
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text || text.length > 10000) return jsonFail("Catatan wajib diisi (maksimal 10.000 karakter)", 400);
    const note = await withTenant(ctx, async (db) => {
      const creator = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true } });
      if (!creator) return null;
      const id = crypto.randomUUID();
      const created = await db.creatorNote.create({ data: { id, tenantId: ctx.tenantId, creatorId, authorMemberId: grant.member?.id ?? null, body: text }, select: { id: true, body: true, createdAt: true, authorMemberId: true } });
      await db.creatorActivity.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, type: "NOTE", summary: text.slice(0, 255), actorMemberId: grant.member?.id ?? null, metadata: { noteId: id } } });
      return created;
    });
    if (!note) return jsonFail("Kreator tidak ditemukan", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.note_add", resourceType: "creator_note", resourceId: note.id, ...auditRequestFields(req), metadata: { creatorId } });
    return NextResponse.json(note, { status: 201, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
