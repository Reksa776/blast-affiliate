import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { systemDb, withTenant } from "@affiliateos/database";

import { AuthError } from "@/lib/auth/middleware";
import { requirePagePermission } from "@/lib/auth/page-auth";
import { PermissionError } from "@/lib/auth/permission";
import { tenantContextFor } from "@/lib/auth/route-support";
import {
  listAuditLogs,
  type AuditLogPage,
  type AuditLogSummary,
} from "@/lib/workspaces/data";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type PageProps = {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function single(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Accepts `YYYY-MM-DD`; an invalid string is ignored rather than throwing. */
function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function ipHex(value: Uint8Array | null): string {
  if (value === null) return "—";
  return `${Buffer.from(value).toString("hex").slice(0, 12)}…`;
}

function metadataText(value: unknown): string {
  if (value === null || value === undefined) return "—";

  try {
    const text = JSON.stringify(value);
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  } catch {
    return "—";
  }
}

function actorLabel(row: AuditLogSummary, emails: Map<string, string>): string {
  if (row.actorUserId === null) return row.actorType;

  const email = emails.get(row.actorUserId);
  return email ?? `${row.actorType}:${row.actorUserId.slice(0, 8)}`;
}

/**
 * Audit viewer (P1 MEDIUM #6, item 3e).
 *
 * Reads through `withTenant`, so the tenant comes from the caller's membership and
 * the query extension adds `tenant_id` to every predicate. The actor filter is
 * resolved against `users` first because that table is platform-global; the result
 * is then applied inside the tenant-scoped query.
 */
export default async function AuditPage({ params, searchParams }: PageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;

  const action = single(query.action);
  const actor = single(query.actor);
  const from = parseDate(single(query.from));
  const to = parseDate(single(query.to), true);
  const page = Math.max(1, Number.parseInt(single(query.page) ?? "1", 10) || 1);

  let logs: AuditLogPage = { rows: [], total: 0, page, pageSize: PAGE_SIZE };
  let workspaceName = "";
  const actorEmails = new Map<string, string>();

  try {
    const grant = await requirePagePermission(workspaceId, "audit.read");
    const ctx = tenantContextFor(
      grant,
      grant.member?.tenantId ?? workspaceId,
      "audit-page",
    );

    const workspace = await withTenant(ctx, (db) =>
      db.workspace.findFirst({
        where: { id: ctx.tenantId },
        select: { name: true },
      }),
    );
    if (workspace === null) notFound();
    workspaceName = workspace.name;

    let actorUserIds: string[] | undefined;
    if (actor !== undefined) {
      // SYSTEM: `users` is platform-global (no tenant_id); this only resolves the
      // filter to ids. The rows themselves are read through `withTenant` below.
      const matches = await systemDb().user.findMany({
        where: {
          OR: [
            { email: { contains: actor } },
            ...(actor.length === 36 ? [{ id: actor }] : []),
          ],
        },
        select: { id: true },
      });
      actorUserIds = matches.map((match) => match.id);
    }

    if (actorUserIds === undefined || actorUserIds.length > 0) {
      logs = await withTenant(ctx, (db) =>
        listAuditLogs(db, {
          action,
          actorUserIds,
          from,
          to,
          page,
          pageSize: PAGE_SIZE,
        }),
      );
    }

    const actorIds = [
      ...new Set(
        logs.rows
          .map((row) => row.actorUserId)
          .filter((id): id is string => id !== null),
      ),
    ];

    if (actorIds.length > 0) {
      // SYSTEM: display-only lookup of actor emails for the platform-global `users`.
      const actors = await systemDb().user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true },
      });
      for (const row of actors) actorEmails.set(row.id, row.email);
    }
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    if (error instanceof PermissionError) redirect("/workspaces");
    throw error;
  }

  const totalPages = Math.max(1, Math.ceil(logs.total / PAGE_SIZE));

  function pageHref(target: number): string {
    const params = new URLSearchParams();
    if (action !== undefined) params.set("action", action);
    if (actor !== undefined) params.set("actor", actor);
    if (query.from !== undefined && typeof query.from === "string") params.set("from", query.from);
    if (query.to !== undefined && typeof query.to === "string") params.set("to", query.to);
    params.set("page", String(target));
    return `?${params.toString()}`;
  }

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{workspaceName} · Audit log</h1>
        <p className="mt-1 text-sm text-slate-400">
          Append-only. {logs.total} event{logs.total === 1 ? "" : "s"} match the current filter.
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4" method="get">
        <label className="text-xs text-slate-400">
          Action contains
          <input
            className="mt-1 block w-44 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            name="action"
            defaultValue={action ?? ""}
            placeholder="workspace.update"
          />
        </label>

        <label className="text-xs text-slate-400">
          Actor (email or id)
          <input
            className="mt-1 block w-52 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            name="actor"
            defaultValue={actor ?? ""}
            placeholder="owner@example.com"
          />
        </label>

        <label className="text-xs text-slate-400">
          From
          <input
            className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            type="date"
            name="from"
            defaultValue={typeof query.from === "string" ? query.from : ""}
          />
        </label>

        <label className="text-xs text-slate-400">
          To
          <input
            className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            type="date"
            name="to"
            defaultValue={typeof query.to === "string" ? query.to : ""}
          />
        </label>

        <button className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-950" type="submit">
          Filter
        </button>
        <Link className="text-xs text-slate-400 hover:text-slate-200" href={`/workspaces/${workspaceId}/audit`}>
          Reset
        </Link>
      </form>

      <section className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Time (UTC)</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Resource</th>
              <th className="px-4 py-3 font-medium">IP hash</th>
              <th className="px-4 py-3 font-medium">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {logs.rows.length === 0 ? (
              <tr className="border-t border-slate-800">
                <td className="px-4 py-6 text-slate-400" colSpan={6}>
                  No audit events match this filter.
                </td>
              </tr>
            ) : (
              logs.rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-800 align-top">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-300">
                    {row.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-4 py-3 text-slate-200">{actorLabel(row, actorEmails)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-200">{row.action}</td>
                  <td className="px-4 py-3 text-xs text-slate-300">
                    {row.resourceType}
                    {row.resourceId === null ? "" : `:${row.resourceId.slice(0, 8)}`}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{ipHex(row.ipHash)}</td>
                  <td className="max-w-xs break-all px-4 py-3 font-mono text-xs text-slate-400">
                    {metadataText(row.metadata)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <nav className="flex items-center justify-between text-sm text-slate-400">
        {page > 1 ? (
          <Link className="rounded-md border border-slate-700 px-3 py-1.5 hover:border-slate-500" href={pageHref(page - 1)}>
            ← Previous
          </Link>
        ) : (
          <span />
        )}
        <span>
          Page {logs.page} / {totalPages}
        </span>
        {page < totalPages ? (
          <Link className="rounded-md border border-slate-700 px-3 py-1.5 hover:border-slate-500" href={pageHref(page + 1)}>
            Next →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}
