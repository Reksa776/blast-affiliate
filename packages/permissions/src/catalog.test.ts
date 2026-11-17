// Unit tests for the permission catalog and role matrix (P0.6). Pure data: no
// database, no network, no Next runtime.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  permissionDescription,
  type Permission,
  isPermission,
} from "./catalog.js";
import {
  ALL_ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  roleHasPermission,
  type WorkspaceRole,
} from "./roles.js";

test("katalog berisi 27 permission unik (docs/08 §5.1)", () => {
  assert.equal(ALL_PERMISSIONS.length, 27);
  assert.equal(new Set(ALL_PERMISSIONS).size, 27);
  assert.equal(new Set(Object.keys(PERMISSIONS)).size, 27);
});

test("setiap permission berformat domain.action (lowercase, satu titik)", () => {
  for (const permission of ALL_PERMISSIONS) {
    assert.match(permission, /^[a-z]+\.[a-z]+$/, `format salah: ${permission}`);
    assert.equal(permission.split(".").length, 2);
  }
});

test("deskripsi muat di VARCHAR(255) dan tidak kosong", () => {
  for (const permission of ALL_PERMISSIONS) {
    const description = permissionDescription(permission);
    assert.ok(description.length > 0);
    assert.ok(description.length <= 255);
  }
});

test("isPermission hanya menerima katalog, bukan prefix atau beda huruf besar", () => {
  assert.equal(isPermission("creator.read"), true);
  assert.equal(isPermission("creator.rea"), false);
  assert.equal(isPermission("Creator.Read"), false);
  assert.equal(isPermission(""), false);
  assert.equal(isPermission(undefined), false);
});

test("6 role sesuai enum RoleKey, tanpa SUPER_ADMIN", () => {
  assert.deepEqual([...ALL_ROLES].sort(), [
    "AFFILIATE_MANAGER",
    "ANALYST",
    "BUSINESS_DEVELOPMENT",
    "VIEWER",
    "WORKSPACE_ADMIN",
    "WORKSPACE_OWNER",
  ]);
  assert.equal(ALL_ROLES.length, 6);
  assert.equal(ALL_ROLES.includes("SUPER_ADMIN" as WorkspaceRole), false);

  for (const role of ALL_ROLES) {
    assert.equal(ROLES[role], role);
    assert.ok(ROLE_LABELS[role].length > 0);
  }
});

test("setiap role punya ≥1 permission, semuanya dari katalog, tanpa duplikat", () => {
  for (const role of ALL_ROLES) {
    const permissions = ROLE_PERMISSIONS[role];
    assert.ok(permissions.length >= 1, `${role} kosong`);
    assert.equal(new Set(permissions).size, permissions.length, `${role} punya duplikat`);

    for (const permission of permissions) {
      assert.ok(
        (ALL_PERMISSIONS as readonly string[]).includes(permission),
        `${role} memakai permission tak dikenal: ${permission}`,
      );
    }
  }
});

test("WORKSPACE_OWNER memegang seluruh katalog", () => {
  assert.equal(ROLE_PERMISSIONS.WORKSPACE_OWNER.length, ALL_PERMISSIONS.length);
  for (const permission of ALL_PERMISSIONS) {
    assert.equal(roleHasPermission("WORKSPACE_OWNER", permission), true);
  }
});

test("WORKSPACE_ADMIN memegang semua kecuali workspace.manage", () => {
  const missing = ALL_PERMISSIONS.filter(
    (permission) => !ROLE_PERMISSIONS.WORKSPACE_ADMIN.includes(permission),
  );
  assert.deepEqual(missing, [PERMISSIONS.WORKSPACE_MANAGE]);
});

test("matriks docs/08 §5.2 untuk VIEWER, ANALYST, dan BUSINESS_DEVELOPMENT", () => {
  const expectRole = (role: WorkspaceRole, expected: Permission[]) => {
    assert.deepEqual(
      [...ROLE_PERMISSIONS[role]].sort(),
      [...expected].sort(),
      `matriks ${role} tidak sesuai dokumen`,
    );
  };

  expectRole("VIEWER", [
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.MEMBER_READ,
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CAMPAIGN_READ,
    PERMISSIONS.SHOP_READ,
    PERMISSIONS.ANALYTICS_READ,
  ]);

  expectRole("ANALYST", [
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.MEMBER_READ,
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CREATOR_EXPORT,
    PERMISSIONS.CAMPAIGN_READ,
    PERMISSIONS.SHOP_READ,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.ANALYTICS_EXPORT,
    PERMISSIONS.AUDIT_READ,
  ]);

  expectRole("BUSINESS_DEVELOPMENT", [
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.MEMBER_READ,
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CREATOR_WRITE,
    PERMISSIONS.CREATOR_ASSIGN,
    PERMISSIONS.CAMPAIGN_READ,
    PERMISSIONS.SHOP_READ,
    PERMISSIONS.ANALYTICS_READ,
  ]);
});

test("role.viewer minimal: tidak bisa menulis apa pun", () => {
  for (const writeish of [
    PERMISSIONS.WORKSPACE_MANAGE,
    PERMISSIONS.MEMBER_INVITE,
    PERMISSIONS.ROLE_MANAGE,
    PERMISSIONS.CREATOR_WRITE,
    PERMISSIONS.CREATOR_DELETE,
    PERMISSIONS.CAMPAIGN_WRITE,
    PERMISSIONS.SHOP_CONNECT,
    PERMISSIONS.ANALYTICS_EXPORT,
    PERMISSIONS.OUTREACH_SEND,
  ] as Permission[]) {
    assert.equal(roleHasPermission("VIEWER", writeish), false, `VIEWER tidak boleh punya ${writeish}`);
  }
});
