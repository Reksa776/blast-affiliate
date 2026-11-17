# 08 — TENANT ISOLATION DESIGN

> Checkpoint 6C deliverable. How a workspace boundary is enforced at four layers,
> and the security contract that `withTenant(ctx)` and `systemDb()` must satisfy.
>
> **Only the pure contract is implemented** (`packages/database/src/tenancy.ts`,
> 10 unit tests). The database-backed wrappers are designed here and deferred: they
> need `workspace_members`, `roles` and `role_permissions` to exist, which requires
> the first migration — not authorized in 6C.

---

## 1. The Four Layers

| Layer | Mechanism | Status in 6C |
|---|---|---|
| 1. Type | Branded `TenantContext`; repository functions take it as the **first** argument | Contract implemented |
| 2. Repository | Every query includes `tenantId` derived from the context, never from input | Designed |
| 3. Database | `tenant_id NOT NULL` + `@@unique([tenantId, id])` + composite FKs | Schema implemented, not executed |
| 4. Test | Cross-tenant attack matrix | Contract tests written; DB tests deferred |

No single layer is trusted alone. The database layer is the reason a bug in a
repository cannot become a cross-tenant write: the FK itself refuses.

---

## 2. Where Tenant Identity Comes From

```
Cookie (opaque token)
  → Session row (SHA-256 lookup, not revoked, not expired)
  → WorkspaceMember row (status ACTIVE) for the requested workspace
  → Role → RolePermission → permission keys
  → TenantContext (tenantId = membership.tenant_id)
```

Rules:

1. The browser may send a workspace **selector** (slug in the URL, or a header).
   It is a hint only.
2. The authoritative tenant is the membership row resolved server-side.
3. A selector with no ACTIVE membership returns `403`, never a default workspace.
4. `tenant_id` from a JSON body or query string is ignored for authorization.
5. `TenantContext` is constructed only inside the request/worker bootstrap, never in
   a module, repository, or component.
6. The worker re-reads `background_jobs.tenant_id` from the database and re-validates
   it; the queue payload is not trusted (`assertJobTenantContext`).

---

## 3. Composite Foreign Keys — the Load-Bearing Constraint

```prisma
model Creator {
  id       String @id @db.Char(36)
  tenantId String @map("tenant_id") @db.Char(36)
  @@unique([tenantId, id])   // composite-FK target
}

model CampaignCreator {
  tenantId   String @map("tenant_id") @db.Char(36)
  campaignId String @map("campaign_id") @db.Char(36)
  creatorId  String @map("creator_id") @db.Char(36)

  campaign Campaign @relation(fields: [tenantId, campaignId], references: [tenantId, id])
  creator  Creator  @relation(fields: [tenantId, creatorId],  references: [tenantId, id])

  @@unique([tenantId, campaignId, creatorId])
}
```

Generated DDL (offline diff, verbatim shape):

```sql
ALTER TABLE `campaign_creators`
  ADD CONSTRAINT `campaign_creators_tenant_id_campaign_id_fkey`
  FOREIGN KEY (`tenant_id`, `campaign_id`) REFERENCES `campaigns`(`tenant_id`, `id`);

ALTER TABLE `campaign_creators`
  ADD CONSTRAINT `campaign_creators_tenant_id_creator_id_fkey`
  FOREIGN KEY (`tenant_id`, `creator_id`) REFERENCES `creators`(`tenant_id`, `id`);
```

Consequence: a `campaign_creators` row whose `tenant_id` is A cannot point at a
campaign or creator owned by B — the pair `(B_tenant, id)` does not exist in the
referenced unique key. A cross-tenant write fails with a referential error
(MariaDB 1452), not a silent success.

Coverage: 74 foreign keys, of which the tenant-scoped business relations are all
composite. Two deliberate exceptions:

| Exception | Why | Compensating control |
|---|---|---|
| `sync_runs.shop_id` (nullable, single-column) | Workspace-wide runs have no shop | `sync_runs.tenant_id` still scopes reads; repository resolves the shop through a tenant filter |
| `background_jobs.tenant_id` (nullable, single-column) | Platform jobs have no workspace | Worker validates tenant and job type before any query |

---

## 4. Composite Uniques That Prevent Duplicates

| Table | Constraint | Prevents |
|---|---|---|
| `shops` | `(tenant_id, tiktok_shop_id)` | Same shop twice in one workspace |
| `shop_connections` | `(tenant_id, open_id, user_type)` | Duplicate authorization |
| `creators` | `(tenant_id, tiktok_creator_id)` | Duplicate creator in one workspace |
| `creator_blacklists` | `(tenant_id, creator_id)` | Two conflicting blacklist verdicts |
| `campaign_creators` | `(tenant_id, campaign_id, creator_id)` | Same creator invited twice to one campaign |
| `campaign_shops` | `(tenant_id, campaign_id, shop_id)` | Same shop attached twice |
| `campaign_ad_codes` | `(tenant_id, campaign_id, creator_id, code)` | Duplicate code |
| `webhook_events` | `(tenant_id, tts_notification_id)` | At-least-once delivery duplicates |
| snapshots | `(tenant_id, <entity_id>, shop_id, period_start, period)` | Double-counted aggregates |
| `background_jobs` | `(idempotency_key)` **global** | Double enqueue, including for system jobs |

`background_jobs.idempotency_key` is global rather than `(tenant_id, key)` because a
composite unique containing a NULL `tenant_id` does not constrain system jobs in
MySQL (NULLs are distinct). The key is therefore constructed as
`<type>:<tenantId|platform>:<natural key>` and stays unique across both scopes.

---

## 5. RBAC Design

### 5.1 Permission catalog (global, code-owned, seeded by migration)

| Domain | Permissions |
|---|---|
| Workspace | `workspace.read`, `workspace.manage` |
| Members | `member.read`, `member.invite`, `member.manage`, `role.manage` |
| Creators | `creator.read`, `creator.write`, `creator.delete`, `creator.assign`, `creator.blacklist`, `creator.export` |
| Campaigns | `campaign.read`, `campaign.write`, `campaign.publish`, `campaign.delete` |
| Shops | `shop.read`, `shop.connect`, `shop.disconnect`, `shop.sync` |
| Analytics | `analytics.read`, `analytics.export` |
| Outreach (Phase 5) | `outreach.read`, `outreach.send` — defined, not grantable until the phase gate |
| Audit | `audit.read` |
| Jobs | `job.read`, `job.retry` |

Permissions are explicit strings stored in `permissions`, granted through
`role_permissions`, evaluated server-side by `hasPermission(ctx, key)`. Menu hiding is
never a control.

### 5.2 Initial role matrix (workspace roles)

| Permission group | OWNER | ADMIN | AFFILIATE_MANAGER | BUSINESS_DEVELOPMENT | ANALYST | VIEWER |
|---|---|---|---|---|---|---|
| workspace.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| workspace.manage | ✓ | — | — | — | — | — |
| member.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| member.invite / member.manage | ✓ | ✓ | — | — | — | — |
| role.manage | ✓ | ✓ | — | — | — | — |
| creator.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| creator.write / assign | ✓ | ✓ | ✓ | ✓ | — | — |
| creator.delete / blacklist | ✓ | ✓ | ✓ | — | — | — |
| creator.export | ✓ | ✓ | ✓ | — | ✓ | — |
| campaign.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| campaign.write | ✓ | ✓ | ✓ | — | — | — |
| campaign.publish / delete | ✓ | ✓ | ✓ | — | — | — |
| shop.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shop.connect / disconnect / sync | ✓ | ✓ | — | — | — | — |
| analytics.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| analytics.export | ✓ | ✓ | ✓ | — | ✓ | — |
| audit.read | ✓ | ✓ | — | — | ✓ | — |
| job.read / retry | ✓ | ✓ | — | — | — | — |
| outreach.read / send | ✓ | ✓ | ✓ | — | — | — |

The matrix is data, not code: it is seeded into `role_permissions` per workspace and
can be tuned without a deploy. A matrix test (Phase 1 auth) asserts every
role × protected route pair.

### 5.3 SUPER_ADMIN is not a workspace role

`RoleKey` deliberately omits `SUPER_ADMIN`. Platform-wide access is a separate,
revocable grant:

- `platform_admin_grants` (user, granted by, reason, granted at, revoked at)
- every use requires `audit_logs` with `actor_type = SUPER_ADMIN`
- the route path is separate (`/api/platform/*`), not an extra permission on
  tenant routes
- no tenant owner can create one

---

## 6. Cross-Tenant Attack Matrix (expected results)

| # | Scenario | Expected | Enforced by |
|---|---|---|---|
| 1 | Workspace A reads creator internal to B (`GET /creators/{idB}`) | 404 `not_found` | Repository tenant filter (no row), mapped to 404 |
| 2 | Workspace A updates campaign B (`PATCH /campaigns/{idB}`) | 404, no mutation | `updateMany({ where: { id, tenantId } })` → count 0 |
| 3 | Campaign A uses shop B | Constraint rejected (1452) | Composite FK `(tenant_id, shop_id)` |
| 4 | Job A accesses data of B | Rejected before query | `assertJobTenantContext` + persisted `tenant_id` re-read |
| 5 | Member A without permission deletes data | 403 `forbidden` | `hasPermission` on the server |
| 6 | SUPER_ADMIN performs a global action | Allowed only via `/api/platform/*` + audit row | `PlatformAdminGrant` + explicit audited path |
| 7 | Body contains `tenantId: "B"` | Ignored; request stays in A | Context built from session, not body |
| 8 | Campaign A links creator only known in B | Constraint rejected (1452) | Composite FK `(tenant_id, creator_id)` |
| 9 | Listing endpoint called without tenant context | 401/403, empty result never returned as "all" | Context required to build a query |
| 10 | Raw `prisma` import from a route handler | Build/lint failure (target state) | Export removal in the auth checkpoint (F-6C-11) |

Error mapping matters: cross-tenant reads return `not_found`, never `forbidden`,
so the API does not become an existence oracle.

---

## 7. `withTenant(ctx)` — Design Only

```ts
// packages/database (target shape, NOT implemented in 6C)
export async function withTenant<T>(
  ctx: TenantContext,
  work: (db: TenantDb) => Promise<T>,
): Promise<T>;
```

Security contract:

1. `ctx` must be a branded context produced by `createTenantContext` after a
   server-side membership lookup. A plain object fails to typecheck.
2. Before `work` runs: membership is `ACTIVE`, workspace is `ACTIVE`, session is not
   revoked, and the requested permission (if any) is held.
3. `TenantDb` is a Prisma Client extension (`$extends`), not a new client:
   - `findMany`/`findFirst`/`count`/`aggregate`/`groupBy`: `where.tenantId` is
     overwritten with `ctx.tenantId` — a caller-supplied value is **replaced**, not
     merged.
   - `create`/`createMany`: `data.tenantId` is overwritten with `ctx.tenantId`.
   - `update`/`upsert`/`delete`: the extension rewrites to `updateMany`/`deleteMany`
     with `{ id, tenantId }` and throws `CrossTenantAccessError` when count is 0.
   - Models outside the tenant-scoped allowlist (`users`, `permissions`,
     `platform_admin_grants`) are not reachable through `TenantDb`.
   - `$queryRaw` / `$executeRaw` are not exposed; a named helper that takes the
     context and builds parameterized SQL is the only escape, and it adds
     `tenant_id = ?` itself.
4. `$transaction` is available and carries the same extension.
5. There is no overload without `ctx`, and no `allowUnscoped` flag. A developer
   cannot opt out silently; opting out means importing `systemDb` by name, which is
   greppable in review and CI.

Why not implement now: every rule above is only provable against real membership and
permission rows. Implementing it before the first migration would produce an
untested security boundary — precisely what the checkpoint forbids. The pure half
(context validation, tenant comparison, permission check, job validation) **is**
implemented and tested.

---

## 8. `systemDb()` — Design Only

```ts
// target shape, NOT implemented in 6C
export type SystemReason = "WORKER_JOB" | "MAINTENANCE" | "SUPER_ADMIN";

export async function systemDb<T>(
  reason: SystemReason,
  actor: { userId?: string; grantId?: string; requestId: string },
  work: (db: SystemDb) => Promise<T>,
): Promise<T>;
```

Security contract:

1. Server-only: it must never be importable from a client component, and the module
   is guarded by a boundary test (and `server-only` when the package is wired to
   Next).
2. Not available to arbitrary route handlers: only `/api/platform/*` (SUPER_ADMIN),
   the worker bootstrap, and maintenance scripts call it.
3. Every call writes an `audit_logs` row with `actor_type`, actor ids, `request_id`,
   reason and a resource summary — before or in the same transaction as the work.
4. `SUPER_ADMIN` requires an active `platform_admin_grants` row; a revoked grant
   fails closed.
5. Cross-workspace reads must be explicit: `systemDb` exposes wide access, so each
   call site names the workspaces it touches in the audit metadata.
6. It is prohibited for ordinary business queries. Review rule: any diff that adds
   `systemDb` outside the three allowed call sites is rejected.

Implementation is deferred for the same reason as `withTenant`: it needs sessions,
grants and audit rows to exist. Shipping an unaudited escape hatch would be worse
than shipping none.

---

## 9. What the Tests Prove Today

`packages/database/src/tenancy.test.ts`, 10 tests, `node --test`, no database:

| Test | Proves |
|---|---|
| valid context accepted | shape and permission set |
| blank tenant id rejected | no implicit default workspace |
| user context without membership rejected | identity cannot be partial |
| system context without user allowed | maintenance path is explicit |
| permission check exact/case-sensitive | no prefix or case bypass |
| same-tenant accepted, others rejected | IDOR guard |
| error message contains no identifier | no existence oracle in the message |
| tenant-scoped job without tenant rejected | job contract |
| only named system job types may omit tenant | allowlist, not heuristic |
| job without idempotency key rejected | dedupe precondition |

Not proven: anything requiring tables (actual composite-FK rejection, extension
rewrites, audit row emission).
