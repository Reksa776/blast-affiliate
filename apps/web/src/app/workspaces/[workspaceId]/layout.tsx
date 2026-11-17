import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { withTenant } from "@affiliateos/database";

import { SignOutButton } from "@/components/sign-out-button";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { tenantContextFor } from "@/lib/auth/route-support";

export const dynamic = "force-dynamic";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
};

/**
 * Shell for every workspace page: header (switcher + user menu), sidebar, content.
 *
 * Authorization happens here AND in each page. This is not redundancy for its own
 * sake: the layout needs the workspace name/permissions to render navigation, while
 * the page needs its own grant to scope its query. Both call the same
 * `requirePagePermission`, so they cannot disagree about who the caller is.
 */
export default async function WorkspaceLayout({ children, params }: LayoutProps) {
  const { workspaceId } = await params;

  let grant;
  let workspace;

  try {
    grant = await requirePagePermission(workspaceId, "workspace.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      "workspace-layout",
    );

    workspace = await withTenant(ctx, (db) =>
      db.workspace.findFirst({
        where: { id: ctx.tenantId },
        select: { id: true, name: true, slug: true },
      }),
    );
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect("/workspaces");
    throw error;
  }

  if (workspace === null) redirect("/workspaces");

  const canAudit = grant.platformAdmin || grant.permissions.includes("audit.read");

  const navigation = [
    { href: `/workspaces/${workspaceId}`, label: "Overview" },
    { href: `/workspaces/${workspaceId}/members`, label: "Members" },
    { href: `/workspaces/${workspaceId}/office`, label: "Office settings" },
    ...(canAudit ? [{ href: `/workspaces/${workspaceId}/audit`, label: "Audit log" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link className="text-sm font-semibold tracking-tight" href="/workspaces">
              AffiliateOS
            </Link>
            <WorkspaceSwitcher currentWorkspaceId={workspaceId} />
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-400 sm:inline">
              {grant.session.user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8 md:flex-row">
        <aside className="md:w-52 md:shrink-0">
          <p className="truncate text-xs uppercase tracking-wide text-slate-500">{workspace.name}</p>
          <nav className="mt-3 flex flex-row gap-2 overflow-x-auto md:flex-col">
            {navigation.map((item) => (
              <Link
                key={item.href}
                className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                href={item.href}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
