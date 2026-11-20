import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";

import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import {
  auditActorType,
  auditRequestFields,
  handleRouteError,
  jsonFail,
  NO_STORE,
  readJsonObject,
  tenantContextFor,
} from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["NEW", "CONTACTED", "INVITED", "ACCEPTED", "COLLABORATING", "COMPLETED", "REJECTED", "UNRESPONSIVE", "BLACKLISTED"] as const;

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.read");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "creators.list" });
    if (limited) return limited;

    const params = req.nextUrl.searchParams;
    const q = (params.get("q") ?? "").trim().slice(0, 96);
    const status = params.get("status");
    const page = Math.max(1, Math.min(10000, Number.parseInt(params.get("page") ?? "1", 10) || 1));
    const where = {
      deletedAt: null,
      ...(status && (STATUSES as readonly string[]).includes(status) ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(q ? { OR: [{ username: { contains: q } }, { displayName: { contains: q } }] } : {}),
    };
    const result = await withTenant(ctx, async (db) => {
      const [rows, total, statusCounts] = await Promise.all([
        db.creator.findMany({ where, orderBy: [{ updatedAt: "desc" }, { username: "asc" }], skip: (page - 1) * 50, take: 50,
          select: { id: true, username: true, displayName: true, avatarUrl: true, followerCount: true, status: true, createdAt: true,
            blacklist: { select: { reason: true, revokedAt: true } },
            assignments: { where: { isActive: true }, take: 1, select: { member: { select: { user: { select: { displayName: true } } } } } },
            tagAssignments: { select: { tag: { select: { id: true, label: true, color: true } } } },
          } }),
        db.creator.count({ where }),
        db.creator.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
      ]);
      return { rows, total, page, pageSize: 50, statusCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])) };
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "creators.create" });
    if (limited) return limited;

    const body = await readJsonObject(req);
    if (!body) return jsonFail("Invalid JSON body", 400);
    const username = typeof body.username === "string" ? body.username.trim().replace(/^@+/, "").toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().replace(/\s+/g, " ") : "";
    if (!/^[a-z0-9._]{1,96}$/.test(username)) return jsonFail("Username must be 1–96 letters, numbers, dots or underscores", 400);
    if (displayName.length < 1 || displayName.length > 160) return jsonFail("Display name must be 1–160 characters", 400);
    const followerCount = body.followerCount === undefined || body.followerCount === null || body.followerCount === "" ? null : Number(body.followerCount);
    if (followerCount !== null && (!Number.isSafeInteger(followerCount) || followerCount < 0 || followerCount > 4294967295)) return jsonFail("Follower count is invalid", 400);
    const bio = typeof body.bio === "string" ? body.bio.trim() : "";
    const region = typeof body.region === "string" ? body.region.trim().toUpperCase() : "";
    const language = typeof body.language === "string" ? body.language.trim() : "";
    if (bio.length > 4000 || (region && !/^[A-Z]{2}$/.test(region)) || language.length > 16) return jsonFail("Profile details are invalid", 400);

    const id = crypto.randomUUID();
    const row = await withTenant(ctx, async (db) => {
      const created = await db.creator.create({ data: { id, tenantId: ctx.tenantId, username, displayName, followerCount }, select: { id: true, username: true, displayName: true, followerCount: true, status: true, createdAt: true } });
      if (bio || region || language) await db.creatorProfile.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId: id, bio: bio || null, region: region || null, language: language || null } });
      await db.creatorStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId: id, fromStatus: null, toStatus: "NEW", changedByMemberId: grant.member?.id ?? null } });
      return created;
    });
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.create", resourceType: "creator", resourceId: id, ...auditRequestFields(req), metadata: { username } });
    return NextResponse.json(row, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return jsonFail("Creator already exists in this workspace", 409);
    return handleRouteError(error);
  }
}
