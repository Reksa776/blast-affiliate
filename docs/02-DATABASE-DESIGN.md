# 02 — DATABASE DESIGN

> Phase 0 deliverable. Design baseline only — **no migration was created and no
> database was modified**. Phase 1 implements the subset marked `P1`.

---

## 1. Engine and Conventions

| Topic | Decision |
|---|---|
| Engine | MariaDB 11.8+ (host has 11.8.6) |
| Storage engine | InnoDB, explicitly per table |
| Charset | `utf8mb4` / `utf8mb4_0900_ai_ci`-equivalent for MariaDB → use `utf8mb4_unicode_ci`; ID/opaque-code columns use `ascii_bin` |
| Time | All `DATETIME(3)` stored **UTC**; application converts for display (Asia/Jakarta) |
| Primary keys | `CHAR(36)` UUIDv7 generated in the application (ADR-006) |
| External IDs | `VARCHAR(64)` `ascii_bin` (TikTok IDs are 19-digit numeric strings and must never be parsed as JS numbers) |
| Money | `DECIMAL(18,2)` + `CHAR(3)` currency (`IDR`) |
| Rates | Integer **basis points** (`rate_bp`), e.g. `1233` = 12.33% |
| Booleans | `TINYINT(1)` (Prisma `Boolean`) |
| JSON | `JSON` column for raw upstream payloads and flexible metadata only — never for data that must be queried relationally |
| Naming | `snake_case` tables/columns; Prisma models in PascalCase with `@@map`/`@map` |
| Soft delete | `deleted_at DATETIME(3) NULL` only where the product needs undelete (creators, campaigns, notes, templates); everything else is `RESTRICT`-protected hard delete |
| Audit | `audit_logs` is append-only; no `UPDATE`/`DELETE` grants for the app account |

---

## 2. Tenant Isolation Model (binding)

1. Every **business** table carries `tenant_id CHAR(36) NOT NULL` as the first
   column of its clustered-relevant indexes.
2. Every tenant-scoped table has `UNIQUE KEY uq_tenant_id (tenant_id, id)` so it can
   be the target of a **composite foreign key**.
3. Child rows use composite FKs:
   `FOREIGN KEY (tenant_id, creator_id) REFERENCES creators (tenant_id, id)`.
   A cross-tenant reference is therefore *impossible*, not merely discouraged.
4. Tenant-aware uniqueness: e.g. `UNIQUE (tenant_id, tiktok_shop_id)` — two tenants
   may each track the same TikTok shop; neither may duplicate it internally.
5. `users` is deliberately **platform-global** (one human, one credential set,
   possible membership in several tenants). It is never exposed by ID across
   tenants; every read goes through `workspace_members`, which is tenant-scoped.
6. `permissions` is a **global catalog** (reference data). `roles`,
   `role_permissions`, `member_roles` are tenant-scoped so a tenant can customize.
7. `audit_logs.tenant_id` is `NULL`-able for platform-level events (login failures
   with no resolved tenant); all business audit rows are non-null.
8. The application DB user has **no** `SUPER`, `FILE`, `PROCESS`, or grant options;
   it is granted DML on the AffiliateOS schema only. Migrations run as a separate
   migration user with DDL rights.
9. No `FOREIGN_KEY_CHECKS=0` in application code or tests.

---

## 3. Entity Overview

```
users ──< sessions
  │
  └──< workspace_members >── tenants
            │                    │
            ├──< member_roles >── roles ──< role_permissions >── permissions
            │
            └── tenant_id scopes everything below
                                 │
   ┌─────────────────────────────┼───────────────────────────────┐
   │                             │                               │
 tiktok_connections ──< shops     campaigns ──< campaign_products  team_targets
        │                │             │  │
        │                │             │  └──< campaign_creators >── creators
        │                │             │            │                 │
        │                │        campaign_briefs   │          creator_profiles
        │                │        campaign_assets   │          creator_tags ─< creator_tag_assignments
        │                │             │            │          creator_notes
        │                │        creator_ad_codes   │          creator_status_histories
        │                │             │            │          creator_assignments
        │                │        outreach_records ─┘          creator_blacklists
        │                │             │
        │                │        outreach_batches ──< message_templates
        │                │             │
        │                │        outreach_quota_snapshots
        │                │
        │           affiliate_orders
        │           analytics_snapshots
        │           api_sync_logs
        │           webhook_events
        │           job_runs
        └── oauth_states
                    notifications, audit_logs
```

---

## 4. Table Catalog

`P1` = created in the Phase 1 migration. Later phases create their own migrations.

### 4.1 Identity and access (P1)

#### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | UUIDv7 |
| `email` | VARCHAR(320) | `UNIQUE`, stored lowercase, `utf8mb4_unicode_ci` |
| `email_verified_at` | DATETIME(3) NULL | |
| `password_hash` | VARCHAR(255) | Argon2id encoded string (`$argon2id$…`) |
| `display_name` | VARCHAR(120) | |
| `status` | ENUM('ACTIVE','SUSPENDED','DISABLED') | default `ACTIVE` |
| `failed_login_count` | INT UNSIGNED | throttling aid |
| `locked_until` | DATETIME(3) NULL | |
| `last_login_at` | DATETIME(3) NULL | |
| `created_at`, `updated_at` | DATETIME(3) | |

Indexes: `uq_users_email (email)`, `idx_users_status (status)`.
Deletion: `RESTRICT` if any membership exists; use `status = DISABLED`.

#### `sessions`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `user_id` | CHAR(36) | FK → users, `ON DELETE CASCADE` |
| `token_hash` | BINARY(32) | SHA-256 of the opaque cookie token; `UNIQUE` |
| `active_tenant_id` | CHAR(36) NULL | last selected workspace; validated on use |
| `ip_hash` | BINARY(32) NULL | never store raw IP |
| `user_agent` | VARCHAR(255) NULL | truncated |
| `created_at` | DATETIME(3) | |
| `last_seen_at` | DATETIME(3) | idle timeout basis |
| `expires_at` | DATETIME(3) | absolute expiry |
| `revoked_at` | DATETIME(3) NULL | logout / forced revoke |

Indexes: `uq_sessions_token_hash`, `idx_sessions_user_expires (user_id, expires_at)`.

#### `tenants`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `slug` | VARCHAR(64) | `UNIQUE`, `[a-z0-9-]`, immutable |
| `name` | VARCHAR(160) | |
| `status` | ENUM('ACTIVE','SUSPENDED') | |
| `plan` | ENUM('INTERNAL') | placeholder; no billing in initial phase |
| `created_at`, `updated_at` | DATETIME(3) | |

#### `workspace_members`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) | FK → tenants |
| `user_id` | CHAR(36) | FK → users |
| `status` | ENUM('INVITED','ACTIVE','SUSPENDED','REMOVED') | |
| `job_title` | VARCHAR(120) NULL | BD role label |
| `invited_by` | CHAR(36) NULL | FK → users |
| `joined_at`, `created_at`, `updated_at` | DATETIME(3) | |

Constraints: `UNIQUE (tenant_id, user_id)`, `UNIQUE (tenant_id, id)` (composite-FK
target). Index: `idx_members_user_status (user_id, status)` — the critical lookup
for server-side tenant resolution.

#### `roles`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) | seeded per tenant (`OWNER`, `ADMIN`, `BD_MANAGER`, `BD_STAFF`, `ANALYST`) |
| `key` | VARCHAR(64) | `UNIQUE (tenant_id, key)` |
| `name` | VARCHAR(120) | |
| `is_system` | TINYINT(1) | system roles cannot be deleted/renamed |
| `created_at`, `updated_at` | DATETIME(3) | |

#### `permissions`
Global reference table: `id CHAR(36) PK`, `key VARCHAR(96) UNIQUE`
(e.g. `creator.read`, `creator.write`, `campaign.publish`, `outreach.send`,
`analytics.read`, `team.manage`, `audit.read`, `shop.connect`), `description`.

#### `role_permissions`
`tenant_id`, `role_id`, `permission_id`; PK `(tenant_id, role_id, permission_id)`;
composite FKs to `roles (tenant_id, id)`; FK to `permissions (id)`.

#### `member_roles`
`tenant_id`, `member_id`, `role_id`, `assigned_by`, `assigned_at`;
PK `(tenant_id, member_id, role_id)`; composite FKs to `workspace_members (tenant_id, id)`
and `roles (tenant_id, id)`.

### 4.2 Shops and TikTok connections (P1 schema, P2 population)

#### `tiktok_connections`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) | |
| `user_type` | TINYINT | 0 seller, 1 creator, 3 partner (documented enum) |
| `open_id` | VARCHAR(64) | seller/creator identity from token response |
| `seller_name` | VARCHAR(160) NULL | |
| `region` | CHAR(2) NULL | `ID` expected |
| `access_token_ciphertext` | VARBINARY(1024) | AES-256-GCM `iv‖tag‖ct` |
| `refresh_token_ciphertext` | VARBINARY(1024) | same |
| `access_token_expires_at` | DATETIME(3) | from `access_token_expire_in` epoch |
| `refresh_token_expires_at` | DATETIME(3) | from `refresh_token_expire_in` |
| `granted_scopes` | JSON | array of scope strings as returned |
| `key_version` | SMALLINT UNSIGNED | encryption key id |
| `status` | ENUM('ACTIVE','EXPIRED','REVOKED','ERROR') | |
| `last_refreshed_at`, `last_error_at`, `created_at`, `updated_at` | DATETIME(3) | |

Constraints: `UNIQUE (tenant_id, open_id, user_type)`, `UNIQUE (tenant_id, id)`.
No token column is ever selected by list queries — explicit `select` allowlists.

#### `shops`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) | |
| `connection_id` | CHAR(36) | composite FK → `tiktok_connections (tenant_id, id)` |
| `tiktok_shop_id` | VARCHAR(64) | `ascii_bin` |
| `shop_cipher` | VARCHAR(128) | required query param on shop-scoped calls |
| `name` | VARCHAR(200) | |
| `region` | CHAR(2) | |
| `shop_type` | VARCHAR(32) NULL | local / cross-border / global-selling |
| `status` | ENUM('CONNECTED','DISCONNECTED','SUSPENDED','DEAUTHORIZED') | |
| `last_synced_at` | DATETIME(3) NULL | |
| `created_at`, `updated_at` | DATETIME(3) | |

Constraints: `UNIQUE (tenant_id, tiktok_shop_id)`, `UNIQUE (tenant_id, id)`.

#### `oauth_states`
| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) | initiating tenant |
| `user_id` | CHAR(36) | initiating user |
| `state_hash` | BINARY(32) | SHA-256 of the random `state`; raw state never stored |
| `intent` | ENUM('CONNECT_SHOP','RECONNECT_SHOP','CONNECT_CREATOR') | |
| `redirect_path` | VARCHAR(255) NULL | internal path only — validated against allowlist |
| `consumed_at` | DATETIME(3) NULL | single use |
| `expires_at` | DATETIME(3) | ≤ 10 minutes |
| `created_at` | DATETIME(3) | |

Index: `uq_oauth_states_hash (state_hash)`, `idx_oauth_states_expires (expires_at)`.

### 4.3 Creators / CRM (P3)

| Table | Purpose | Key constraints |
|---|---|---|
| `creators` | canonical creator record per tenant | `UNIQUE (tenant_id, tiktok_creator_id)` when present; `UNIQUE (tenant_id, id)`; soft delete |
| `creator_profiles` | 1:1 extended/profile metrics snapshot | `UNIQUE (tenant_id, creator_id)` |
| `creator_assignments` | BD team ownership over time | `(tenant_id, creator_id, member_id)` history rows, `is_active`; index `(tenant_id, member_id, is_active)` |
| `creator_tags`, `creator_tag_assignments` | tenant-defined labeling | tag `UNIQUE (tenant_id, label)`; assignment PK `(tenant_id, creator_id, tag_id)` |
| `creator_notes` | append-only notes with author | soft delete; index `(tenant_id, creator_id, created_at)` |
| `creator_status_histories` | pipeline transitions | append-only; index `(tenant_id, creator_id, changed_at)` |
| `creator_blacklists` | do-not-contact with reason/scope | `UNIQUE (tenant_id, creator_id)`; checked before any outreach |

Deletion: creators are soft-deleted; dependent rows `RESTRICT` so history is never
silently destroyed.

### 4.4 Campaigns (P4)

| Table | Purpose | Key constraints |
|---|---|---|
| `campaigns` | campaign header, shop, dates, status | FK to shops via `(tenant_id, shop_id)`; index `(tenant_id, status, starts_at)` |
| `campaign_products` | products in campaign | `UNIQUE (tenant_id, campaign_id, tiktok_product_id)` |
| `campaign_creators` | invited/participating creators | `UNIQUE (tenant_id, campaign_id, creator_id)`; status enum |
| `campaign_briefs` | brief content, versioned | `UNIQUE (tenant_id, campaign_id, version)` |
| `campaign_assets` | uploaded assets metadata (no blobs in DB) | FK campaign |
| `creator_ad_codes` | per-creator promo/ad code | `UNIQUE (tenant_id, campaign_id, creator_id, code)` |

Constraint worth calling out: `campaigns` references `shops` **and**
`campaign_products` references `campaigns` — both composite, so a campaign can
never attach a product from another tenant's campaign.

### 4.5 Outreach (P5) — capability-gated

| Table | Purpose | Key constraints |
|---|---|---|
| `message_templates` | approved template text with variables | `UNIQUE (tenant_id, key, version)`; soft delete |
| `outreach_batches` | one send run | index `(tenant_id, status, created_at)` |
| `outreach_records` | per creator per batch | **duplicate prevention**: `UNIQUE (tenant_id, shop_id, creator_id, quota_period)` where `quota_period` is the ISO week; index `(tenant_id, batch_id, status)` |
| `outreach_quota_snapshots` | recorded quota state at send time | index `(tenant_id, shop_id, captured_at)` |

No outreach table is created before the official capability is approved; the
schema exists in design only.

### 4.6 Analytics and sync (P2/P6)

| Table | Purpose | Key constraints |
|---|---|---|
| `affiliate_orders` | order-level affiliate facts | `UNIQUE (tenant_id, tiktok_order_id)`; index `(tenant_id, shop_id, ordered_at)` |
| `analytics_snapshots` | periodic aggregates with explicit metric definition id | `UNIQUE (tenant_id, metric_key, dimension_key, period_start)` |
| `api_sync_logs` | per-call/sync-run record, no secrets | index `(tenant_id, created_at)`, `(tenant_id, job_type, status)` |
| `webhook_events` | raw event envelope + verification result | `UNIQUE (tenant_id, tts_notification_id)`; raw payload JSON |
| `job_runs` | idempotency + execution record | `UNIQUE (tenant_id, idempotency_key)` |
| `team_targets` | BD targets per member per period | `UNIQUE (tenant_id, member_id, period_start)` |
| `notifications` | in-app notifications | index `(tenant_id, user_id, read_at)` |
| `audit_logs` | append-only audit trail | index `(tenant_id, created_at)`, `(tenant_id, entity_type, entity_id)`; no FKs (must survive deletion) |

---

## 5. Phase 1 Migration Scope (proposed, not authorized)

Phase 1 creates exactly: `users`, `sessions`, `tenants`, `workspace_members`,
`roles`, `permissions`, `role_permissions`, `member_roles`, `audit_logs`,
`job_runs` (skeleton), plus the two junction tables needed by auth.
`tiktok_connections`, `shops`, `oauth_states` are Phase 2.

Rationale: Phase 1 must prove tenant isolation + RBAC + audit before any TikTok
credential exists. Creating 30 tables up front would freeze design decisions that
Phase 2/3 evidence should still be able to influence.

---

## 6. Indexing Strategy

- Every tenant-scoped table leads with `tenant_id` in its non-unique indexes.
- List endpoints have a matching composite index for their default sort
  (`(tenant_id, created_at DESC)`), verified with `EXPLAIN` in Phase 1 tests.
- No index on `status` alone — always `(tenant_id, status, …)`.
- Full-text search for creators is deferred; Phase 3 starts with `LIKE` on indexed
  prefixes only if row counts stay small, otherwise a dedicated index table.
- Foreign keys are indexed implicitly by InnoDB only for the referenced side; every
  FK column gets an explicit index on the referencing side.

---

## 7. Deletion and Retention

| Data | Behaviour |
|---|---|
| Users | Never hard-deleted while memberships exist; `DISABLED` |
| Sessions | Hard-deleted after `expires_at` + 30 days by a maintenance job |
| Creators / notes / campaigns | Soft delete (`deleted_at`), 30-day purge policy decided by product |
| Orders / snapshots | Append-only, retained; corrections via new rows or explicit `voided_at` |
| Audit logs | Retained ≥ 1 year; app user cannot delete |
| Webhook events | Retained 90 days, then archived |
| Raw API payloads | Retained 30 days unless referenced by an audit incident |

Nothing is deleted by a background job without an explicit retention rule above.

---

## 8. Migration and Rollback Strategy

- Prisma Migrate; migrations are **forward-only** and committed to
  `packages/database/prisma/migrations`.
- Development: `prisma migrate dev` against a dedicated dev database with a shadow
  database (requires the migration user to have `CREATE`/`DROP` on shadow schemas —
  an operator provisioning requirement).
- CI/tests: apply migrations from zero to a fresh MariaDB 11.8 instance; a migration
  that only works on an already-populated DB is a defect.
- Production: `prisma migrate deploy` inside a maintenance window after a verified
  backup. **No** `db push`, ever.
- Rollback plan per migration, chosen before authoring it:
  1. **Reversible by compensating migration** (preferred: additive changes).
  2. **Restore from pre-migration backup** (destructive changes only, requires
     written approval and a restore rehearsal).
- Destructive operations (`DROP TABLE`, `DROP COLUMN`, narrowing a type, adding a
  `NOT NULL` without default to a populated table) require explicit human approval
  and a documented data-migration step. They are never bundled with feature work.
- Migration naming: `YYYYMMDDHHMM_phaseN_short_description`.
- Every migration PR includes: intent, affected tables, lock risk, estimated
  duration on production-sized data, rollback path.

Verified in Phase 1: `SHOW TABLE STATUS` confirms InnoDB and `utf8mb4`; a test
asserts no table exists without `tenant_id` where it should have one.

---

## 9. Open Database Questions

| # | Question | Why it matters | Owner |
|---|---|---|---|
| Q1 | Is MariaDB 11.8.6 acceptable to Prisma 7.10.1's `mysql` provider in all needed features (JSON filtering, `CHECK` constraints, generated columns)? | Schema portability | Phase 1 spike |
| Q2 | Does the deployment target allow `CREATE DATABASE` for a shadow DB, or only a pre-created schema? | Migration workflow | Operator |
| Q3 | Should `permissions` be seeded by migration or by a provisioning script? | Determinism vs flexibility | Phase 1 |
| Q4 | Is a second `tenant_id`-only index needed for cross-tenant admin reporting? | Query performance | Phase 6 |
| Q5 | Retention duration for audit logs and raw payloads (compliance input) | Storage + privacy | Product/legal |
