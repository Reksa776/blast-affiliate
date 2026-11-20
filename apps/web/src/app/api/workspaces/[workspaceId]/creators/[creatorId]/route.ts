import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATUSES = ["NEW", "CONTACTED", "INVITED", "ACCEPTED", "COLLABORATING", "COMPLETED", "REJECTED", "UNRESPONSIVE", "BLACKLISTED"] as const;

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.read");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const creator = await withTenant(ctx, (db) => db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: {
      id: true, username: true, displayName: true, avatarUrl: true, followerCount: true, status: true, createdAt: true, updatedAt: true,
      profile: { select: { bio: true, region: true, language: true, metrics: true, metricsCapturedAt: true } },
      notes: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, body: true, createdAt: true, authorMemberId: true } },
      activities: { orderBy: { occurredAt: "desc" }, take: 100, select: { id: true, type: true, summary: true, occurredAt: true } },
      statusHistory: { orderBy: { changedAt: "desc" }, take: 50, select: { id: true, fromStatus: true, toStatus: true, reason: true, changedAt: true } },
      blacklist: { select: { reason: true, scope: true, createdAt: true, revokedAt: true } },
      assignments: { where: { isActive: true }, take: 1, select: { id: true, memberId: true, member: { select: { user: { select: { displayName: true } } } } } },
      tagAssignments: { select: { tag: { select: { id: true, label: true, color: true } } } },
    } }));
    return creator ? NextResponse.json(creator, { headers: NO_STORE }) : jsonFail("Not found", 404);
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "creators.update" });
    if (limited) return limited;
    const body = await readJsonObject(req);
    if (!body) return jsonFail("Invalid JSON body", 400);
    const changes: { username?: string; displayName?: string; followerCount?: number | null; status?: (typeof STATUSES)[number] } = {};
    const profileChanges: { bio?: string | null; region?: string | null; language?: string | null } = {};
    if (body.username !== undefined) {
      if (typeof body.username !== "string") return jsonFail("Invalid username", 400);
      const username = body.username.trim().replace(/^@+/, "").toLowerCase();
      if (!/^[a-z0-9._]{1,96}$/.test(username)) return jsonFail("Invalid username", 400);
      changes.username = username;
    }
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== "string") return jsonFail("Invalid display name", 400);
      const displayName = body.displayName.trim().replace(/\s+/g, " ");
      if (!displayName || displayName.length > 160) return jsonFail("Invalid display name", 400);
      changes.displayName = displayName;
    }
    if (body.followerCount !== undefined) {
      const count = body.followerCount === null || body.followerCount === "" ? null : Number(body.followerCount);
      if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 4294967295)) return jsonFail("Invalid follower count", 400);
      changes.followerCount = count;
    }
    if (body.bio !== undefined) {
      if (typeof body.bio !== "string" || body.bio.trim().length > 4000) return jsonFail("Invalid bio", 400);
      profileChanges.bio = body.bio.trim() || null;
    }
    if (body.region !== undefined) {
      if (typeof body.region !== "string" || (body.region.trim() !== "" && !/^[A-Za-z]{2}$/.test(body.region.trim()))) return jsonFail("Invalid region", 400);
      profileChanges.region = body.region.trim().toUpperCase() || null;
    }
    if (body.language !== undefined) {
      if (typeof body.language !== "string" || body.language.trim().length > 16) return jsonFail("Invalid language", 400);
      profileChanges.language = body.language.trim() || null;
    }
    if (body.status !== undefined && !(STATUSES as readonly unknown[]).includes(body.status)) return jsonFail("Invalid status", 400);
    const outcome = await withTenant(ctx, async (db) => {
      const current = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true, status: true, profile: { select: { id: true } } } });
      if (!current) return null;
      if (current.status === "BLACKLISTED" && body.status !== undefined && body.status !== "BLACKLISTED") return { error: "Cabut blacklist sebelum mengubah tahap kreator." } as const;
      if (body.status === "BLACKLISTED" && current.status !== "BLACKLISTED") return { error: "Gunakan aksi blacklist dan sertakan alasan." } as const;
      if (body.status !== undefined && body.status !== current.status) changes.status = body.status as (typeof STATUSES)[number];
      const updated = Object.keys(changes).length ? await db.creator.update({ where: { id: creatorId }, data: changes, select: { id: true, username: true, displayName: true, followerCount: true, status: true, updatedAt: true } }) : await db.creator.findFirst({ where: { id: creatorId }, select: { id: true, username: true, displayName: true, followerCount: true, status: true, updatedAt: true } });
      if (Object.keys(profileChanges).length) {
        if (current.profile) await db.creatorProfile.update({ where: { id: current.profile.id }, data: profileChanges, select: { id: true } });
        else await db.creatorProfile.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, ...profileChanges }, select: { id: true } });
      }
      if (body.status !== undefined && body.status !== current.status) {
        await db.creatorStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId, fromStatus: current.status, toStatus: body.status as (typeof STATUSES)[number], changedByMemberId: grant.member?.id ?? null } });
      }
      return { updated, previousStatus: current.status } as const;
    });
    if (!outcome) return jsonFail("Not found", 404);
    if ("error" in outcome && typeof outcome.error === "string") return jsonFail(outcome.error, 400);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.update", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req), metadata: { fields: [...Object.keys(changes), ...Object.keys(profileChanges)], statusFrom: outcome.previousStatus, statusTo: outcome.updated?.status } });
    return NextResponse.json(outcome.updated, { headers: NO_STORE });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return jsonFail("Username already exists in this workspace", 409);
    return handleRouteError(error);
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  try {
    const { workspaceId, creatorId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.delete");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const outcome = await withTenant(ctx, async (db) => {
      const row = await db.creator.findFirst({ where: { id: creatorId, deletedAt: null }, select: { id: true } });
      if (!row) return false;
      await db.creator.update({ where: { id: creatorId }, data: { deletedAt: new Date() }, select: { id: true } });
      return true;
    });
    if (!outcome) return jsonFail("Not found", 404);
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.archive", resourceType: "creator", resourceId: creatorId, ...auditRequestFields(req) });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
