// AffiliateOS — tenant-scoped Prisma access (Checkpoint 7B, Task C).
//
// Two ways to touch the database, and only two:
//
//   withTenant(ctx, fn)  → a client whose every query is confined to one tenant
//   systemDb()           → the raw client, for work that is genuinely cross-tenant
//
// The filter is applied by a Prisma query extension (`$allOperations`), not by a
// repository convention, so a forgotten `where` cannot silently read another
// workspace. Every model is classified explicitly: a model that is neither
// tenant-scoped nor explicitly platform-level is REJECTED rather than allowed
// through unscoped (fail-closed, same direction as the table-level grants).
//
// What this cannot do (documented in docs/PHASE-1-CHECKPOINT-7B-TASKC.md):
//   - nested writes are not intercepted; composite FKs such as
//     role_permissions(tenant_id, role_id) → roles(tenant_id, id) reject them at
//     the database level instead;
//   - `$queryRaw`/`$executeRaw` are removed from the scoped type but exist at
//     runtime, so a cast can still reach them. Raw SQL belongs to systemDb().

import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./client.js";
import { TenantContextError, type TenantContext } from "./tenancy.js";

/** The client handed to `withTenant(ctx, fn)`. */
export type TenantScopedPrisma = Omit<
  PrismaClient,
  | "user"
  | "session"
  | "permission"
  | "platformAdminGrant"
  | "$queryRaw"
  | "$queryRawUnsafe"
  | "$executeRaw"
  | "$executeRawUnsafe"
  | "$runCommandRaw"
>;

/** A model that must not be reached through a tenant context at all. */
export class TenantModelAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantModelAccessError";
  }
}

/** A write to a model that is append-only and must never be mutated. */
export class TenantAppendOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAppendOnlyError";
  }
}

/** A write whose tenant column is missing or names a different tenant. */
export class TenantWriteScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantWriteScopeError";
  }
}

/**
 * Which column carries the tenant.
 *
 * `workspaces` IS the tenant, so its key is `id`; every other scoped model uses
 * `tenant_id`.
 *
 * TD-7F-R3 — the Workspace special case, stated explicitly because it surprises
 * reviewers: the context is always spread LAST into `where` (see
 * `scopeQueryArgs`). For a model whose scope field is `tenantId`, passing a foreign
 * id together with a foreign tenant yields no row, because both filters must match.
 * For `Workspace` the scope field and the row key are the same column, so a foreign
 * `where.id` is REPLACED by `ctx.tenantId`, not intersected with it. The result is
 * still fail-closed: a foreign workspace row is never returned. What a caller sees
 * instead is the context's own workspace (or `null` when that workspace is gone) —
 * never the row they asked for. This is deliberate; do not "fix" it by spreading the
 * scope first, which would let a caller select another tenant by id.
 */
type TenantScopeField = "tenantId" | "id";

/**
 * Every model in migration M1, classified. Adding a model without adding it here
 * is a startup-time-visible failure at the first query, never a silent bypass.
 */
const TENANT_SCOPE_FIELD: Readonly<Record<string, TenantScopeField>> = {
  Workspace: "id",
  WorkspaceMember: "tenantId",
  WorkspaceInvitation: "tenantId",
  Role: "tenantId",
  RolePermission: "tenantId",
  MemberRole: "tenantId",
  AuditLog: "tenantId",
  BackgroundJob: "tenantId",
  // `background_job_attempts` has no tenant_id: it is reachable only through its
  // parent job, so direct access is refused like the platform models below.
};

/**
 * Models with no tenant column of their own. `User`, `Session`, `Permission` and
 * `PlatformAdminGrant` are platform-level by design; `BackgroundJobAttempt`
 * inherits its tenant through `job_id` and is deliberately not queryable here.
 */
const NON_TENANT_MODELS: ReadonlySet<string> = new Set([
  "User",
  "Session",
  "Permission",
  "PlatformAdminGrant",
  "BackgroundJobAttempt",
]);

/**
 * Models that are append-only. The database refuses UPDATE/DELETE by grant, and this
 * list refuses them one layer earlier, so the request path cannot even form the
 * statement (P0.7). Reads and inserts stay available; `upsert` is refused because its
 * update half is still an update.
 */
export const APPEND_ONLY_MODELS: ReadonlySet<string> = new Set(["AuditLog"]);

/** The only operations allowed on an append-only model. */
const APPEND_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "createManyAndReturn",
]);

/** Operations whose arguments carry a `where` the scope is merged into. */
const SCOPED_WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Operations whose `data` must already name this tenant. */
const SCOPED_CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
]);

type QueryArgs = Record<string, unknown>;

/** Rejects a context that was not produced by `createTenantContext`. */
function assertUsableContext(ctx: TenantContext): string {
  const candidate = ctx as unknown as { tenantId?: unknown } | null;
  if (candidate === null || typeof candidate !== "object" || typeof candidate.tenantId !== "string") {
    throw new TenantContextError("Tenant context is missing tenantId.");
  }
  if (candidate.tenantId.trim() === "") {
    throw new TenantContextError("Tenant context is missing tenantId.");
  }
  return candidate.tenantId;
}

function scopeFieldFor(model: string): TenantScopeField {
  const field = TENANT_SCOPE_FIELD[model];
  if (field !== undefined) return field;

  if (NON_TENANT_MODELS.has(model)) {
    throw new TenantModelAccessError(`Model ${model} is not tenant-scoped.`);
  }

  // Fail closed: an unclassified model is not "probably fine".
  throw new TenantModelAccessError(
    `Model ${model} has no tenant isolation policy. Add it to tenant-db.ts before querying it.`,
  );
}

/** Validates one create payload (or every row of a createMany payload). */
function assertCreateOwnsTenant(
  model: string,
  field: TenantScopeField,
  tenantId: string,
  data: unknown,
): void {
  const rows = Array.isArray(data) ? data : [data];

  if (rows.length === 0) {
    throw new TenantWriteScopeError(`Create on ${model} received an empty data list.`);
  }

  for (const row of rows) {
    const value = (row as Record<string, unknown> | null | undefined)?.[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new TenantWriteScopeError(`Create on ${model} is missing ${field}.`);
    }
    if (value !== tenantId) {
      throw new TenantWriteScopeError(
        `Create on ${model} carries a ${field} that does not match the tenant context.`,
      );
    }
  }
}

/**
 * Applies the tenant scope to one operation. Pure: no I/O, so the rules are
 * reviewable in isolation from Prisma's plumbing.
 */
function scopeQueryArgs(
  model: string,
  field: TenantScopeField,
  tenantId: string,
  operation: string,
  args: QueryArgs,
): QueryArgs {
  if (APPEND_ONLY_MODELS.has(model) && !APPEND_ONLY_OPERATIONS.has(operation)) {
    throw new TenantAppendOnlyError(`Model ${model} is append-only: ${operation} is not allowed.`);
  }

  if (SCOPED_CREATE_OPERATIONS.has(operation)) {
    assertCreateOwnsTenant(model, field, tenantId, args.data);
    return args;
  }

  if (!SCOPED_WHERE_OPERATIONS.has(operation)) {
    // Fail closed on any operation this file has not reasoned about.
    throw new TenantModelAccessError(
      `Operation ${operation} on ${model} is not supported through withTenant().`,
    );
  }

  const where = (args.where ?? {}) as Record<string, unknown>;
  // The context wins over caller-supplied values: `tenantId: "B"` cannot re-scope
  // the query. Spreading `where` first and the scope last is deliberate.
  //
  // Workspace consequence (TD-7F-R3): scope field and row key are both `id`, so a
  // foreign `where.id` is overwritten by `tenantId`. The foreign row is never
  // returned; the query either finds the context's own row or nothing. See the
  // `TenantScopeField` comment above and docs/PHASE-2-WORKSPACE-MEMBER.md §2.5.
  const scoped: QueryArgs = { ...args, where: { ...where, [field]: tenantId } };

  if (operation === "upsert") {
    // An upsert can create, so the create half gets the same check as create().
    assertCreateOwnsTenant(model, field, tenantId, scoped.create);
  }

  return scoped;
}

/**
 * Prisma query extension that confines every model operation to one tenant.
 * Exported for tests and for composing with other extensions.
 */
export function tenantExtension(tenantId: string) {
  return {
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model: string;
          operation: string;
          args: QueryArgs;
          query: (args: QueryArgs) => Promise<unknown>;
        }): Promise<unknown> {
          const field = scopeFieldFor(model);
          return query(scopeQueryArgs(model, field, tenantId, operation, args));
        },
      },
    },
  };
}

/**
 * Runs `fn` with a client that can only see `ctx.tenantId`.
 *
 * The context must come from `createTenantContext` (a resolved membership or a
 * re-validated job row). A forged literal is rejected here as well, because the
 * brand is compile-time only.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: TenantScopedPrisma) => Promise<T>,
): Promise<T> {
  const tenantId = assertUsableContext(ctx);
  const scoped = prisma.$extends(tenantExtension(tenantId)) as unknown as TenantScopedPrisma;
  return fn(scoped);
}

/**
 * SYSTEM USE ONLY — health probes, cross-tenant maintenance jobs, test fixtures.
 * Every call site MUST have a `// SYSTEM: <reason>` comment.
 *
 * Deliberately unguarded and unscoped: it is the escape hatch, not the tool.
 * Schema changes do not belong here — they use MIGRATE_DATABASE_URL.
 */
export function systemDb(): PrismaClient {
  return prisma;
}
