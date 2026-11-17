// TEST SUPPORT ONLY — fixtures for the RBAC suites, on `affiliateos_test`.
//
// The database client is imported dynamically so that `useTestDatabase()` runs
// before Prisma reads DATABASE_URL (the pool is opened at module-evaluation time).
//
// Every fixture creates its own workspace and user, so a test never depends on rows
// another test left behind. `prepareTestDatabase()` still truncates first, because
// `role_permissions` and `member_roles` are derived state that must match the
// code-owned matrix.

import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@affiliateos/permissions";
import type { NextRequest } from "next/server";

import { getSessionCookieName } from "./cookie-name.ts";
import { loadEnvForTests, requireTestDatabaseUrl } from "./test-env.ts";

/** Points the process at TEST_DATABASE_URL and returns it. Never the dev database. */
export function useTestDatabase(): string {
  loadEnvForTests();

  const url = requireTestDatabaseUrl();
  if (url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must not be the development database.");
  }

  process.env.DATABASE_URL = url;
  // The test schema is reached with the migrate credential (TD-7C-A8); emptying the
  // migration URL keeps `assertSeparateAccounts` intact instead of loosening it.
  delete process.env.MIGRATE_DATABASE_URL;

  return url;
}

async function database() {
  return import("@affiliateos/database");
}

/** Truncates every M1 table (children first) and reseeds the permission catalog. */
export async function prepareTestDatabase(): Promise<void> {
  const { systemDb, seedPermissionCatalog } = await database();
  const db = systemDb();

  await db.memberRole.deleteMany();
  await db.rolePermission.deleteMany();
  await db.workspaceInvitation.deleteMany();
  await db.workspaceMember.deleteMany();
  await db.session.deleteMany();
  await db.platformAdminGrant.deleteMany();
  await db.auditLog.deleteMany();
  await db.backgroundJobAttempt.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.role.deleteMany();
  await db.permission.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();

  await seedPermissionCatalog();
}

/** Truncates every M1 table, including the catalog. */
export async function clearTestDatabase(): Promise<void> {
  const { systemDb } = await database();
  const db = systemDb();

  await db.memberRole.deleteMany();
  await db.rolePermission.deleteMany();
  await db.workspaceInvitation.deleteMany();
  await db.workspaceMember.deleteMany();
  await db.session.deleteMany();
  await db.platformAdminGrant.deleteMany();
  await db.auditLog.deleteMany();
  await db.backgroundJobAttempt.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.role.deleteMany();
  await db.permission.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
}

/** A NextRequest-shaped object: `requirePermission` only reads the session cookie. */
export function fakeRequest(token?: string): NextRequest {
  return {
    cookies: {
      get: (name: string) =>
        name === getSessionCookieName() && token !== undefined ? { value: token } : undefined,
    },
    headers: new Headers(),
  } as unknown as NextRequest;
}

export type UserFixture = { userId: string; token: string };

/** A user with a live session and no workspace membership. */
export async function createUserWithSession(): Promise<UserFixture> {
  const { systemDb } = await database();
  const { createSession } = await import("./session.ts");

  const userId = randomUUID();
  await systemDb().user.create({
    data: {
      id: userId,
      email: `rbac-${userId}@test.local`,
      displayName: "RBAC Test",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, "127.0.0.1", "rbac-test");
  return { userId, token };
}

export type MemberFixture = {
  tenantId: string;
  workspaceSlug: string;
  userId: string;
  memberId: string;
  role: WorkspaceRole;
  token: string;
};

/** A workspace with its default roles, plus a member holding exactly one role. */
export async function createWorkspaceWithMember(
  role: WorkspaceRole,
  options: { status?: "ACTIVE" | "INVITED" } = {},
): Promise<MemberFixture> {
  const { systemDb, createDefaultRolesForWorkspace } = await database();
  const db = systemDb();

  const tenantId = randomUUID();
  const workspaceSlug = `rbac-${tenantId.slice(0, 8)}`;
  const { userId, token } = await createUserWithSession();

  await db.workspace.create({ data: { id: tenantId, slug: workspaceSlug, name: "RBAC Fixture" } });
  await createDefaultRolesForWorkspace(tenantId);

  const roleRow = await db.role.findUniqueOrThrow({
    where: { tenantId_key: { tenantId, key: role } },
    select: { id: true },
  });

  const member = await db.workspaceMember.create({
    data: {
      id: randomUUID(),
      tenantId,
      userId,
      status: options.status ?? "ACTIVE",
      joinedAt: new Date(),
    },
    select: { id: true },
  });

  await db.memberRole.create({
    data: { tenantId, memberId: member.id, roleId: roleRow.id },
  });

  return { tenantId, workspaceSlug, userId, memberId: member.id, role, token };
}

/** Gives a user an active platform-admin grant (the only cross-tenant path). */
export async function grantPlatformAdmin(userId: string): Promise<void> {
  const { systemDb } = await database();
  await systemDb().platformAdminGrant.create({
    data: { id: randomUUID(), userId, reason: "RBAC test fixture" },
  });
}
