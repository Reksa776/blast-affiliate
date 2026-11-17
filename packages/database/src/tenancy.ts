// AffiliateOS — tenant-isolation contract (pure, no database access).
//
// This module is the part of `withTenant(ctx)` / `systemDb()` that can be proven
// TODAY, without a migrated database: the shape of a tenant context, the rules
// that make one valid, and the checks every repository and worker must run.
//
// The database-backed wrappers are deliberately NOT implemented in Checkpoint 6C.
// They need `sessions`, `workspace_members` and `role_permissions` to exist, which
// requires the first migration — not authorized. Implementing a wrapper that
// cannot be tested against real membership data would be exactly the abstract,
// unprovable API the checkpoint forbids. Design + security contract live in
// docs/08-TENANT-ISOLATION-DESIGN.md.
//
// Dependency direction: this file depends on nothing. `packages/tenancy` will
// resolve a session into a TenantContext and re-use these guards; the database
// package never accepts a raw tenant id from a request.

declare const tenantContextBrand: unique symbol;

/** Where the context came from. `system` is only valid for maintenance work. */
export type ActorType = "user" | "worker" | "system";

/**
 * A tenant context may only be produced by server-side authentication: the
 * membership row resolved from the session cookie, or a persisted job row
 * re-validated by the worker. It must never be constructed from a request body,
 * query string, or header.
 *
 * The brand makes it a compile error to pass a plain object literal where a
 * TenantContext is required.
 */
export type TenantContext = {
  readonly [tenantContextBrand]: true;
  readonly tenantId: string;
  /** Empty only for actorType `system`. */
  readonly userId: string;
  /** Empty only for actorType `system`. */
  readonly membershipId: string;
  readonly actorType: ActorType;
  readonly requestId: string;
  readonly permissions: ReadonlySet<string>;
};

/** Rejected before any query is built. Never contains ids or credentials. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/** Returned to the caller as `not_found` by HTTP adapters (no existence oracle). */
export class CrossTenantAccessError extends Error {
  constructor() {
    super("Resource not found.");
    this.name = "CrossTenantAccessError";
  }
}

export type TenantContextInput = {
  tenantId: string;
  userId: string;
  membershipId: string;
  actorType: ActorType;
  requestId: string;
  permissions: Iterable<string>;
};

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TenantContextError(`Tenant context is missing ${field}.`);
  }
  return value;
}

/**
 * Builds a context from an already-authenticated membership.
 * Callers must derive the arguments from the database, not from the request.
 */
export function createTenantContext(input: TenantContextInput): TenantContext {
  const actorType = input.actorType;

  if (actorType !== "user" && actorType !== "worker" && actorType !== "system") {
    throw new TenantContextError("Tenant context has an unknown actor type.");
  }

  const tenantId = requireIdentifier(input.tenantId, "tenantId");
  const requestId = requireIdentifier(input.requestId, "requestId");

  // A user or worker context without an actor identity is a bug, not a wildcard.
  const userId = actorType === "system" ? (input.userId ?? "") : requireIdentifier(input.userId, "userId");
  const membershipId =
    actorType === "system" ? (input.membershipId ?? "") : requireIdentifier(input.membershipId, "membershipId");

  const permissions = new Set<string>();
  for (const permission of input.permissions) {
    if (typeof permission === "string" && permission !== "") permissions.add(permission);
  }

  // The brand is compile-time only; this is the single place allowed to mint it.
  return {
    tenantId,
    userId,
    membershipId,
    actorType,
    requestId,
    permissions,
  } as unknown as TenantContext;
}

/** The only `where` fragment a repository may use to scope a tenant query. */
export function tenantScope(ctx: TenantContext): { tenantId: string } {
  return { tenantId: ctx.tenantId };
}

/** Permission check for server-side authorization (never UI-only). */
export function hasPermission(ctx: TenantContext, permission: string): boolean {
  return ctx.permissions.has(permission);
}

/**
 * Throws unless the row belongs to the context's tenant. Every read, update and
 * delete of a tenant-scoped row must pass through this before mutating.
 */
export function assertSameTenant(ctx: TenantContext, rowTenantId: string | null | undefined): void {
  if (!rowTenantId || rowTenantId !== ctx.tenantId) {
    throw new CrossTenantAccessError();
  }
}

/** Job types that legitimately run without a workspace (maintenance, platform). */
export const SYSTEM_JOB_TYPES: ReadonlySet<string> = new Set([
  "maintenance.cleanup",
  "maintenance.retention",
  "platform.reconcile",
]);

export type JobTenantEnvelope = {
  type: string;
  tenantId?: string | null;
  idempotencyKey: string;
};

/**
 * The worker must re-validate the tenant from the persisted job row before
 * touching data; the queue payload alone is not trusted. Tenant-scoped jobs
 * without a tenant id are rejected, and system jobs are named explicitly.
 */
export function assertJobTenantContext(job: JobTenantEnvelope): void {
  if (job.idempotencyKey.trim() === "") {
    throw new TenantContextError("Background job is missing its idempotency key.");
  }
  if (SYSTEM_JOB_TYPES.has(job.type)) return;
  if (!job.tenantId || job.tenantId.trim() === "") {
    throw new TenantContextError(`Background job "${job.type}" is tenant-scoped but carries no tenantId.`);
  }
}
