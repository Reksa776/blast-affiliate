// Seeds the global permission catalog into the configured database.
//
//   node dist/src/scripts/seed-rbac.js          (development)
//   DATABASE_URL=<test url> node …              (test)
//
// Roles are NOT seeded here: they are per workspace and created by
// `createDefaultRolesForWorkspace(tenantId)` when a workspace is provisioned. With
// no workspace in the database, `roles` stays 0 — that is the expected state after
// this script, not a failure.
//
// The environment is loaded before `../client.js` is imported: the client opens its
// pool at module-evaluation time.

import { loadRepoEnv } from "../env.js";

const envPath = loadRepoEnv();

const { disconnectPrisma } = await import("../client.js");
const { seedPermissionCatalog } = await import("../rbac.js");

try {
  const permissions = await seedPermissionCatalog();

  // SYSTEM: report only; the script has no tenant context.
  const { prisma } = await import("../client.js");
  const roles = await prisma.role.count();
  const rolePermissions = await prisma.rolePermission.count();

  console.log(`env_loaded_from=${envPath.replace(process.env.HOME ?? "", "~")}`);
  console.log(`permissions=${permissions}`);
  console.log(`roles=${roles}`);
  console.log(`role_permissions=${rolePermissions}`);
  console.log("result=OK");
} catch (error) {
  console.error(`result=FAIL reason_class=${error instanceof Error ? error.name : "unknown"}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await disconnectPrisma().catch(() => undefined);
}
