import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATUSES = ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.read");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const campaign = await withTenant(ctx, (db) => db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: {
      id: true, name: true, shopName: true, status: true, startsAt: true, endsAt: true, budget: true, currency: true,
      creators: { where: { status: { not: "REMOVED" } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, invitedAt: true, inviteAttempts: true, inviteError: true, creator: { select: { id: true, username: true, displayName: true, followerCount: true } } } },
      contents: { where: { deletedAt: null }, orderBy: [{ kind: "asc" }, { version: "desc" }], select: { id: true, kind: true, version: true, title: true, body: true, createdAt: true } },
    } }));
    return campaign ? NextResponse.json(campaign, { headers: NO_STORE }) : jsonFail("Campaign tidak ditemukan", 404);
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    if (!body) return jsonFail("Invalid JSON body", 400);
    const changes: { name?: string; shopName?: string | null; startsAt?: Date; endsAt?: Date | null; budget?: string | null; status?: (typeof STATUSES)[number] } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") return jsonFail("Nama campaign tidak valid", 400);
      const name = body.name.trim().replace(/\s+/g, " ");
      if (!name || name.length > 160) return jsonFail("Nama campaign tidak valid", 400);
      changes.name = name;
    }
    if (body.shopName !== undefined) {
      if (body.shopName !== null && typeof body.shopName !== "string") return jsonFail("Nama toko tidak valid", 400);
      const shopName = typeof body.shopName === "string" ? body.shopName.trim() : "";
      if (shopName.length > 160) return jsonFail("Nama toko maksimal 160 karakter", 400);
      changes.shopName = shopName || null;
    }
    if (body.startsAt !== undefined) {
      if (typeof body.startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.startsAt)) return jsonFail("Tanggal mulai tidak valid", 400);
      const date = new Date(`${body.startsAt}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.startsAt) return jsonFail("Tanggal mulai tidak valid", 400);
      changes.startsAt = date;
    }
    if (body.endsAt !== undefined) {
      if (body.endsAt === null || body.endsAt === "") changes.endsAt = null;
      else if (typeof body.endsAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.endsAt)) {
        const date = new Date(`${body.endsAt}T23:59:59.999Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.endsAt) return jsonFail("Tanggal selesai tidak valid", 400);
        changes.endsAt = date;
      } else return jsonFail("Tanggal selesai tidak valid", 400);
    }
    if (body.budget !== undefined) {
      if (body.budget === null || body.budget === "") changes.budget = null;
      else {
        const budget = String(body.budget).trim();
        if (!/^\d{1,16}(\.\d{1,2})?$/.test(budget)) return jsonFail("Anggaran tidak valid", 400);
        changes.budget = budget;
      }
    }
    if (body.status !== undefined) {
      if (!(STATUSES as readonly unknown[]).includes(body.status)) return jsonFail("Status campaign tidak valid", 400);
      changes.status = body.status as (typeof STATUSES)[number];
    }
    if (Object.keys(changes).length === 0) return jsonFail("Tidak ada perubahan", 400);
    const result = await withTenant(ctx, async (db) => {
      const current = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true, status: true, startsAt: true, endsAt: true } });
      if (!current) return null;
      const effectiveStart = changes.startsAt ?? current.startsAt;
      const effectiveEnd = changes.endsAt === undefined ? current.endsAt : changes.endsAt;
      if (effectiveEnd && effectiveEnd < effectiveStart) return { kind: "invalid-dates" } as const;
      const status = changes.status ?? current.status;
      const updated = await db.campaign.update({ where: { id: campaignId }, data: changes, select: { id: true, name: true, shopName: true, status: true, startsAt: true, endsAt: true, budget: true, currency: true } });
      if (status !== current.status) await db.campaignStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, campaignId, fromStatus: current.status, toStatus: status, changedByMemberId: grant.member?.id ?? null } });
      return { kind: "updated", changedStatus: status !== current.status, previous: current.status, campaign: updated } as const;
    });
    if (!result) return jsonFail("Campaign tidak ditemukan", 404);
    if (result.kind === "invalid-dates") return jsonFail("Tanggal selesai tidak boleh sebelum tanggal mulai", 400);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: result.changedStatus ? "campaign.status_change" : "campaign.update", resourceType: "campaign", resourceId: campaignId, ...auditRequestFields(req), metadata: result.changedStatus ? { fields: Object.keys(changes), from: result.previous, to: result.campaign.status } : { fields: Object.keys(changes) } });
    return NextResponse.json(result.campaign, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.delete");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const archived = await withTenant(ctx, async (db) => {
      const current = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!current) return false;
      await db.campaign.update({ where: { id: campaignId }, data: { deletedAt: new Date() }, select: { id: true } });
      return true;
    });
    if (!archived) return jsonFail("Campaign tidak ditemukan", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "campaign.archive", resourceType: "campaign", resourceId: campaignId, ...auditRequestFields(req) });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
