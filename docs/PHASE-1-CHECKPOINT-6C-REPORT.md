# PHASE 1 — CHECKPOINT 6C REPORT
## Database Architecture & Migration Readiness

**Status: PASS WITH LIMITATIONS**
**Date:** 2026-11-16
**Branch:** `main` — **HEAD unchanged:** `5b5d061cc74b43a208684776f656212a64d764bd`
**Previous checkpoint:** 6B.1 — PASS

> **No migration was created or executed. No table exists. The database was not
> modified.** The schema was validated and diffed offline; the pool change was
> measured against a live dev server.

Companion documents:
`docs/07-DATABASE-BASELINE-DESIGN.md`, `docs/08-TENANT-ISOLATION-DESIGN.md`,
`docs/09-MIGRATION-PLAN.md`.

---

## 1. Executive Summary

| Objective | Result |
|---|---|
| Pool explicitly configured | **Done** — `DB_POOL_MAX` (5), `minimumIdle` 1, explicit timeouts, `timezone: "Z"` |
| Idle connections reduced (F-6B-3) | **Done and measured** — 11 → **2** connections at the same observation points |
| Baseline schema designed and validated | **Done** — 40 models, `prisma validate` exit 0, client generated |
| Multi-tenant relations | **Done** — composite FKs `(tenant_id, x_id) → (tenant_id, id)`; 74 FKs in the generated DDL |
| RBAC designed | **Done** — global permission catalog, 6 workspace roles, matrix, separate audited SUPER_ADMIN path |
| `withTenant` / `systemDb` | **Contract implemented and tested** (pure half); database-backed wrappers deliberately deferred |
| Migration plan + rollback | **Done** — 5 staged migrations, M1 = 13 tables; rollback and recovery documented |
| Database unchanged | **Verified** — 0 tables in both schemas, 0 migration folders |
| Secrets | **No leak** — no credential in any new file; scan recorded in §25 |
| Build and typecheck | **Pass** — typecheck exit 0, `next build` exit 0 |

Overall: **PASS WITH LIMITATIONS**, because two properties cannot be proven without
executing a migration, which this checkpoint explicitly forbids: (a) that MariaDB
enforces the composite foreign keys as declared, and (b) that `DATETIME(3)` round-trips
as UTC through the adapter. Neither was assumed; both are listed in §29.

---

## 2. Initial Audit

| Check | Result |
|---|---|
| Branch | `main` |
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd` — **matches expected** |
| Staged files | 0 |
| Tracked modifications | `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` (from 6B.1, preserved) |
| Untracked (pre-existing) | `.env.example`, `apps/`, `packages/`, `package*.json`, six checkpoint reports |
| Monorepo | npm workspaces: `apps/web`, `packages/database` |
| Root scripts | `generate`, `validate`, `verify:db`, `build:database`, `typecheck`, `build`, `test` (added) |
| Prisma config | `packages/database/prisma.config.ts` — explicit root `.env` load, `url` + `shadowDatabaseUrl` |
| Schema (before) | generator + `datasource db { provider = "mysql" }`, **no models** |
| Singleton | `packages/database/src/client.ts`, memoised on `globalThis`, non-production only |
| Env loader | `src/env.ts` (non-Next), `apps/web/next.config.ts` (Next) — both explicit, fail fast |
| npm allowlist | exactly `prisma@7.10.1`, `@prisma/engines@7.10.1`; `npm install-scripts ls` reports no unreviewed scripts |
| Driver | `mariadb` 3.5.4, single copy, transitive via `@prisma/adapter-mariadb@7.10.1` |

No user change was overwritten and no Git state was touched.

---

## 3. Environment Verification

| Item | Observed |
|---|---|
| Node / npm | v26.13.0 / 11.20.0 |
| Prisma CLI / Client / adapter | 7.10.1 / 7.10.1 / 7.10.1 |
| MariaDB | 11.8.6 |
| Next / React / TypeScript | 16.4.6 / 19.3.1 / 7.0.2 |
| Account | `affiliateos_dev@127.0.0.1` (confirmed via `CURRENT_USER()` in 6A/6B.1) |
| Schemas visible to the account | `affiliateos`, `affiliateos_shadow`, `information_schema` only |

Server variables read (read-only `SELECT @@…`):

| Variable | Value | Relevance |
|---|---|---|
| `max_connections` | **151** | Pool budget denominator |
| `max_user_connections` | 0 (unlimited) | Only the server cap applies |
| `wait_timeout` / `interactive_timeout` | 28800 / 28800 | `idleTimeout` 600 must stay below |
| `time_zone` | **SYSTEM** → `WIB` | App forces session `timezone: "Z"` |
| `collation_server` | `utf8mb4_uca1400_ai_ci` | Differs from schema collation |
| Schema collations | `affiliateos` and `affiliateos_shadow` = `utf8mb4_unicode_ci` | Matches `docs/02` |
| `default_storage_engine` | InnoDB | |
| `sql_mode` | `STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION` | Strict inserts |
| `innodb_lock_wait_timeout` / `lock_wait_timeout` | 50 / **86400** | Migration job must lower the latter |
| `max_allowed_packet` | 16 MiB | Fine for JSON payloads |
| `net_read_timeout` / `net_write_timeout` | 30 / 60 | Below `acquireTimeout` 10 s? No — both are far above it |

---

## 4. Pool Configuration

`packages/database/src/pool.ts` (new) + `client.ts` (wired to it).

| Option | Value | Source |
|---|---|---|
| `connectionLimit` | 5 | `DB_POOL_MAX` (validated 1–50) |
| `minimumIdle` | 1 | `DB_POOL_MIN_IDLE`, clamped to `connectionLimit` |
| `acquireTimeout` | 10 000 ms | constant |
| `connectTimeout` | 10 000 ms | constant |
| `idleTimeout` | 600 s | constant, < `wait_timeout` |
| `timezone` | `"Z"` | constant |
| Host/port/user/password/database | parsed from `DATABASE_URL` once | `parseConnectionUrl` |

Budget (each process owns its pool):

| Topology | web | worker | migration | admin | total | % of 151 |
|---|---|---|---|---|---|---|
| Development | 5 | 3 | 1 | 2 | 11 | 7 % |
| Production, 1 instance | 5 | 3 | 1 | 2 | 11 | 7 % |
| Production, 2 instances | 10 | 6 | 1 | 2 | 19 | 13 % |

The URL never appears in an error message; invalid input names the variable only.

---

## 5. Connection Measurement

Method: `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='affiliateos_dev'`
via the `mariadb` CLI with `MYSQL_PWD`, Credential read from the root `.env` inside a
Node process and never printed. Each sample includes the measuring connection (+1).

| Moment | 6B.1 (defaults) | 6C (explicit pool) |
|---|---|---|
| Before server start | 1 | 1 |
| After `/api/health` 200 | 11 | **2** |
| After 5 more requests | 11 | **2** |
| After idle wait | 11 | **2** |
| After server stopped | 1 | 1 |

Dev server on port 3127: `GET /api/health` → `{"status":"ok","database":"up"}` HTTP 200,
5–6 ms warm. No listener remained (`ss` count 0 after stop).

**Limitation (F-6B.1-2, unchanged):** the account lacks `PROCESS`, so only its own
sessions are visible; and only one process exists, so the worker's budget of 3 is a
plan, not a measurement. Privileges were **not** changed.

---

## 6. Prisma Singleton Review

| Check | Result |
|---|---|
| One client per process | Yes — module-level `export const prisma` |
| Created at import time | Yes, by design; env must be loaded first (documented) |
| `$disconnect()` per request | No |
| Dev hot-reload | Memoised on `globalThis` when `NODE_ENV !== "production"` |
| Production memoisation | Deliberately off (no stale client after deploy) |
| Pool duplication | None — one adapter, one pool; `buildPoolOptions` is pure |
| Credential exposure | URL read from `process.env`, not logged |
| Health route | Uses the public package export; no second client |

Verdict: unchanged and still safe; the only edit is how the adapter is constructed.

---

## 7. Database Baseline Model Inventory

40 models = 40 tables. Full table in `docs/07` §4; counts by domain:

| Domain | Models |
|---|---|
| Identity | `User`, `Session` (2) |
| Tenancy / RBAC | `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `Role`, `Permission`, `RolePermission`, `MemberRole`, `PlatformAdminGrant` (8) |
| Shops / connections | `OAuthState`, `ShopConnection`, `Shop`, `ShopSyncState`, `WebhookEvent` (5) |
| Creator CRM | `Creator`, `CreatorProfile`, `CreatorAssignment`, `CreatorActivity`, `CreatorStatusHistory`, `CreatorTag`, `CreatorTagAssignment`, `CreatorNote`, `CreatorBlacklist` (9) |
| Campaigns | `Campaign`, `CampaignShop`, `CampaignCreator`, `CampaignContent`, `CampaignAdCode`, `CampaignStatusHistory` (6) |
| Analytics | `SyncRun`, `SyncError`, `CreatorPerformanceSnapshot`, `CampaignPerformanceSnapshot`, `ShopPerformanceSnapshot` (5) |
| Jobs | `BackgroundJob`, `BackgroundJobAttempt` (2) |
| Audit / notifications | `AuditLog`, `Notification`, `NotificationReadState` (3) |

Deferred with written reasons (`docs/07` §7): `OrderAttribution`, `CampaignProduct`,
`ScheduledTask`, `ShopConnectionAudit`, all outreach tables, global creator identity,
`team_targets`.

---

## 8. Entity Relationship Design

```
users ─< sessions >─ workspaces
  └─< workspace_members >─ workspaces ─< roles ─< role_permissions >─ permissions
              └─< member_roles
workspaces ─< shop_connections ─< shops ─< shop_sync_states
                                      └─< campaigns ─< campaign_shops
                                                     ─< campaign_creators >─ creators
                                                     ─< campaign_contents
                                                     ─< campaign_ad_codes
                                                     ─< campaign_status_histories
                                      └─< *_performance_snapshots
creators ─< creator_profiles / assignments / activities / status_histories
         ─< creator_tag_assignments >─ creator_tags
         ─< creator_notes / creator_blacklists
workspaces ─< background_jobs ─< background_job_attempts
           ─< notifications ─< notification_read_states
           ─< audit_logs            (no FKs by design)
```

`users` is platform-global; every business table hangs off `workspaces` through
`tenant_id`. A user reaches data only through an ACTIVE `workspace_members` row.

---

## 9. Multi-Tenant Isolation

Design detail in `docs/08`. Summary:

1. `tenant_id CHAR(36) NOT NULL` on every workspace-owned table.
2. `@@unique([tenantId, id])` on every such table — the composite-FK target.
3. Child relations are composite: verified in the generated DDL, e.g.
   `FOREIGN KEY (tenant_id, creator_id) REFERENCES creators(tenant_id, id)`.
4. Tenant-aware uniqueness prevents duplicates inside a workspace without preventing
   two workspaces from tracking the same shop/creator.
5. Tenant identity comes from the session → membership row, never from the request body.
6. 74 FKs total; 2 deliberate single-column exceptions, both documented with a
   compensating control (`sync_runs.shop_id`, `background_jobs.tenant_id`).

Result: a cross-tenant *write* is refused by the database, not merely by a `WHERE`.

---

## 10. RBAC Design

- 26 explicit permissions across workspace, members, creators, campaigns, shops,
  analytics, outreach (gated), audit, jobs.
- 6 workspace roles: `WORKSPACE_OWNER`, `WORKSPACE_ADMIN`, `AFFILIATE_MANAGER`,
  `BUSINESS_DEVELOPMENT`, `ANALYST`, `VIEWER`.
- Full role × permission matrix in `docs/08` §5.2; seeded as data, not hardcoded.
- `SUPER_ADMIN` is **not** a workspace role (deviation D-6C-2): platform access is a
  revocable `platform_admin_grants` row, a separate `/api/platform/*` path, and an
  audit row per use. A tenant owner cannot create one.
- Server-side check is `hasPermission(ctx, key)`; UI hiding is not a control.
- Role/permission changes are audited and require `role.manage`.

---

## 11. TikTok Shop Connection Design

| Requirement | Implementation |
|---|---|
| No plaintext token | `access_token_ciphertext` / `refresh_token_ciphertext` `VARBINARY(1024)` (AES-256-GCM envelope) |
| Rotatable key | `key_version` (`SMALLINT UNSIGNED`) |
| Credential bound to workspace + shop | `shop_connections.tenant_id`, `shops.(tenant_id, connection_id)` composite FK |
| Status tracking | `PENDING / ACTIVE / EXPIRED / REVOKED / ERROR` + `last_refreshed_at`, `last_error_at` |
| Revocation | status change + `AuditLog` (no separate audit table, D-6C-5) |
| OAuth state | hashed, single-use, ≤ 10 min, tied to user + workspace |
| Webhook ingest | raw envelope stored, dedupe `(tenant_id, tts_notification_id)`, `signature_verified` flag |
| No live API | nothing in this checkpoint calls TikTok; the schema only stores what an approval would later produce |

Capability dependency: every shop/creator/order/outreach field that depends on an
unverified endpoint is marked in `docs/03` and no table was created for it (see §14).

---

## 12. Creator CRM Design

- `Creator` is **workspace-scoped** (D-6C-3), soft-deleted, unique per
  `(tenant_id, tiktok_creator_id)`.
- Pipeline: `NEW → CONTACTED → INVITED → ACCEPTED → COLLABORATING → COMPLETED`, plus
  `REJECTED`, `UNRESPONSIVE`, `BLACKLISTED` as a controlled enum.
- `CreatorStatusHistory` is append-only with `from_status`, `to_status`, actor and
  reason — the audit trail for pipeline movement.
- `CreatorAssignment` keeps owner history (`is_active`, `unassigned_at`) instead of
  overwriting the owner.
- `CreatorActivity` is a separate interaction timeline; `CreatorNote` supports
  soft delete.
- `CreatorBlacklist` is unique per creator and must be checked before any campaign
  invitation or outreach.
- The same TikTok creator in two workspaces produces two rows; neither workspace can
  read the other's notes, tags, or pipeline.

---

## 13. Campaign Design

- `Campaign` requires a primary `shop_id` **and** both references are composite, so a
  campaign cannot attach another workspace's shop (constraint, not convention).
- `CampaignShop` adds extra shops, also composite on both sides.
- `CampaignCreator` is composite to both `Campaign` and `Creator`: a campaign in A
  cannot invite a creator known only in B — the pair does not exist in the referenced
  unique key.
- `CampaignContent` is versioned per `(tenant, campaign, kind, version)`; versions are
  append-only.
- `CampaignAdCode` unique per `(tenant, campaign, creator, code)`.
- `CampaignStatusHistory` is append-only with actor and reason.
- Products are deferred (D-6C-10) because product payloads are `BLOCKED (approval)`.

---

## 14. Analytics Design

| Layer | Tables | Purpose |
|---|---|---|
| Raw run bookkeeping | `sync_runs`, `sync_errors` | what was fetched, cursors, failures, retryable flag |
| Aggregates | `creator_*`, `campaign_*`, `shop_performance_snapshots` | period aggregates with `source` + `metric_version` |
| Derived | dashboards only | computed from snapshots, never from provider rows |

- Every snapshot row states its `source` (`TIKTOK_AFFILIATE_API`, `MANUAL_IMPORT`,
  `DERIVED`) and `metric_version`, so a mock or manual number cannot be presented as
  live API data (links to `docs/03` §1).
- `OrderAttribution` is deferred: `AFS-7` documents the endpoint but not the response
  schema, and the capability is `BLOCKED (approval)`.
- Money is `DECIMAL(18,2)`; commission rate stays integer basis points.

---

## 15. Background Job Design

`background_jobs` + `background_job_attempts`.

| Field | Purpose |
|---|---|
| `tenant_id` (nullable) | Tenant context, re-read by the worker; NULL only for named system jobs |
| `type` | Job class (`tiktok.sync.orders`, `outreach.batch.execute`, …) |
| `payload` JSON | Identifiers only; **never** a token, secret, or authorization decision |
| `status` | `PENDING/SCHEDULED/RUNNING/SUCCEEDED/FAILED/CANCELLED/DEAD_LETTER` |
| `attempts` / `max_attempts` | Retry bookkeeping (default 6, matching the Phase 0 policy) |
| `scheduled_at`, `started_at`, `completed_at` | Timing and SLA evidence |
| `last_error_summary` | Safe, truncated; no stack traces or upstream bodies |
| `idempotency_key` | **Globally unique**, constructed as `type:tenant|platform:naturalKey` |

`BackgroundJobAttempt` records each run with duration and error class. Scheduling
itself stays in BullMQ (D-6C-9); the database is not a second scheduler.

---

## 16. Audit and Notification Design

`audit_logs` (append-only, **no FKs** so it survives deletion):

`actor_type`, `actor_user_id`, `actor_member_id`, `tenant_id` (nullable for platform
events), `action`, `resource_type`, `resource_id`, `request_id`, `ip_hash`,
`user_agent`, `metadata` (redacted), `created_at`.

Indexes: `(tenant_id, created_at)`, `(tenant_id, resource_type, resource_id)`,
`(actor_user_id, created_at)`. Passwords, tokens and secrets are never written to
`metadata` — the writer's redaction contract is in `docs/04` §3.15.

Notifications: `notifications` (per recipient, level `INFO/SUCCESS/WARNING/ERROR`,
optional resource link) + `notification_read_states` with composite PK
`(tenant_id, notification_id, user_id)`.

---

## 17. Composite Foreign Key Review

| Check | Result |
|---|---|
| Every tenant-scoped child uses `(tenant_id, parent_id)` | Yes for all business relations |
| Referenced side is `@@unique([tenantId, id])` | Yes on every tenant-scoped model |
| DDL emitted correctly | Verified offline: 74 `FOREIGN KEY`, e.g. `role_permissions (tenant_id, role_id) → roles (tenant_id, id)` |
| Referential actions declared | Restrict for history/financial parents, Cascade for pure children, SetNull only where null is meaningful |
| Self-referencing / ambiguous relations | None; two relations to the same model (`PlatformAdminGrant` → `User`) are explicitly named |
| Exceptions | `sync_runs.shop_id`, `background_jobs.tenant_id` — single-column, documented with compensating controls |
| Enforcement actually executed | **No** — needs the first migration (limitation L-1) |

---

## 18. Index Review

| Principle | Applied |
|---|---|
| Tenant first | every non-unique index on a tenant table starts with `tenant_id` |
| No `status` alone | composite `(tenant_id, status, …)` |
| FK helper indexes | `shop_id`, `permission_id` |
| Cleanup index | `oauth_states.expires_at`, `workspace_invitations.expires_at` |
| Counts | 51 unique + 35 non-unique indexes, 74 FKs (offline DDL) |
| Selectivity verification | **Not possible yet** — needs rows and `EXPLAIN` (limitation L-3) |

---

## 19. `withTenant(ctx)` Design

Not implemented; security contract in `docs/08` §7. Contract summary:

1. Branded `TenantContext` produced only after a server-side membership lookup.
2. Preconditions: session not revoked, membership ACTIVE, workspace ACTIVE.
3. `TenantDb` is a Prisma Client **extension**, not a second client: it overwrites
   `where.tenantId` / `data.tenantId` with the context value, rewrites
   `update`/`delete` into `*Many` with `{ id, tenantId }` and throws on 0 rows.
4. Models outside the tenant allowlist are unreachable; raw SQL is not exposed.
5. No overload without `ctx`, no `allowUnscoped` flag.

Implemented today, and tested: the pure half — `createTenantContext`,
`tenantScope`, `hasPermission`, `assertSameTenant`, `assertJobTenantContext`
(`packages/database/src/tenancy.ts`, 10 passing tests).

Rationale for deferring the wrapper: its guarantees can only be proven against real
membership/permission tables. Publishing an untested security boundary would violate
the checkpoint's own rule against unprovable abstractions.

---

## 20. `systemDb()` Design

Not implemented; contract in `docs/08` §8:

- Server-only; never importable from a client component (boundary test, `server-only`).
- Allowed call sites only: `/api/platform/*` (active `platform_admin_grants`), worker
  bootstrap, maintenance scripts.
- Every call writes an `audit_logs` row with reason, actor, request id and the
  workspaces touched.
- Not a shortcut for business queries; a diff adding it elsewhere is rejected in review.
- Fails closed if the grant is revoked.

Both wrappers land in the Phase 1 authentication checkpoint, together with the
membership tables that make them testable.

---

## 21. Migration Plan

Recommendation: **five staged migrations**, not one 40-table baseline. Full plan in
`docs/09`.

| # | Migration | Tables | Gate |
|---|---|---|---|
| M1 | `phase1_identity_tenancy_rbac` | 13 | first approval (Phase 1 auth) |
| M2 | `phase2_shop_connections` | 5 | Phase 2 |
| M3 | `phase3_creator_crm` | 9 | Phase 3 |
| M4 | `phase4_campaigns` | 6 | Phase 4 (needs M2+M3) |
| M5 | `phase6_analytics_notifications` | 7 | Phase 6 |

Rationale: each migration matches a phase gate, keeps review small, and prevents
capability-gated tables from existing before approval. Creation order, defaults, enum
strategy, referential actions, locking (`lock_wait_timeout = 10` vs server default
86400), and shadow-database validation are documented in `docs/09` §2–§5.

`migrate diff` was executed **offline only** (`--from-empty --to-schema`), produced
917 lines / 40 tables / 74 FKs, was inspected, and was deleted. Nothing was written to
`prisma/migrations`.

---

## 22. Rollback and Recovery

- Prisma has no down migrations (ADR-007): rollback = restore, or a compensating
  migration for additive changes.
- Empty-database rollback for M1: drop in documented reverse dependency order, only
  with written approval.
- With data: restore the pre-migration dump (`mariadb-dump --single-transaction
  --routines --triggers`), verify checksums, then decide.
- Recovery runbook: dump → baseline counts → apply → `migrate status` + table count →
  `/api/health` smoke → on failure restore into a scratch schema.
- Never edit an applied migration; never roll back by hand-editing SQL.
- No rollback was executed in this checkpoint (nothing to roll back).

---

## 23. Prisma Validation

| Command | Result |
|---|---|
| `prisma validate` | **exit 0** — "The schema at prisma/schema.prisma is valid" |
| `prisma generate` | **exit 0** — client 7.10.1 → `src/generated/prisma` (391 ms) |
| Offline `migrate diff --from-empty --to-schema … --script` | **exit 0** — 917 lines, 40 tables, 74 FKs, 51 unique indexes |

**Not validated:** that the DDL applies, that MariaDB enforces the composite FKs, and
that the schema behaves as designed at runtime. `prisma validate` checks syntax and
configuration only — it is not a migration test.

---

## 24. Typecheck and Build

| Check | Command | Result |
|---|---|---|
| DB typecheck | `tsc -p tsconfig.json --noEmit` | exit 0 |
| All workspaces | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` (build + `node --test`) | **10 pass, 0 fail** |
| Production build | `npm run build` | exit 0 — "Compiled successfully in 843ms" |
| Route table | — | `ƒ /api/health` (dynamic, unchanged) |
| Runtime smoke | dev server :3127 | `/api/health` 200 `{"status":"ok","database":"up"}` |

The build required `DATABASE_URL` (known F-6B-1); the repository `.env` supplied it.
No production build ran in parallel with anything else.

---

## 25. Security Audit

| Check | Result |
|---|---|
| Credential in new source/docs | None — scan for URL-shaped strings found placeholders only (`.env.example`) |
| `.env` read/printed | Never read as content; values loaded inside Node, never echoed |
| Connection URL in error messages | `parseConnectionUrl` throws named errors; the URL is not interpolated |
| `$disconnect()` per request | No |
| Pool duplication | No — one adapter per process |
| Token columns | Ciphertext only; `key_version` present; no plaintext column exists |
| Audit metadata | Documented as redacted; no token/password fields in the model |
| Body/query tenant id | Ignored by design; context is server-derived |
| Raw `prisma` export | Still exported and used by `/api/health` — **F-6C-6, OPEN** |
| npm audit (`--omit=dev`) | 0 vulnerabilities |
| New dependencies | **None** (tests use built-in `node:test`) |

---

## 26. Database Safety

Read-only verification after all work:

| Check | Result |
|---|---|
| Tables in `affiliateos` | **0** |
| Tables in `affiliateos_shadow` | **0** |
| Views / routines / triggers | 0 / 0 / 0 |
| `prisma/migrations` | **does not exist** |
| `migrate dev/deploy/reset`, `db push`, `db pull` | not executed |
| DDL/DML statements issued | none — only `SELECT`, `SHOW`, `@@variables` |
| Grants changed | no |
| Other schemas accessed | no (only the two project schemas + `information_schema`) |

Grant state (unchanged, evidence that the capability exists but was not used): the
account holds `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW` on both project schemas,
plus `USAGE` globally. No `PROCESS`, `SUPER`, `FILE`, or `GRANT OPTION`. The
DDL-capable single account is **F-6C-3 (NEEDS APPROVAL)**.

---

## 27. Git Status

| Item | Result |
|---|---|
| Branch | `main` |
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd` — unchanged |
| Staged | 0 |
| Commits / push / reset / stash | none |
| Modified (tracked) | `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` — cumulative `14 insertions, 7 deletions`; 6B.1's 3.5.4 corrections preserved, 6C added rule 6 for the verified `--to-schema` flag rename |
| New in 6C | `packages/database/src/pool.ts`, `src/tenancy.ts`, `src/tenancy.test.ts`, `docs/07`, `docs/08`, `docs/09`, this report |
| Modified in 6C | `packages/database/src/client.ts`, `prisma/schema.prisma`, `packages/database/package.json`, `package.json`, `.env.example` |

`.env` remains untracked and git-ignored.

---

## 28. Findings

| ID | Severity | Status | Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| F-6C-1 | High | **CLOSED** | 6B.1 measured 10 idle pool connections; explicit pool now yields 2 total (1 pool + 1 measuring) at the same points | Each process no longer holds 10 idle connections | Keep `DB_POOL_MAX` ≤ 5 per process; re-measure when the worker exists |
| F-6C-2 | High | **CLOSED** | Server `time_zone = SYSTEM` = WIB; driver session forced to `Z` in `pool.ts` | Removes a 7-hour ambiguity for every `DATETIME(3)` | Verify one round-trip after the first migration |
| F-6C-3 | High | **NEEDS APPROVAL** | `SHOW GRANTS`: one account with DDL **and** DML on both schemas (dev decision documented in `prisma.config.ts`) | App compromise can drop tables and rewrite audit rows; violates `docs/02` §2 item 8 | Create `affiliateos_migrate` (DDL) + `affiliateos_app` (DML, no DDL, no `UPDATE`/`DELETE` on `audit_logs`) before M1 |
| F-6C-4 | Low | **ACCEPTED WITH REASON** | Prisma cannot express per-column collation; DDL uses `utf8mb4_unicode_ci` | `ascii_bin` intent from `docs/02` is unmet for id columns | Harmless for lowercase UUIDs and numeric TikTok ids; add raw SQL only if a binary join is ever needed |
| F-6C-5 | Medium | **OPEN** | App account holds `UPDATE`/`DELETE` on `audit_logs` | Append-only is convention only, not enforced | Fixed by the grant split in F-6C-3 |
| F-6C-6 | Medium | **OPEN** | `packages/database/src/index.ts` exports raw `prisma`; `/api/health` imports it | Developers can bypass tenant scoping | Replace with a scoped health helper and `withTenant`/`systemDb` exports in the auth checkpoint |
| F-6C-7 | Low | **CLOSED** | `--to-schema-datamodel` removed in Prisma 7; `--to-schema` works | Stale command in `docs/06` | `docs/06` §6 rule 6 added |
| F-6C-8 | High | **DEFERRED** | Composite FKs exist in generated DDL only | Isolation at the database layer is designed but unproven | First post-migration test: cross-tenant insert must fail with 1452 |
| F-6C-9 | Low | **ACCEPTED WITH REASON** | Prisma enums → MySQL `ENUM` | Adding/removing values needs DDL | Append-at-end policy documented in `docs/07` §5.1 |
| F-6C-10 | Low | **ACCEPTED WITH REASON** | `sync_runs.shop_id`, `background_jobs.tenant_id` are single-column FKs | No database-level tenant check on those two edges | Repository/worker validation plus tenant-first indexes; revisit if either leaks |
| F-6C-11 | Medium | **DEFERRED** | No rows → no `EXPLAIN` | Index sufficiency unverified | Measure the 5 core list queries after M1/M3 |
| F-6C-12 | Low | **ACCEPTED WITH REASON** | `minimumIdle: 1` | Slight cold-start latency after `idleTimeout` | Trade accepted for 9 fewer idle connections; raise to 2 if perceived |
| F-6C-13 | Medium | **DEFERRED** | Pure-contract tests only (10) | Repository/extension behaviour untested | DB-backed tests immediately after M1 |
| F-6C-14 | Medium | **ACCEPTED WITH REASON** | `workspaces` → business tables use `Cascade` | Deleting a workspace deletes its business data | No delete UI in Phase 1; require archive + audit workflow before exposing one |
| F-6C-15 | Low | **CLOSED** | `.env.example` lacked the pool variables | Operators could not tune the pool | `DB_POOL_MAX`, `DB_POOL_MIN_IDLE` added (names only) |

---

## 29. Limitations

1. **L-1 — Composite FK enforcement not executed.** The constraints exist in the
   offline DDL; MariaDB never saw them. Cannot be proven without a migration.
2. **L-2 — UTC round-trip unproven.** `timezone: "Z"` is configured, but no
   `DATETIME(3)` has been written or read (no tables).
3. **L-3 — Index plans unverified.** No rows, no `EXPLAIN`.
4. **L-4 — Worker pool not measured.** Only the web process exists.
5. **L-5 — Connection visibility limited.** No `PROCESS` privilege; other users'
   sessions unseen. Privileges deliberately unchanged.
6. **L-6 — One process measured at a time**, per the resource rules.
7. **L-7 — `withTenant`/`systemDb` unimplemented.** Only their pure contract is
   testable today; the wrappers ship with the membership tables.
8. **L-8 — TikTok-dependent fields are designed, not confirmed.** Every such field is
   traceable to a `docs/03` row that is at best `DOCUMENTED`, often `BLOCKED (approval)`.

None of these were converted into a claim of success.

---

## 30. Recommendation for the Next Checkpoint

1. **Approve the design and M1 only** (13 tables: identity, tenancy, RBAC, audit, job
   envelope). Do not bundle M2–M5.
2. **Resolve F-6C-3 first**: split the DDL and DML accounts, then run M1 with the DDL
   account. This also closes F-6C-5.
3. Run M1 in a maintenance window with a pre-migration dump, then execute the
   acceptance tests: cross-tenant insert → 1452; `/api/health` 200; `migrate status`
   clean; table count 13.
4. Implement `withTenant(ctx)` / `systemDb()` against the real tables, add DB-backed
   tenant attack tests, and remove the raw `prisma` export (F-6C-6).
5. Then proceed to authentication (sessions, Argon2id, CSRF) as Phase 1 originally
   sequenced.

**CHECKPOINT 6C LOCKED.** No migration, no table, no commit, no push. Waiting for
explicit approval.
