// Public surface of @affiliateos/database.
//
// Checkpoint 6D: the raw PrismaClient is NO LONGER exported (closes the app-facing
// half of F-6C-6). What leaves this package is deliberate:
//
//   - checkDatabaseHealth(): a fixed `SELECT 1` liveness probe.
//   - disconnectPrisma(): shutdown helper for scripts and tests.
//
// Still missing, and intentionally so: `withTenant(ctx)` and `systemDb()`. They
// require `workspace_members` / `role_permissions` to exist, which needs migration
// M1. Their security contract is written in docs/08-TENANT-ISOLATION-DESIGN.md;
// they will replace this surface once they can be tested against real tables.
//
// Consequence today: an application module cannot reach an unscoped query client.
// It also cannot query at all yet — which is correct, because no business table
// exists and the authentication layer that mints a TenantContext is not built.

export { disconnectPrisma } from "./client.js";
export { checkDatabaseHealth } from "./health.js";
