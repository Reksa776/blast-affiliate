import { redirect } from "next/navigation";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { CreatorManager } from "@/components/creator-manager";

export const dynamic = "force-dynamic";

export default async function CreatorsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const grant = await requirePagePermission(workspaceId, "creator.read");
    return <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">AffiliateOS · CRM</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Creator CRM</h1><p className="mt-2 max-w-2xl text-sm text-slate-400">Kelola database kreator, pantau tahap hubungan, dan siapkan tim untuk kampanye.</p></div>
        <span className="rounded-full border border-amber-800/70 bg-amber-950/30 px-3 py-1 text-xs text-amber-200">Data manual · TikTok belum terhubung</span>
      </header>
      <CreatorManager workspaceId={workspaceId} canWrite={grant.platformAdmin || grant.permissions.includes("creator.write")} canExport={grant.platformAdmin || grant.permissions.includes("creator.export")} />
    </main>;
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect(`/workspaces/${workspaceId}`);
    throw error;
  }
}
