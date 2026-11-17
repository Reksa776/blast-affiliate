import Link from "next/link";

import { AuthError } from "@/lib/auth/middleware";
import { requirePageAuth } from "@/lib/auth/page-auth";
import { listWorkspacesForUser } from "@/lib/workspaces/data";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  let workspaces;

  try {
    const session = await requirePageAuth();
    workspaces = await listWorkspacesForUser(session);
  } catch (error) {
    if (error instanceof AuthError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
          <h1 className="text-2xl font-semibold">Workspaces</h1>
          <p className="text-slate-300">Your session is missing or has expired. Sign in first.</p>
          <Link
            className="w-fit rounded-md border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
            href="/sign-in"
          >
            Go to sign in →
          </Link>
        </main>
      );
    }
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Phase 2</p>
          <h1 className="text-3xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 text-sm text-slate-400">
            Only workspaces where you hold an active membership are listed.
          </p>
        </div>
      </header>

      {workspaces.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300">
          You are not an active member of any workspace yet. Ask an owner for an invitation.
        </p>
      ) : (
        <ul className="grid gap-3">
          {workspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{workspace.name}</h2>
                  <p className="font-mono text-xs text-slate-400">{workspace.slug}</p>
                </div>
                <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                  {workspace.status}
                </span>
              </div>

              <p className="mt-3 text-sm text-slate-300">
                Role:{" "}
                <span className="font-medium text-slate-100">
                  {workspace.roles.map((role) => role.name).join(", ") || "No role assigned"}
                </span>
              </p>

              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                <Link
                  className="rounded-md border border-slate-700 px-3 py-1.5 hover:border-slate-500"
                  href={`/workspaces/${workspace.id}/members`}
                >
                  Members
                </Link>
                <Link
                  className="rounded-md border border-slate-700 px-3 py-1.5 hover:border-slate-500"
                  href={`/workspaces/${workspace.id}/office`}
                >
                  Office settings
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
