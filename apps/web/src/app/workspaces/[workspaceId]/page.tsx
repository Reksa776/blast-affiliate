import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withTenant } from "@affiliateos/database";

import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { tenantContextFor } from "@/lib/auth/route-support";
import { readOfficeSettings } from "@/lib/workspaces/data";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ workspaceId: string }> };

/** Workspace dashboard shell content (P1 MEDIUM #6, item 3c). */
export default async function WorkspaceOverviewPage({ params }: PageProps) {
  const { workspaceId } = await params;

  let data;

  try {
    const grant = await requirePagePermission(workspaceId, "workspace.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      "workspace-overview",
    );

    data = await withTenant(ctx, async (db) => {
      const office = await readOfficeSettings(db, ctx.tenantId);
      if (office === null) return null;

      return {
        office,
        memberCount: await db.workspaceMember.count(),
        auditCount: await db.auditLog.count(),
        creatorCount: await db.creator.count({ where: { deletedAt: null } }),
        campaignCount: await db.campaign.count({ where: { deletedAt: null } }),
        canAudit: grant.platformAdmin || grant.permissions.includes("audit.read"),
      };
    });
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect("/workspaces");
    throw error;
  }

  if (data === null) notFound();

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{data.office.name}</h1>
        <p className="mt-1 font-mono text-xs text-slate-400">{data.office.slug}</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Creators</p>
          <p className="mt-2 text-2xl font-semibold">{data.creatorCount}</p>
          <Link className="mt-2 inline-block text-xs text-slate-300 hover:underline" href={`/workspaces/${workspaceId}/creators`}>Open CRM →</Link>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Campaigns</p>
          <p className="mt-2 text-2xl font-semibold">{data.campaignCount}</p>
          <Link className="mt-2 inline-block text-xs text-slate-300 hover:underline" href={`/workspaces/${workspaceId}/campaigns`}>Manage campaigns →</Link>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Members</p>
          <p className="mt-2 text-2xl font-semibold">{data.memberCount}</p>
          <Link className="mt-2 inline-block text-xs text-slate-300 hover:underline" href={`/workspaces/${workspaceId}/members`}>
            Manage members →
          </Link>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Audit events</p>
          <p className="mt-2 text-2xl font-semibold">{data.auditCount}</p>
          {data.canAudit ? (
            <Link className="mt-2 inline-block text-xs text-slate-300 hover:underline" href={`/workspaces/${workspaceId}/audit`}>
              Open audit log →
            </Link>
          ) : (
            <p className="mt-2 text-xs text-slate-500">Your role cannot read the audit log.</p>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Work hours</p>
          <p className="mt-2 font-mono text-lg">
            {data.office.workStart}–{data.office.workEnd}
          </p>
          <p className="mt-1 text-xs text-slate-500">{data.office.timezone}</p>
          <Link className="mt-2 inline-block text-xs text-slate-300 hover:underline" href={`/workspaces/${workspaceId}/office`}>
            Office settings →
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-violet-900/60 bg-violet-950/20 p-5 text-sm text-slate-300">
        <h2 className="text-lg font-semibold text-slate-100">Mulai operasional</h2>
        <p className="mt-2">Tambahkan kreator ke CRM, catat perkembangan hubungan, lalu susun campaign. Data TikTok langsung belum masuk sampai koneksi dan akses API disiapkan.</p>
      </section>
    </main>
  );
}
