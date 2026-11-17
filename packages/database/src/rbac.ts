// AffiliateOS — RBAC provisioning (P0.6).
//
// Two operations, both idempotent:
//   seedPermissionCatalog()            → the 27-row global catalog
//   createDefaultRolesForWorkspace(id) → 6 system roles + their role_permissions
//
// Permission ids are derived deterministically from the key (SHA-256 → UUID shape),
// because the schema gives `permissions.id` no database default and the catalog is
// code-owned. Re-running the seed therefore cannot create duplicate rows even if the
// unique-key upsert is bypassed by a future rewrite.
//
// System queries are marked SYSTEM: this is platform provisioning, not a tenant
// request path.

import crypto from "node:crypto";

import {
  ALL_PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  permissionDescription,
} from "@affiliateos/permissions";

import { prisma } from "./client.js";

/** Deterministic permission id: SHA-256 over a namespaced key, formatted as a UUID. */
export function permissionIdFor(key: string): string {
  const hex = crypto.createHash("sha256").update(`affiliateos:permission:${key}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Seeds (or refreshes descriptions of) the global permission catalog. */
export async function seedPermissionCatalog(): Promise<number> {
  for (const key of ALL_PERMISSIONS) {
    const description = permissionDescription(key);

    // SYSTEM: the catalog is platform-global and has no tenant column.
    await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { id: permissionIdFor(key), key, description },
    });
  }

  // SYSTEM: count for the caller's report; no tenant scope exists here.
  return prisma.permission.count();
}

/**
 * Creates the six system roles for one workspace and grants the default matrix.
 *
 * Throws when the catalog is not seeded rather than silently creating a role with
 * fewer permissions — a missing grant must be loud.
 */
export async function createDefaultRolesForWorkspace(
  tenantId: string,
): Promise<{ roles: number; grants: number }> {
  // SYSTEM: provisioning a new workspace, before any member exists.
  const catalog = await prisma.permission.findMany({ select: { id: true, key: true } });
  const idByKey = new Map(catalog.map((row) => [row.key, row.id]));

  let grants = 0;

  for (const role of Object.values(ROLES)) {
    const matrix = ROLE_PERMISSIONS[role];
    const permissionIds = matrix.map((permission) => idByKey.get(permission));

    if (permissionIds.some((id) => id === undefined)) {
      throw new Error(
        "Permission catalog is incomplete: call seedPermissionCatalog() before provisioning roles.",
      );
    }

    // SYSTEM: workspace provisioning, no request context.
    const record = await prisma.role.upsert({
      where: { tenantId_key: { tenantId, key: role } },
      update: {},
      create: {
        id: crypto.randomUUID(),
        tenantId,
        key: role,
        name: ROLE_LABELS[role],
        isSystem: true,
      },
      select: { id: true },
    });

    // SYSTEM: same provisioning step, tenantId is the workspace being created.
    const result = await prisma.rolePermission.createMany({
      data: (permissionIds as string[]).map((permissionId) => ({
        tenantId,
        roleId: record.id,
        permissionId,
      })),
      skipDuplicates: true,
    });

    grants += result.count;
  }

  return { roles: Object.keys(ROLES).length, grants };
}
