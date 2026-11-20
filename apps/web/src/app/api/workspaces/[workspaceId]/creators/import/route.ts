import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenant, writeAudit } from "@affiliateos/database";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requirePermission } from "@/lib/auth/permission";
import { auditActorType, auditRequestFields, handleRouteError, jsonFail, NO_STORE, tenantContextFor } from "@/lib/auth/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("CSV memiliki kutip yang tidak berpasangan.");
  row.push(field);
  if (row.some((item) => item.trim() !== "")) rows.push(row);
  return rows;
}

export async function POST(req: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const grant = await requirePermission(req, workspaceId, "creator.write");
    verifyCsrf(req);
    const ctx = tenantContextFor(grant, grant.member?.tenantId ?? workspaceId, req.headers.get("x-request-id"));
    const text = await req.text();
    if (!text || text.length > 1_000_000) return jsonFail("File CSV kosong atau lebih dari 1 MB", 400);
    let records: string[][];
    try { records = parseCsv(text.replace(/^\uFEFF/, "")); } catch (error) { return jsonFail(error instanceof Error ? error.message : "Format CSV tidak valid", 400); }
    if (records.length < 2) return jsonFail("CSV harus berisi header dan minimal satu baris", 400);
    if (records.length > 501) return jsonFail("Maksimal 500 kreator per impor", 400);
    const headers = records[0]!.map((item) => item.trim().toLowerCase());
    const index = (name: string) => headers.indexOf(name.toLowerCase());
    if (index("username") < 0 || index("displayName") < 0) return jsonFail("Kolom wajib: username, displayName", 400);
    const errors: { row: number; error: string }[] = [];
    let created = 0, updated = 0;
    for (let offset = 1; offset < records.length; offset += 1) {
      const values = records[offset]!;
      const read = (name: string) => { const column = index(name); return column < 0 ? "" : (values[column] ?? "").trim(); };
      const username = read("username").replace(/^@+/, "").toLowerCase();
      const displayName = read("displayName").replace(/\s+/g, " ");
      const followersText = read("followerCount");
      const followerCount = followersText ? Number(followersText) : null;
      const bio = read("bio");
      const region = read("region").toUpperCase();
      const language = read("language");
      if (!/^[a-z0-9._]{1,96}$/.test(username) || !displayName || displayName.length > 160 || (followerCount !== null && (!Number.isSafeInteger(followerCount) || followerCount < 0 || followerCount > 4294967295)) || bio.length > 4000 || (region && !/^[A-Z]{2}$/.test(region)) || language.length > 16) {
        errors.push({ row: offset + 1, error: "Username, nama, followers, atau bio tidak valid" }); continue;
      }
      try {
        const result = await withTenant(ctx, async (db) => {
          const existing = await db.creator.findFirst({ where: { username, deletedAt: null }, select: { id: true } });
          const id = existing?.id ?? crypto.randomUUID();
          if (existing) await db.creator.update({ where: { id }, data: { displayName, followerCount }, select: { id: true } });
          else await db.creator.create({ data: { id, tenantId: ctx.tenantId, username, displayName, followerCount }, select: { id: true } });
          if (bio || region || language) {
            const profile = await db.creatorProfile.findFirst({ where: { creatorId: id }, select: { id: true } });
            const profileData = { bio: bio || null, region: region || null, language: language || null };
            if (profile) await db.creatorProfile.update({ where: { id: profile.id }, data: profileData, select: { id: true } });
            else await db.creatorProfile.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId: id, ...profileData }, select: { id: true } });
          }
          if (!existing) await db.creatorStatusHistory.create({ data: { id: crypto.randomUUID(), tenantId: ctx.tenantId, creatorId: id, fromStatus: null, toStatus: "NEW", changedByMemberId: grant.member?.id ?? null } });
          return Boolean(existing);
        });
        if (result) updated += 1; else created += 1;
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
        errors.push({ row: offset + 1, error: code === "P2002" ? "Username duplikat" : "Baris gagal disimpan" });
      }
    }
    await writeAudit({ tenantId: ctx.tenantId, actorType: auditActorType(grant), actorUserId: grant.session.userId, actorMemberId: grant.member?.id ?? null, action: "creator.import", resourceType: "creator", ...auditRequestFields(req), metadata: { created, updated, failed: errors.length } });
    return NextResponse.json({ created, updated, failed: errors.length, errors }, { status: 200, headers: NO_STORE });
  } catch (error) { return handleRouteError(error); }
}
