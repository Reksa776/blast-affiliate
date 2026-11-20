import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@affiliateos/database";
import { requirePermission } from "@/lib/auth/permission";
import { handleRouteError, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function cell(value: unknown): string { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export async function GET(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.export");
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const rows = await withTenant(ctx, (db) => db.creator.findMany({ where: { deletedAt: null }, orderBy: { username: "asc" }, take: 10000, select: { username: true, displayName: true, followerCount: true, status: true, profile: { select: { bio: true, region: true, language: true } }, tagAssignments: { select: { tag: { select: { label: true } } } } } }));
    const csv = [
      ["username", "displayName", "followerCount", "status", "bio", "region", "language", "tags"].map(cell).join(","),
      ...rows.map((row) => [row.username, row.displayName, row.followerCount, row.status, row.profile?.bio, row.profile?.region, row.profile?.language, row.tagAssignments.map((item) => item.tag.label).join("|")].map(cell).join(",")),
    ].join("\r\n");
    return new NextResponse(`\uFEFF${csv}`, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="creators-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
  } catch (error) { return handleRouteError(error); }
}
