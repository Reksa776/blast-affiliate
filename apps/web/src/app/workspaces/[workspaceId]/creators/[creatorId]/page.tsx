import { redirect } from "next/navigation";
import { CreatorDetailManager } from "@/components/creator-detail-manager";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";

export const dynamic = "force-dynamic";

export default async function CreatorDetailPage({ params }: { params: Promise<{ workspaceId: string; creatorId: string }> }) {
  const { workspaceId, creatorId } = await params;
  try {
    const grant = await requirePagePermission(workspaceId, "creator.read");
    return <CreatorDetailManager workspaceId={workspaceId} creatorId={creatorId} canWrite={grant.platformAdmin || grant.permissions.includes("creator.write")} canBlacklist={grant.platformAdmin || grant.permissions.includes("creator.blacklist")} canAssign={grant.platformAdmin || grant.permissions.includes("creator.assign")} />;
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect(`/workspaces/${workspaceId}`);
    throw error;
  }
}
