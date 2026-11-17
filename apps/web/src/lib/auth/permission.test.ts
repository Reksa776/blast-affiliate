// Integration tests for requirePermission (P0.6, T1–T6) against `affiliateos_test`.
//
// Deviations from the brief, both forced by the schema/docs:
//   - there is no `super_admin` workspace role (docs/08 §5.3), so T5 exercises the
//     real platform path: a `platform_admin_grants` row grants the whole catalog;
//   - there is no `creator.create` permission; the matrix uses `creator.write`, so
//     T2/T3 use that key.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { acquireTestDbLock } from "./test-lock.ts";
import {
  clearTestDatabase,
  createUserWithSession,
  createWorkspaceWithMember,
  fakeRequest,
  grantPlatformAdmin,
  prepareTestDatabase,
  useTestDatabase,
} from "./test-fixtures.ts";

useTestDatabase();

const { PermissionError, requirePermission } = await import("./permission.ts");
const { ALL_PERMISSIONS } = await import("@affiliateos/permissions");

let releaseLock: () => void = () => undefined;

before(async () => {
  releaseLock = await acquireTestDbLock();
  await prepareTestDatabase();
});

after(async () => {
  await clearTestDatabase();

  const { disconnectPrisma, systemDb } = await import("@affiliateos/database");
  assert.equal(await systemDb().user.count(), 0);
  assert.equal(await systemDb().permission.count(), 0);
  await disconnectPrisma();

  releaseLock();
});

describe("requirePermission", () => {
  it("T1: WORKSPACE_OWNER di workspace A bisa creator.read", async () => {
    const owner = await createWorkspaceWithMember("WORKSPACE_OWNER");

    const grant = await requirePermission(fakeRequest(owner.token), owner.tenantId, "creator.read");

    assert.equal(grant.platformAdmin, false);
    assert.equal(grant.member?.id, owner.memberId);
    assert.equal(grant.permissions.length, ALL_PERMISSIONS.length);
    assert.ok(grant.permissions.includes("creator.read"));
  });

  it("T2: BUSINESS_DEVELOPMENT di A bisa creator.write", async () => {
    const bd = await createWorkspaceWithMember("BUSINESS_DEVELOPMENT");

    const grant = await requirePermission(fakeRequest(bd.token), bd.tenantId, "creator.write");

    assert.ok(grant.permissions.includes("creator.write"));
    assert.equal(grant.permissions.includes("creator.delete"), false);
  });

  it("T3: ANALYST di A ditolak untuk creator.write (403)", async () => {
    const analyst = await createWorkspaceWithMember("ANALYST");

    await assert.rejects(
      requirePermission(fakeRequest(analyst.token), analyst.tenantId, "creator.write"),
      (error: unknown) => {
        assert.ok(error instanceof PermissionError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Missing permission: creator\.write/);
        return true;
      },
    );
  });

  it("T4: user yang bukan member workspace A ditolak", async () => {
    const outsider = await createUserWithSession();
    const workspace = await createWorkspaceWithMember("WORKSPACE_OWNER");

    await assert.rejects(
      requirePermission(fakeRequest(outsider.token), workspace.tenantId, "creator.read"),
      (error: unknown) => {
        assert.ok(error instanceof PermissionError);
        assert.match(error.message, /Not a member/);
        return true;
      },
    );
  });

  it("T5: platform admin grant memberi seluruh 27 permission tanpa membership", async () => {
    const admin = await createUserWithSession();
    await grantPlatformAdmin(admin.userId);
    const workspace = await createWorkspaceWithMember("VIEWER");

    for (const permission of ALL_PERMISSIONS) {
      const grant = await requirePermission(fakeRequest(admin.token), workspace.tenantId, permission);
      assert.equal(grant.platformAdmin, true);
      assert.equal(grant.permissions.length, ALL_PERMISSIONS.length);
    }
  });

  it("T6: permission yang tidak ada di katalog ditolak", async () => {
    const owner = await createWorkspaceWithMember("WORKSPACE_OWNER");

    await assert.rejects(
      requirePermission(
        fakeRequest(owner.token),
        owner.tenantId,
        "creator.nope" as unknown as (typeof ALL_PERMISSIONS)[number],
      ),
      (error: unknown) => {
        assert.ok(error instanceof PermissionError);
        assert.match(error.message, /Unknown permission/);
        return true;
      },
    );
  });

  it("member dengan status INVITED tidak dianggap punya akses", async () => {
    const invited = await createWorkspaceWithMember("WORKSPACE_OWNER", { status: "INVITED" });

    await assert.rejects(requirePermission(fakeRequest(invited.token), invited.tenantId, "creator.read"));
  });

  it("tanpa cookie session → 401 (AuthError), bukan 403", async () => {
    const { AuthError } = await import("./middleware.ts");
    const workspace = await createWorkspaceWithMember("WORKSPACE_OWNER");

    await assert.rejects(
      requirePermission(fakeRequest(), workspace.tenantId, "creator.read"),
      AuthError,
    );
  });
});
