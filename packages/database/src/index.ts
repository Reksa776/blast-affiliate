// Public surface of @affiliateos/database.
//
// The raw PrismaClient is NOT exported (Checkpoint 6D, closes the app-facing half
// of F-6C-6). What leaves this package is deliberate:
//
//   withTenant(ctx, fn)   → a client confined to one tenant (Checkpoint 7B, Task C)
//   systemDb()            → the raw client, for cross-tenant work only
//   createTenantContext() → mints the branded context `withTenant` accepts
//   checkDatabaseHealth() → a fixed `SELECT 1` liveness probe
//   disconnectPrisma()    → shutdown helper for scripts and tests
//
// An application module still cannot obtain an unscoped query client by accident:
// `withTenant` is the only request-path surface, and `systemDb` is marked
// SYSTEM USE ONLY at every call site. The security contract is in
// docs/08-TENANT-ISOLATION-DESIGN.md.

export { disconnectPrisma } from "./client.js";
export { checkDatabaseHealth } from "./health.js";
export {
  assertJobTenantContext,
  assertSameTenant,
  createTenantContext,
  CrossTenantAccessError,
  hasPermission,
  TenantContextError,
  tenantScope,
  type TenantContext,
  type TenantContextInput,
} from "./tenancy.js";
export {
  APPEND_ONLY_MODELS,
  systemDb,
  tenantExtension,
  TenantAppendOnlyError,
  TenantModelAccessError,
  TenantWriteScopeError,
  withTenant,
  type TenantScopedPrisma,
} from "./tenant-db.js";
