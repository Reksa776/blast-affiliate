import { redirect } from "next/navigation";
import { CampaignManager } from "@/components/campaign-manager";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const grant = await requirePagePermission(workspaceId, "campaign.read");
    return <main className="flex flex-col gap-6"><header><p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300">AffiliateOS · Planning</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Campaigns</h1><p className="mt-2 max-w-2xl text-sm text-slate-400">Atur kalender, anggaran, dan status campaign. Tautkan kreator dan brief dari alur campaign.</p></header><CampaignManager workspaceId={workspaceId} canWrite={grant.platformAdmin || grant.permissions.includes("campaign.write")} canDelete={grant.platformAdmin || grant.permissions.includes("campaign.delete")} /></main>;
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect(`/workspaces/${workspaceId}`);
    throw error;
  }
}
