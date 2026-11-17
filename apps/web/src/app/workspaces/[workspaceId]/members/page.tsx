import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@affiliateos/database";
import { ALL_ROLES, ROLE_LABELS } from "@affiliateos/permissions";

import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { tenantContextFor } from "@/lib/auth/route-support";
import { InviteMemberForm } from "@/components/invite-member-form";
import { listWorkspaceMembers } from "@/lib/workspaces/data";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ workspaceId: string }> };

function day(value: Date | null): string {
  return value === null ? "—" : value.toISOString().slice(0, 10);
}

export default async function MembersPage({ params }: PageProps) {
  const { workspaceId } = await params;

  let data;
  let grant;

  try {
    grant = await requirePagePermission(workspaceId, "member.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      "members-page",
    );

    data = await withTenant(ctx, async (db) => {
      const workspace = await db.workspace.findFirst({
        where: { id: ctx.tenantId },
        select: { id: true, name: true, slug: true },
      });
      if (workspace === null) return null;
      return { workspace, members: await listWorkspaceMembers(db) };
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">Members</h1>
          <p className="text-slate-300">Your session is missing or has expired. Sign in first.</p>
        </main>
      );
    }
    if (error instanceof PermissionError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">Members</h1>
          <p className="text-slate-300">You do not have access to this workspace.</p>
        </main>
      );
    }
    throw error;
  }

  if (data === null) notFound();

  const canInvite = grant.platformAdmin || grant.permissions.includes("member.invite");
  const roles = ALL_ROLES.map((key) => ({ key, label: ROLE_LABELS[key] }));

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header>
        <Link className="text-xs text-slate-400 hover:text-slate-200" href="/workspaces">
          ← All workspaces
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {data.workspace.name} · Members
        </h1>
        <p className="mt-1 font-mono text-xs text-slate-400">{data.workspace.slug}</p>
      </header>

      {canInvite ? <InviteMemberForm workspaceId={data.workspace.id} roles={roles} /> : null}

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => (
              <tr key={member.id} className="border-t border-slate-800">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-100">{member.displayName}</div>
                  <div className="text-xs text-slate-400">{member.email}</div>
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {member.roles.map((role) => role.name).join(", ") || "No role"}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs">
                    {member.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-400">{day(member.joinedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-slate-500">
        Role changes are available through PATCH
        <span className="font-mono"> /api/workspaces/{"{id}"}/members/{"{memberId}"}/role</span>.
        This page intentionally does not duplicate that mutation.
      </p>
    </main>
  );
}
