import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.read");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const data = await withTenant(ctx, async (db) => {
      const campaign = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!campaign) return null;
      const [assigned, failedLinks] = await Promise.all([
        db.campaignCreator.findMany({ where: { campaignId, status: { notIn: ["REMOVED", "INVITE_FAILED"] } }, select: { creatorId: true } }),
        db.campaignCreator.findMany({ where: { campaignId, status: "INVITE_FAILED" }, select: { creatorId: true, inviteError: true, inviteAttempts: true } }),
      ]);
      const excluded = assigned.map((row) => row.creatorId);
      const available = await db.creator.findMany({ where: { deletedAt: null, status: { not: "BLACKLISTED" }, OR: [{ blacklist: { is: null } }, { blacklist: { is: { revokedAt: { not: null } } } }], ...(excluded.length ? { id: { notIn: excluded } } : {}) }, orderBy: { displayName: "asc" }, take: 200, select: { id: true, username: true, displayName: true, followerCount: true } });
      const failedByCreatorId = new Map(failedLinks.map((link) => [link.creatorId, link]));
      return { available: available.map((creator) => {
        const failed = failedByCreatorId.get(creator.id);
        return { ...creator, previousInviteError: failed?.inviteError ?? null, inviteAttempts: failed?.inviteAttempts ?? 0 };
      }) };
    });
    return data ? NextResponse.json(data, { headers: NO_STORE }) : jsonFail("Campaign tidak ditemukan", 404);
  } catch (error) { return handleRouteError(error); }
}

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "campaigns.add_creator" });
    if (limited) return limited;
    const body = await readJsonObject(req);
    if (!body || typeof body.creatorId !== "string" || body.creatorId.length > 36) return jsonFail("Creator tidak valid", 400);
    const result = await withTenant(ctx, async (db) => {
      const campaign = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!campaign) return { kind: "missing-campaign" } as const;
      const creator = await db.creator.findFirst({ where: { id: body.creatorId as string, deletedAt: null }, select: { id: true, username: true, status: true, blacklist: { select: { revokedAt: true } } } });
      if (!creator) return { kind: "missing-creator" } as const;
      if (creator.status === "BLACKLISTED" || (creator.blacklist !== null && creator.blacklist.revokedAt === null)) return { kind: "blocked" } as const;
      const existing = await db.campaignCreator.findFirst({ where: { campaignId, creatorId: creator.id }, select: { id: true, status: true } });
      if (existing && existing.status !== "REMOVED") return { kind: "duplicate" } as const;
      if (existing) {
        const link = await db.campaignCreator.update({ where: { id: existing.id }, data: { status: "INVITED", invitedAt: new Date(), respondedAt: null }, select: { id: true, creatorId: true, status: true } });
        return { kind: "created", link, username: creator.username } as const;
      }
      const link = await db.campaignCreator.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, campaignId, creatorId: creator.id, status: "INVITED" }, select: { id: true, creatorId: true, status: true } });
      return { kind: "created", link, username: creator.username } as const;
    });
    if (result.kind === "missing-campaign") return jsonFail("Campaign tidak ditemukan", 404);
    if (result.kind === "missing-creator") return jsonFail("Kreator tidak ditemukan", 404);
    if (result.kind === "blocked") return jsonFail("Kreator blacklist tidak dapat dimasukkan ke campaign", 409);
    if (result.kind === "duplicate") return jsonFail("Kreator sudah ada di campaign ini", 409);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "campaign.creator_invite", resourceType: "campaign_creator", resourceId: result.link.id, ...auditRequestFields(req), metadata: { campaignId, creatorId: result.link.creatorId, username: result.username } });
    return NextResponse.json(result.link, { status: 201, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const body = await readJsonObject(req);
    if (!body || typeof body.creatorId !== "string") return jsonFail("Creator tidak valid", 400);
    const link = await withTenant(ctx, async (db) => {
      const existing = await db.campaignCreator.findFirst({ where: { campaignId, creatorId: body.creatorId as string, status: { not: "REMOVED" } }, select: { id: true } });
      if (!existing) return null;
      return db.campaignCreator.update({ where: { id: existing.id }, data: { status: "REMOVED", respondedAt: new Date() }, select: { id: true, creatorId: true } });
    });
    if (!link) return jsonFail("Creator tidak ditemukan dalam campaign", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "campaign.creator_remove", resourceType: "campaign_creator", resourceId: link.id, ...auditRequestFields(req), metadata: { campaignId, creatorId: link.creatorId } });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
