import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@affiliateos/database";

import { OfficeSettingsForm } from "@/components/office-settings-form";
import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { tenantContextFor } from "@/lib/auth/route-support";
import { readOfficeSettings } from "@/lib/workspaces/data";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ workspaceId: string }> };

export default async function OfficeSettingsPage({ params }: PageProps) {
  const { workspaceId } = await params;

  let office;
  let canManage = false;

  try {
    const grant = await requirePagePermission(workspaceId, "workspace.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      "office-settings-page",
    );

    office = await withTenant(ctx, (db) => readOfficeSettings(db, ctx.tenantId));
    canManage = grant.platformAdmin || grant.permissions.includes("workspace.manage");
  } catch (error) {
    if (error instanceof AuthError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">Office settings</h1>
          <p className="text-slate-300">Your session is missing or has expired. Sign in first.</p>
        </main>
      );
    }
    if (error instanceof PermissionError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">Office settings</h1>
          <p className="text-slate-300">You do not have access to this workspace.</p>
        </main>
      );
    }
    throw error;
  }

  if (office === null) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <header>
        <Link className="text-xs text-slate-400 hover:text-slate-200" href="/workspaces">
          ← All workspaces
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {office.name} · Office settings
        </h1>
        <p className="mt-1 font-mono text-xs text-slate-400">{office.slug}</p>
      </header>

      {canManage ? (
        <OfficeSettingsForm
          workspaceId={office.id}
          initial={{
            name: office.name,
            address: office.address ?? "",
            timezone: office.timezone,
            workStart: office.workStart,
            workEnd: office.workEnd,
          }}
        />
      ) : (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-lg font-semibold">Office details</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">Name</dt>
              <dd className="text-slate-100">{office.name}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Address</dt>
              <dd className="text-slate-100">{office.address ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Timezone</dt>
              <dd className="font-mono text-slate-100">{office.timezone}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Work hours</dt>
              <dd className="font-mono text-slate-100">
                {office.workStart}–{office.workEnd}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-slate-500">
            Only a workspace owner holds <span className="font-mono">workspace.manage</span>, so
            this view is read-only for your role.
          </p>
        </section>
      )}
    </main>
  );
}
