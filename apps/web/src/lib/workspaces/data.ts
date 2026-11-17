// AffiliateOS — shared workspace reads for API routes and admin pages (Phase 2).
//
// Both entry points use the exact same functions and therefore the same isolation
// rules: tenant data is read through `withTenant(ctx, …)`, never through `systemDb`.
// The only SYSTEM call is the membership discovery below, which is what establishes
// the list of tenants a user may enter.
//
// Tenant key reminder (TD-7F-R3): `workspaces` is scoped on `id`, so the context
// value replaces a caller-supplied id. Callers must authorize the id first
// (`requirePermission`) and must not treat a returned workspace as proof that the
// requested id existed.

import {
  createTenantContext,
  systemDb,
  withTenant,
  type TenantContext,
  type TenantScopedPrisma,
} from "@affiliateos/database";

import type { ValidatedSession } from "@/lib/auth/session.ts";

export type RoleSummary = { key: string; name: string };

export type WorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  membershipId: string;
  joinedAt: Date | null;
  roles: RoleSummary[];
};

export type MemberSummary = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  status: string;
  jobTitle: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  roles: RoleSummary[];
};

export type OfficeSettings = {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  timezone: string;
  workStart: string;
  workEnd: string;
  status: string;
  plan: string;
};

function sortRoles(roles: RoleSummary[]): RoleSummary[] {
  return roles.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Workspaces where `session.userId` holds an ACTIVE membership.
 *
 * One tenant context per membership is unavoidable with `withTenant`: a context is
 * a single-tenant client by construction. The list is fetched in membership order
 * and sorted by name for a stable UI. The N+1 shape is recorded as TD-8-R1.
 */
export async function listWorkspacesForUser(session: ValidatedSession): Promise<WorkspaceSummary[]> {
  // SYSTEM: discovering which tenants a user may enter is pre-tenant by definition.
  const memberships = await systemDb().workspaceMember.findMany({
    where: { userId: session.userId, status: "ACTIVE" },
    select: { id: true, tenantId: true },
    orderBy: { createdAt: "asc" },
  });

  const summaries: WorkspaceSummary[] = [];

  for (const membership of memberships) {
    const ctx = createTenantContext({
      tenantId: membership.tenantId,
      userId: session.userId,
      membershipId: membership.id,
      actorType: "user",
      requestId: "workspace-list",
      permissions: [],
    });

    const row = await withTenant(ctx, (db) =>
      db.workspaceMember.findFirst({
        where: { id: membership.id },
        select: {
          id: true,
          status: true,
          joinedAt: true,
          workspace: { select: { id: true, slug: true, name: true, status: true, plan: true } },
          roleAssignments: { select: { role: { select: { key: true, name: true } } } },
        },
      }),
    );

    if (row === null) continue;

    summaries.push({
      id: row.workspace.id,
      slug: row.workspace.slug,
      name: row.workspace.name,
      status: row.workspace.status,
      plan: row.workspace.plan,
      membershipId: row.id,
      joinedAt: row.joinedAt,
      roles: sortRoles(row.roleAssignments.map((assignment) => assignment.role)),
    });
  }

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

/** Members of the tenant carried by `ctx`; the caller must have authorized it. */
export async function listWorkspaceMembers(db: TenantScopedPrisma): Promise<MemberSummary[]> {
  const rows = await db.workspaceMember.findMany({
    select: {
      id: true,
      userId: true,
      status: true,
      jobTitle: true,
      joinedAt: true,
      createdAt: true,
      user: { select: { email: true, displayName: true } },
      roleAssignments: { select: { role: { select: { key: true, name: true } } } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    displayName: row.user.displayName,
    status: row.status,
    jobTitle: row.jobTitle,
    joinedAt: row.joinedAt,
    createdAt: row.createdAt,
    roles: sortRoles(row.roleAssignments.map((assignment) => assignment.role)),
  }));
}

/** Office settings for the tenant carried by `ctx`, or null when it does not exist. */
export async function readOfficeSettings(
  db: TenantScopedPrisma,
  workspaceId: string,
): Promise<OfficeSettings | null> {
  return db.workspace.findFirst({
    where: { id: workspaceId },
    select: {
      id: true,
      slug: true,
      name: true,
      address: true,
      timezone: true,
      workStart: true,
      workEnd: true,
      status: true,
      plan: true,
    },
  });
}

/** The standard context for an already-authorized grant (API and pages). */
export function tenantContextForWorkspace(
  tenantId: string,
  userId: string,
  membershipId: string,
  requestId: string,
  permissions: readonly string[] = [],
): TenantContext {
  return createTenantContext({
    tenantId,
    userId,
    membershipId,
    actorType: "user",
    requestId,
    permissions,
  });
}
