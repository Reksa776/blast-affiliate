import { redirect } from "next/navigation";
import { CampaignDetailManager } from "@/components/campaign-detail-manager";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({ params }: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  const { workspaceId, campaignId } = await params;
  try {
    const grant = await requirePagePermission(workspaceId, "campaign.read");
    return <CampaignDetailManager workspaceId={workspaceId} campaignId={campaignId} canWrite={grant.platformAdmin || grant.permissions.includes("campaign.write")} />;
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect(`/workspaces/${workspaceId}`);
    throw error;
  }
}
