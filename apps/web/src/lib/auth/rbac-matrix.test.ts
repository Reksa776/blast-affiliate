// RBAC matrix: every role × every permission (P0.6), against `affiliateos_test`.
//
// 6 roles × 27 permissions = 162 combinations. Each one is a named subtest, so a
// failure reports the exact pair instead of "some role is wrong". The expected
// value comes from the code-owned matrix (`roleHasPermission`), and the actual value
// comes from `requirePermission` reading `role_permissions` out of the database —
// which proves the seed produced what the matrix declares.
//
// Sessions are created once per role (6) rather than per combination, keeping the
// run under a few seconds while still going through the real auth path.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { WorkspaceRole } from "@affiliateos/permissions";

import { acquireTestDbLock } from "./test-lock.ts";
import {
  clearTestDatabase,
  createWorkspaceWithMember,
  fakeRequest,
  prepareTestDatabase,
  useTestDatabase,
  type MemberFixture,
} from "./test-fixtures.ts";

useTestDatabase();

const { PermissionError, requirePermission } = await import("./permission.ts");
const { ALL_PERMISSIONS, ALL_ROLES, roleHasPermission } = await import("@affiliateos/permissions");

const fixtures = new Map<WorkspaceRole, MemberFixture>();
let releaseLock: () => void = () => undefined;

before(async () => {
  releaseLock = await acquireTestDbLock();
  await prepareTestDatabase();

  for (const role of ALL_ROLES) {
    fixtures.set(role, await createWorkspaceWithMember(role));
  }

  assert.equal(fixtures.size, 6);
});

after(async () => {
  await clearTestDatabase();

  const { disconnectPrisma } = await import("@affiliateos/database");
  await disconnectPrisma();

  releaseLock();
});

describe("RBAC matrix (6 roles × 27 permissions)", () => {
  for (const role of ALL_ROLES) {
    it(`matriks ${role}`, async (t: TestContext) => {
      const fixture = fixtures.get(role);
      assert.ok(fixture, `fixture untuk ${role} tidak dibuat`);

      for (const permission of ALL_PERMISSIONS) {
        await t.test(`${role} × ${permission}`, async () => {
          const expected = roleHasPermission(role, permission);
          const attempt = requirePermission(fakeRequest(fixture.token), fixture.tenantId, permission);

          if (expected) {
            const grant = await attempt;
            assert.ok(grant.permissions.includes(permission));
            assert.equal(grant.platformAdmin, false);
          } else {
            await assert.rejects(attempt, PermissionError);
          }
        });
      }
    });
  }
});
