import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, readJsonObject, tenantContextFor } from "@/lib/auth/route-support";
import { enforceApiRateLimit } from "@/lib/rate-limit/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 100;

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  try {
    const { workspaceId, campaignId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "campaign.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const limited = await enforceApiRateLimit(req, { scope: "user", key: grant.session.userId, route: "campaigns.bulk_invite" });
    if (limited) return limited;

    const body = await readJsonObject(req);
    if (!body || !Array.isArray(body.creatorIds) || body.creatorIds.length === 0 || body.creatorIds.length > MAX_BATCH_SIZE) {
      return jsonFail(`Pilih 1 sampai ${MAX_BATCH_SIZE} kreator`, 400);
    }
    if (body.creatorIds.some((id) => typeof id !== "string" || id.length > 36 || id.length === 0)) {
      return jsonFail("Daftar kreator tidak valid", 400);
    }
    const outcome = body.outcome === undefined ? "SENT" : body.outcome;
    if (outcome !== "SENT" && outcome !== "FAILED") return jsonFail("Hasil undangan tidak valid", 400);
    const failureReason = typeof body.failureReason === "string" ? body.failureReason.trim() : "";
    if (failureReason.length > 255) return jsonFail("Catatan error maksimal 255 karakter", 400);
    const creatorIds = [...new Set(body.creatorIds as string[])];

    const result = await withTenant(ctx, async (db) => {
      const campaign = await db.campaign.findFirst({ where: { id: campaignId, deletedAt: null }, select: { id: true } });
      if (!campaign) return null;

      const eligible = await db.creator.findMany({
        where: {
          id: { in: creatorIds },
          deletedAt: null,
          status: { not: "BLACKLISTED" },
          OR: [{ blacklist: { is: null } }, { blacklist: { is: { revokedAt: { not: null } } } }],
        },
        select: { id: true },
      });
      const eligibleIds = eligible.map((creator) => creator.id);
      const existing = eligibleIds.length
        ? await db.campaignCreator.findMany({ where: { campaignId, creatorId: { in: eligibleIds } }, select: { id: true, creatorId: true, status: true, inviteAttempts: true } })
        : [];
      const existingByCreator = new Map(existing.map((link) => [link.creatorId, link]));
      let recorded = 0;
      let alreadyAdded = 0;
      const timestamp = new Date();
      for (const creatorId of eligibleIds) {
        const current = existingByCreator.get(creatorId);
        if (current && ["ACCEPTED", "DECLINED", "ACTIVE", "COMPLETED"].includes(current.status)) {
          alreadyAdded += 1;
          continue;
        }
        if (outcome === "SENT" && current?.status === "INVITED") {
          alreadyAdded += 1;
          continue;
        }

        const nextStatus = outcome === "FAILED" ? "INVITE_FAILED" as const : "INVITED" as const;
        const inviteData = {
          status: nextStatus,
          inviteAttempts: (current?.inviteAttempts ?? 0) + 1,
          inviteError: outcome === "FAILED" ? failureReason || "Pengiriman manual gagal." : null,
          ...(outcome === "SENT" ? { invitedAt: timestamp } : {}),
          respondedAt: null,
        };
        if (current) {
          await db.campaignCreator.update({ where: { id: current.id }, data: inviteData, select: { id: true } });
        } else {
          await db.campaignCreator.create({
            data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, campaignId, creatorId, ...inviteData },
            select: { id: true },
          });
        }
        recorded += 1;
      }
      return {
        recorded,
        alreadyAdded,
        skipped: creatorIds.length - eligibleIds.length,
      };
    });

    if (!result) return jsonFail("Campaign tidak ditemukan", 404);
    if (result.recorded > 0) {
      await writeAudit({
        tenantId: ctx.tenantId,
        actorType: auditActorType(grant),
        actorUserId: grant.session.userId,
        actorMemberId: grant.member?.id ?? null,
        action: outcome === "FAILED" ? "campaign.creator_bulk_invite_failed" : "campaign.creator_bulk_invite",
        resourceType: "campaign",
        resourceId: campaignId,
        ...auditRequestFields(req),
        metadata: { requestedCount: creatorIds.length, outcome, ...result },
      });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return handleRouteError(error);
  }
}
