# 07 — DATABASE BASELINE DESIGN

> Checkpoint 6C deliverable. Design authority for `packages/database/prisma/schema.prisma`.
>
> **No migration exists and no table was created.** Every statement about runtime
> behaviour of the DDL is marked as unproven; the schema was validated and diffed
> offline only.
>
> Where this document contradicts `02-DATABASE-DESIGN.md`, the deviation is listed
> explicitly in §2 with its reason and impact. Nothing is changed silently.

---

## 1. Scope and Evidence

| Item | Value |
|---|---|
| Prisma | 7.10.1 (`provider = "mysql"`, no `url` in schema) |
| MariaDB | 11.8.6, `max_connections = 151`, `wait_timeout = 28800`, `time_zone = SYSTEM` (WIB) |
| Schema file | `packages/database/prisma/schema.prisma` |
| `prisma validate` | exit 0 — "The schema at prisma/schema.prisma is valid" |
| `prisma generate` | exit 0 — client emitted to `src/generated/prisma` |
| Offline DDL diff | exit 0 — 917 lines, 40 `CREATE TABLE`, 74 `FOREIGN KEY`, 51 `UNIQUE INDEX` |
| Migration applied | **none** |
| Tables in `affiliateos` / `affiliateos_shadow` | 0 / 0 (read-only `information_schema` query) |

The DDL was generated with

```
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

which is a **read-only, offline** command: it reads the schema file and prints SQL.
The output was inspected, counted, and deleted. It was never executed, and no file
was left in `prisma/migrations`.

---

## 2. Deviations from `02-DATABASE-DESIGN.md`

| ID | Phase 0 design | Baseline design | Reason | Impact |
|---|---|---|---|---|
| D-6C-1 | Table `tenants` | Table `workspaces`, columns still `tenant_id` | The product, API and UI call the aggregate a "workspace"; keeping `tenant_id` as the column name preserves greppability of the isolation rule | Rename only; every FK and index uses `tenant_id` |
| D-6C-2 | `SUPER_ADMIN` listed among roles | `SUPER_ADMIN` is **not** a workspace role; platform access is `platform_admin_grants` | A tenant owner must never be able to mint a cross-tenant super user | Workspace roles are the six non-super roles |
| D-6C-3 | `creators` tenant-scoped (agreed) | No global creator identity at all | Two workspaces tracking the same TikTok creator get two independent rows; neither can read the other's notes/pipeline | Cross-workspace creator dedupe impossible by design; documented as a privacy feature |
| D-6C-4 | `tiktok_connections` holds ciphertext + `key_version` | Same, renamed `shop_connections`; no separate `ShopToken` table | One row per authorization; a token table would add a join with no security gain | Rotation still supported via `key_version` |
| D-6C-5 | `audit_logs` append-only | Same; no separate `ShopConnectionAudit` | A second audit subsystem would fragment the trail | Connection events go to `audit_logs` |
| D-6C-6 | `affiliate_orders` (P2/P6) | **Deferred** (`OrderAttribution`) | Response schema of `affiliate_seller/202410/orders/search` was never captured (`docs/03` AFS-7) | No order table until the shape is documented |
| D-6C-7 | `job_runs` | `background_jobs` + `background_job_attempts` | Two tables separate the durable envelope from each attempt | Naming supersedes `job_runs` |
| D-6C-8 | `api_sync_logs` | `sync_runs` + `sync_errors` | A run and its errors have different cardinality and retention | Replaces one wide log table |
| D-6C-9 | `ScheduledTask` (checkpoint prompt) | **Deferred** | BullMQ repeatable jobs own schedules; a DB copy would be a second source of truth | Nothing schedules from the database |
| D-6C-10 | `campaign_products` | **Deferred** | Product-level campaign data depends on `AFS-1`/`AFS-5` payloads that are `BLOCKED (approval)` | Campaign→creator→shop is the MVP shape |

---

## 3. Connection Pool Configuration (Tahap B)

Implemented in `packages/database/src/pool.ts`, consumed by
`packages/database/src/client.ts`. The driver defaults were the problem: with no
options, `mariadb` opens `connectionLimit = 10` connections and keeps them (measured
10 `Sleep` sessions in Checkpoint 6B.1).

| Option | Value | Why |
|---|---|---|
| `connectionLimit` | `DB_POOL_MAX`, default **5** | Bounded per process; see budget below |
| `minimumIdle` | `DB_POOL_MIN_IDLE`, default **1** | Driver default is a fixed pool (all 10 open). 1 warm connection, the rest on demand |
| `acquireTimeout` | 10 000 ms | Explicit instead of implicit driver default |
| `connectTimeout` | 10 000 ms | Headroom for a remote DB/proxy; loopback needs far less |
| `idleTimeout` | 600 s | Must stay **below** `wait_timeout` (28 800 s) so the client closes first |
| `timezone` | `"Z"` | Server `time_zone = SYSTEM` resolves to WIB (UTC+7). Forcing UTC keeps every `DATETIME(3)` unambiguous |
| `leakDetectionTimeout` | not set | Prisma releases connections; console spam would hide real logs |

The connection URL is parsed with `new URL()` and the password is decoded once;
error messages name the variable and never include the URL.

### 3.1 Pool budget

Each Node process owns its pool. Nothing is shared between web and worker.

| Scenario | web | worker | migration job | admin/monitoring | total | % of 151 |
|---|---|---|---|---|---|---|
| Development (this host) | 5 | 3 | 1 (one-shot) | 2 | **11** | 7 % |
| Production, 1 instance | 5 | 3 | 1 (one-shot, pre-deploy) | 2 | **11** | 7 % |
| Production, 2 instances | 10 | 6 | 1 | 2 | **19** | 13 % |
| Production, 4 instances | 20 | 12 | 1 | 2 | **35** | 23 % |

Reserve stays above 75 % of `max_connections` in every planned topology, which
leaves room for a second deploy overlapping the first, a DBA session, and the
migration window.

Why 5 for web: the app is an internal agency tool; a single Next.js process handles
low tens of requests/second. A pool of 5 bounds failure blast radius, and
`minimumIdle = 1` means an idle dev server holds one connection instead of ten.
Why 3 for worker: BullMQ concurrency is planned at 2 (`WORKER_CONCURRENCY=2`);
concurrency + 1 covers a transaction while another job is finishing.

### 3.2 Measured result

Read-only count of `information_schema.PROCESSLIST` rows for `affiliateos_dev`,
Next.js dev server on port 3127:

| Moment | Connections | Note |
|---|---|---|
| Before server start | 1 | the measuring connection itself |
| After `/api/health` responded 200 | 2 | 1 pool + 1 measuring |
| After 5 further requests | 2 | no growth |
| After 6 s idle | 2 | stable |
| After the server was stopped | 1 | pool closed |

Checkpoint 6B.1 measured 11 at the same points (10 pool + 1 measuring). The
pool change removed 9 idle connections per process.

### 3.3 Limits of this measurement

- The account has no `PROCESS` privilege, so the count only sees its own sessions.
  Another user's connections are invisible; `max_connections` is global.
- One process was measured. The worker does not exist yet, so "worker = 3" is a
  budget, not an observation.
- Connection counts were sampled, not traced. A burst above 5 concurrent queries
  would queue (by design) rather than open more connections.

---

## 4. Model Inventory

40 models. "Tenant" means the model carries `tenant_id` and `@@unique([tenantId, id])`
so it can be a composite-FK target.

### 4.1 Identity — global

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `User` | `users` | no | One human, one credential set |
| `Session` | `sessions` | no (has `active_tenant_id`) | Opaque cookie token, stored as SHA-256 |

### 4.2 Tenancy and RBAC

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `Workspace` | `workspaces` | — (is the tenant) | Tenant aggregate |
| `WorkspaceMember` | `workspace_members` | yes | Membership + status; source of tenant resolution |
| `WorkspaceInvitation` | `workspace_invitations` | yes | Hashed invite token, single use |
| `Role` | `roles` | yes | Six system roles per workspace |
| `Permission` | `permissions` | no | Global permission catalog |
| `RolePermission` | `role_permissions` | yes | Explicit grant, composite PK |
| `MemberRole` | `member_roles` | yes | Role assignment, composite PK |
| `PlatformAdminGrant` | `platform_admin_grants` | no | Audited, revocable platform access |

### 4.3 Shops and connections

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `OAuthState` | `oauth_states` | yes | Hashed, single-use OAuth state |
| `ShopConnection` | `shop_connections` | yes | Encrypted tokens + `key_version` + status |
| `Shop` | `shops` | yes | Authorized shop, `shop_cipher`, sync timestamps |
| `ShopSyncState` | `shop_sync_states` | yes | Per-resource cursor/failures |
| `WebhookEvent` | `webhook_events` | yes | Raw envelope, dedupe on notification id |

### 4.4 Creator CRM

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `Creator` | `creators` | yes | Workspace-scoped creator, soft delete |
| `CreatorProfile` | `creator_profiles` | yes | 1:1 extended profile, JSON metrics |
| `CreatorAssignment` | `creator_assignments` | yes | BD ownership history |
| `CreatorActivity` | `creator_activities` | yes | Append-only interaction timeline |
| `CreatorStatusHistory` | `creator_status_histories` | yes | Append-only pipeline transitions |
| `CreatorTag` | `creator_tags` | yes | Workspace labels |
| `CreatorTagAssignment` | `creator_tag_assignments` | yes | Composite PK |
| `CreatorNote` | `creator_notes` | yes | Soft-deleted notes |
| `CreatorBlacklist` | `creator_blacklists` | yes | Do-not-contact, one active row per creator |

### 4.5 Campaigns

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `Campaign` | `campaigns` | yes | Header, primary shop, dates, status |
| `CampaignShop` | `campaign_shops` | yes | Additional shops |
| `CampaignCreator` | `campaign_creators` | yes | Participation + status |
| `CampaignContent` | `campaign_contents` | yes | Versioned brief/script/asset link |
| `CampaignAdCode` | `campaign_ad_codes` | yes | Per-creator code |
| `CampaignStatusHistory` | `campaign_status_histories` | yes | Append-only transitions |

### 4.6 Analytics

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `SyncRun` | `sync_runs` | yes | One ingestion run, counters, cursor |
| `SyncError` | `sync_errors` | yes | Per-error row, retryable flag |
| `CreatorPerformanceSnapshot` | `creator_performance_snapshots` | yes | Aggregated per creator/shop/period |
| `CampaignPerformanceSnapshot` | `campaign_performance_snapshots` | yes | Aggregated per campaign/shop/period |
| `ShopPerformanceSnapshot` | `shop_performance_snapshots` | yes | Aggregated per shop/period |

### 4.7 Jobs, audit, notifications

| Model | Table | Tenant | Purpose |
|---|---|---|---|
| `BackgroundJob` | `background_jobs` | nullable | Durable envelope, idempotency key |
| `BackgroundJobAttempt` | `background_job_attempts` | via job | One row per attempt |
| `AuditLog` | `audit_logs` | nullable | Append-only, **no FKs** |
| `Notification` | `notifications` | yes | In-app notification |
| `NotificationReadState` | `notification_read_states` | yes | Composite PK read marker |

**Raw vs aggregated vs derived** is explicit: `sync_runs`/`sync_errors` record what
happened; the three snapshot tables hold aggregates with `source` and
`metric_version`; dashboards derive from snapshots only.

---

## 5. Type and Constraint Decisions (Tahap F)

| Topic | Decision | Reason |
|---|---|---|
| Primary keys | `CHAR(36)`, UUIDv7 generated in the application | ADR-006; sortable, portable, known before insert, composite-FK friendly. No DB default: the app owns ids |
| External TikTok ids | `VARCHAR(64)` | 19-digit ids must never be parsed as JS numbers |
| Money | `DECIMAL(18,2)` + `CHAR(3)` currency | Exact arithmetic; Float is never used for money |
| Commission rate | integer basis points (`Int`) | Matches `02-DATABASE-DESIGN.md` §1 |
| Time | `DATETIME(3)`, UTC everywhere; session `timezone: "Z"` | Server time zone is WIB; mixing would shift values by 7 hours |
| Booleans | `Boolean` → `TINYINT(1)` | Prisma default for MySQL |
| Enums | Prisma enums → MySQL native `ENUM` | Controlled vocabulary for every status field |
| JSON | Only `payload`, `metadata`, `metrics`, `context`, `granted_scopes` | Never for data that must be queried relationally |
| Soft delete | `deleted_at` on `creators`, `campaigns`, `campaign_contents`, `creator_notes` | These four need undelete; everything else is `RESTRICT`-protected |
| Delete strategy | `Restrict` for parents with financial/history meaning; `Cascade` for pure children | See matrix in §6 |
| Actor columns | plain `CHAR(36)`, no FK (`changed_by_member_id`, `created_by_member_id`, …) | History must survive member removal; same reasoning as `audit_logs` |
| `updated_at` | `@updatedAt` (client-maintained, NOT NULL, no DB default) | Prisma sets it; DDL showed no default, which is expected |

### 5.1 Enum change policy

MySQL `ENUM` is cheap to read and expensive to change: adding a value rewrites the
column definition; removing or reordering one is a data migration. Policy:

1. Append new values at the **end** of an enum when the meaning is additive.
2. Never reorder or reuse a removed value.
3. Renaming a value is a two-step migration (add, backfill, drop) with written
   approval — it is a destructive change under ADR-007.

### 5.2 Collation limitation (F-6C-4)

`02-DATABASE-DESIGN.md` asks for `ascii_bin` on ID and TikTok-ID columns. Prisma's
MySQL connector cannot express a per-column collation, so the generated DDL places
those columns in the table collation (`utf8mb4_unicode_ci`, matching both schemas).

Accepted for Phase 1: TikTok ids are numeric strings and UUIDs are lowercase hex, so
case-insensitive comparison cannot merge two distinct values. If binary comparison is
later required for an external-id join, it must be added as explicit SQL in a
migration, with approval.

---

## 6. Referential Actions

| Parent → child | Action | Reason |
|---|---|---|
| `users` → `sessions` | Cascade | Sessions are meaningless without the user |
| `users` → `workspace_members` | Restrict | A user with memberships is disabled, never deleted |
| `workspaces` → business tables | Cascade | Workspace deletion is a deliberate, audited operation |
| `workspaces` → `workspace_members` | Restrict | Prevents cascading a person's history silently |
| `shop_connections` → `shops` | Restrict | A shop must not outlive its authorization |
| `shops` → `campaigns`, `campaign_creators`→`creators` | Restrict | Financial/history meaning |
| `creators`/`campaigns` → status histories, notes, activities, tags | Cascade | Pure children of a soft-deleted record |
| `campaigns` → `campaign_shops`/`contents`/`ad_codes` | Cascade | Composition |
| `sync_runs` → `sync_errors` | Cascade | Errors have no meaning alone |
| `background_jobs` → `background_job_attempts` | Cascade | Attempt history of one envelope |
| `notifications` → `notification_read_states` | Cascade | Read markers are per-recipient state |
| `background_jobs.tenant_id` | SetNull | A platform job may have no workspace |
| `sessions.active_tenant_id` | SetNull | Selection resets when a workspace is removed |
| `audit_logs` | **no FK at all** | Must outlive every row and user it describes |

Deleting a workspace therefore cascades business rows. No P1 UI deletes a workspace;
if that changes, the workflow must archive first and write an `AuditLog` row in the
same transaction.

---

## 7. Deferred Models (not created, with reason)

| Candidate | Why deferred | Trigger to add |
|---|---|---|
| `OrderAttribution` | `AFS-7` documents the endpoint but not the response schema | Endpoint page captured + order sync approved |
| `CampaignProduct` | Product-level data depends on `AFS-1`/`AFS-5` payloads that are `BLOCKED (approval)` | Product API approved |
| `ScheduledTask` | BullMQ repeatable jobs own schedules | Only if scheduling must survive Redis loss |
| `ShopConnectionAudit` | `audit_logs` already records connection lifecycle | A connection-specific read model is needed |
| Outreach tables (`message_templates`, `outreach_batches`, `outreach_records`, quota snapshots) | Phase 5 and gated on write-scope approval; `docs/02` §4.5 forbids creating them early | Phase 5 gate |
| Global `Creator` identity | Privacy: workspace-scoped rows only | A written cross-workspace dedupe requirement |
| `team_targets` | Phase 6 reporting; no MVP consumer | Phase 6 |

---

## 8. Index Strategy

- Every tenant-scoped table leads its non-unique indexes with `tenant_id`.
- `@@unique([tenantId, id])` exists on every tenant-scoped model, which is the
  composite-FK target and also serves "fetch by id within tenant".
- Tenant-aware natural uniques: `(tenant_id, tiktok_shop_id)`,
  `(tenant_id, tiktok_creator_id)`, `(tenant_id, open_id, user_type)`,
  `(tenant_id, campaign_id, creator_id)`, `(tenant_id, tts_notification_id)`.
- List endpoints rely on `(tenant_id, status, created_at)`, `(tenant_id, creator_id,
  occurred_at)`, `(tenant_id, shop_id, period_start)`.
- No index on `status` alone; the only single-column indexes are `users.status`,
  `shop_id` (FK helper), `permission_id` (FK helper) and `expires_at` (cleanup).
- Exact index counts from the generated DDL: 51 unique indexes, 35 non-unique
  indexes, 74 foreign keys across 40 tables.
- `EXPLAIN` verification is impossible until rows exist; deferred to the migration
  checkpoint.

---

## 9. What Is Still Unproven

1. That the generated DDL applies cleanly to **both** schemas (only offline diff).
2. That MariaDB 11.8 enforces the composite FKs exactly as declared (Prisma emits
   them; MySQL semantics are standard, but not executed here).
3. That `DATETIME(3)` round-trips as UTC through the adapter with `timezone: "Z"`.
4. That `DECIMAL(18,2)`, `BINARY(32)` and `JSON` behave as expected at runtime
   (Checkpoint 6A proved only `SELECT 1`).
5. That the index set is sufficient for real query plans.
6. That the app account's DDL+DML grants are acceptable for production (see the
   report's F-6C-3).
