import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.read");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "campaigns.list" });
    if (limited) return limited;
    const rows = await withTenant(ctx, (db) => db.campaign.findMany({ where: { deletedAt: null }, orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }], take: 200,
      select: { id: true, name: true, shopName: true, status: true, startsAt: true, endsAt: true, budget: true, currency: true, createdAt: true, _count: { select: { creators: true } } } }));
    return NextResponse.json({ campaigns: rows }, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "campaigns.create" });
    if (limited) return limited;
    const body = await readJsonObject(req);
    if (!body) return jsonFail("Invalid JSON body", 400);
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    const shopName = typeof body.shopName === "string" ? body.shopName.trim() : "";
    const startsAt = typeof body.startsAt === "string" ? new Date(`${body.startsAt}T00:00:00.000Z`) : null;
    const endsAt = typeof body.endsAt === "string" && body.endsAt ? new Date(`${body.endsAt}T23:59:59.999Z`) : null;
    const budget = body.budget === undefined || body.budget === null || body.budget === "" ? null : String(body.budget).trim();
    if (!name || name.length > 160) return jsonFail("Nama campaign wajib diisi (maksimal 160 karakter)", 400);
    if (shopName.length > 160) return jsonFail("Nama toko maksimal 160 karakter", 400);
    if (!startsAt || Number.isNaN(startsAt.getTime()) || (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt < startsAt))) return jsonFail("Rentang tanggal campaign tidak valid", 400);
    if (budget !== null && !/^\d{1,16}(\.\d{1,2})?$/.test(budget)) return jsonFail("Anggaran harus bernilai positif dengan maksimal dua desimal", 400);
    const id = crypto.randomUUID();
    const campaign = await withTenant(ctx, async (db) => {
      const created = await db.campaign.create({ data: { id, tenantId: ctx.tenantId, name, shopName: shopName || null, startsAt, endsAt, budget, currency: "IDR" }, select: { id: true, name: true, shopName: true, status: true, startsAt: true, endsAt: true, budget: true, currency: true, createdAt: true } });
      await db.campaignStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, campaignId: id, fromStatus: null, toStatus: "DRAFT", changedByMemberId: grant.member?.id ?? null } });
      return created;
    });
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "campaign.create", resourceType: "campaign", resourceId: id, ...auditRequestFields(req), metadata: { name, shopName: shopName || null } });
    return NextResponse.json(campaign, { status: 201, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
