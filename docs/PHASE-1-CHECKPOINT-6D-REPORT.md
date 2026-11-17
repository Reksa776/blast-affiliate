# PHASE 1 — CHECKPOINT 6D REPORT
## Database Security Separation & M1 Preflight

**Status: PASS WITH LIMITATIONS**
**Date:** 2026-11-16
**Branch:** `main` — **HEAD unchanged:** `5b5d061cc74b43a208684776f656212a64d764bd`
**Previous checkpoint:** 6C — PASS WITH LIMITATIONS

> No account was created, no privilege changed, no migration executed, no table
> created, nothing committed or pushed. The database still has **0 tables**.

Design authority for the account split: `docs/10-DATABASE-SECURITY-SEPARATION.md`.

---

## 1. Initial Git Audit

| Check | Result |
|---|---|
| Branch | `main` |
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd` — matches expected |
| Staged | 0 |
| Tracked modification | `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` (preserved from 6B.1/6C) |
| Untracked before 6D | `.env.example`, `apps/`, `packages/`, `package*.json`, 7 checkpoint reports, `docs/07`, `docs/08`, `docs/09` |
| User changes overwritten | none |

---

## 2. Database Privilege Audit

Sanitized `SHOW GRANTS` (password hash redacted at capture time):

```
GRANT USAGE ON *.* TO `affiliateos_dev`@`127.0.0.1`
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW
      ON `affiliateos`.* TO `affiliateos_dev`@`127.0.0.1`
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW
      ON `affiliateos_shadow`.* TO `affiliateos_dev`@`127.0.0.1`
```

| Check | Result |
|---|---|
| Accounts in use | **one** — `affiliateos_dev@127.0.0.1` for runtime, CLI and shadow |
| Global privileges | `USAGE` only; no `SUPER`, `PROCESS`, `FILE`, `GRANT OPTION` |
| Schema privileges | 13 per schema, **DDL + DML together** |
| Table-level grants | 0 rows |
| Schemas visible | `affiliateos`, `affiliateos_shadow`, `information_schema` only |
| Tables | 0 in both schemas |

Findings: the runtime credential can `DROP` every table and `UPDATE`/`DELETE` the
audit trail (F-6D-1, F-6D-2). Unused extras relative to a minimal set:
`CREATE TEMPORARY TABLES`, `LOCK TABLES`, `CREATE VIEW`, `SHOW VIEW`.

---

## 3. Runtime / Migration Account Separation Design

Three accounts, least privilege, no schema-wide DML (MySQL has no `DENY`, so a
schema-wide grant would re-open `audit_logs`):

| Account | Rights | Scope |
|---|---|---|
| `affiliateos_app` | `SELECT, INSERT, UPDATE, DELETE` per business table; `SELECT, INSERT` on `audit_logs` | `affiliateos` only |
| `affiliateos_migrate` | `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES` | `affiliateos` only |
| `affiliateos_shadow` | same DDL set | `affiliateos_shadow` only |

Rationale and exact statements (marked **NOT EXECUTED**) are in `docs/10` §2–§4.
A third account is proposed beyond the two requested because `shadowDatabaseUrl` is
read by the same CLI config as the migration URL; scoping the shadow account to
`affiliateos_shadow` makes shadow isolation a grant fact.

Provisioning needs a privileged login and explicit approval — **not performed**.

---

## 4. Environment Separation

Measured state:

| Check | Result |
|---|---|
| `.env` permissions | `600` |
| Variables present | `DATABASE_URL`, `SHADOW_DATABASE_URL` |
| `MIGRATE_DATABASE_URL` | absent → transitional fallback active |
| Runtime schema | `affiliateos` |
| Shadow schema | `affiliateos_shadow` (correct target) |
| Same account for runtime and shadow | **yes** (finding F-6D-3) |

Implemented this checkpoint (no credential change):

1. `prisma.config.ts` now resolves the datasource URL from `MIGRATE_DATABASE_URL`
   when set, falling back to `DATABASE_URL` only in the current single-account state
   (comment marks the fallback for deletion).
2. `packages/database/src/pool.ts`: `assertSeparateAccounts()` refuses to start the
   runtime when both URLs resolve to the same `user@host:port`.
3. `client.ts` calls it before building the adapter; a no-op today, by design.
4. `.env.example` documents `MIGRATE_DATABASE_URL` (name only).

Planned layout per process (docs/10 §6): web/worker get only `DATABASE_URL`; the CLI
gets `MIGRATE_DATABASE_URL` + `SHADOW_DATABASE_URL`; no process gets all three.

---

## 5. Audit Log Immutability

**Current claim: NOT append-only.** The only account that will write `audit_logs`
holds `UPDATE` and `DELETE` on `affiliateos.*`. Stating otherwise would be false.

Target (docs/10 §5):

| Control | Mechanism | Status |
|---|---|---|
| Primary | Table-level grant `SELECT, INSERT` on `audit_logs` only (no schema-wide DML) | designed, needs M1 + accounts |
| Defence in depth | `BEFORE UPDATE`/`BEFORE DELETE` triggers raising `SQLSTATE 45000` | designed, needs DDL approval |
| Repository rule | only `create`/`findMany` on `audit_logs`; no `update`/`upsert`/`delete` | documented |
| Structural | `audit_logs` has **no FKs**, so no cascade ever requires `DELETE` on it | already in schema |

Prisma runtime compatibility: `create` (INSERT) and `findMany` (SELECT) are exactly
what the audit writer/reader need; a forbidden call fails server-side with 1142.
Trigger trade-off: retention purges require dropping/recreating triggers in a
maintenance window — documented, not hidden.

---

## 6. Raw Prisma Export Audit

Before 6D:

| Consumer | Usage |
|---|---|
| `apps/web/src/app/api/health/route.ts` | `prisma.$queryRaw\`SELECT 1\`` — the only application import |
| `packages/database/src/index.ts` | `export { prisma }` |
| `packages/database/src/scripts/verify-connection.ts` | imports `../client.js` directly (internal, not the public API) |

Change applied:

| File | Change |
|---|---|
| `packages/database/src/health.ts` (new) | `checkDatabaseHealth()` — fixed `SELECT 1`, boolean result, error swallowed |
| `packages/database/src/index.ts` | **`prisma` no longer exported**; exports `checkDatabaseHealth` + `disconnectPrisma` |
| `apps/web/src/app/api/health/route.ts` | uses `checkDatabaseHealth()`; no Prisma import |

Verification: **zero** source files under `apps/` import `prisma` (`grep --include=*.ts
--include=*.tsx`, excluding `.next`); typecheck and `next build` pass; dev smoke
returns 200. The only remaining textual matches are `sourcesContent` inside
gitignored `.next` source maps — including one stale dev chunk that still embeds the
pre-6D route source. That is build output, not code, and it is not tracked.

The web layer has no unscoped query surface (F-6D-4 CLOSED). The package now exposes
no general query API at all — correct, since no business table and no auth layer
exists yet.

---

## 7. Tenant Access Design

Unchanged from 6C and still design-only for the wrappers:

- `TenantContext` is branded and can only be minted by `createTenantContext`, whose
  inputs must come from a server-side membership lookup (implemented, tested).
- `assertSameTenant`, `tenantScope`, `hasPermission`, `assertJobTenantContext`
  implemented and tested (10 tests).
- `withTenant(ctx)` (Prisma Client extension: overwrite `tenantId` in `where`/`data`,
  rewrite update/delete to `*Many` + throw on 0 rows, no raw SQL, model allowlist) —
  designed in `docs/08` §7.
- `systemDb()` (server-only, three allowed call sites, mandatory audit row, active
  `platform_admin_grants` for SUPER_ADMIN) — designed in `docs/08` §8.

Both remain unimplemented because they need `workspace_members` / `role_permissions`
rows to be testable. Shipping them now would create an unprovable security boundary.

---

## 8. Reconciliation of the 40 Models

Executed against the real schema file (script parsed `^model `, checked disjointness,
coverage and FK direction):

| Check | Result |
|---|---|
| Models in schema | **40** |
| Planned across M1–M5 | **40** |
| Duplicates (model in two migrations) | **none** |
| Models missing from the plan | **none** |
| Planned but absent from schema | **none** |
| Group counts | M1 13 · M2 5 · M3 9 · M4 6 · M5 7 |
| FK-owning relation fields | 72 (+2 named relations missed by the first parser pass = **74 FKs**) |
| Composite tenant FKs (`tenant_id` + parent id) | **29** |
| Single-column FKs | 45 |
| Cross-migration forward references | **none** |

Independent DDL check (offline `migrate diff`): 40 `CREATE TABLE`, 74 `FOREIGN KEY`,
51 `UNIQUE INDEX`. The earlier 72-vs-74 discrepancy was a parser filter that skipped
`@relation("Name", fields: …)` on `PlatformAdminGrant`; per-table comparison confirmed
`platform_admin_grants: schema=2, ddl=2`. No schema change was made to force a number.

---

## 9. Migration Table Lists

**M1 — 13** (`phase1_identity_tenancy_rbac`)
`User`, `Session`, `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `Permission`,
`Role`, `RolePermission`, `MemberRole`, `PlatformAdminGrant`, `AuditLog`,
`BackgroundJob`, `BackgroundJobAttempt`
→ tables: `users`, `sessions`, `workspaces`, `workspace_members`,
`workspace_invitations`, `permissions`, `roles`, `role_permissions`, `member_roles`,
`platform_admin_grants`, `audit_logs`, `background_jobs`, `background_job_attempts`

**M2 — 5** (`phase2_shop_connections`)
`ShopConnection`, `Shop`, `ShopSyncState`, `OAuthState`, `WebhookEvent`

**M3 — 9** (`phase3_creator_crm`)
`Creator`, `CreatorProfile`, `CreatorAssignment`, `CreatorActivity`,
`CreatorStatusHistory`, `CreatorTag`, `CreatorTagAssignment`, `CreatorNote`,
`CreatorBlacklist`

**M4 — 6** (`phase4_campaigns`)
`Campaign`, `CampaignShop`, `CampaignCreator`, `CampaignContent`, `CampaignAdCode`,
`CampaignStatusHistory`

**M5 — 7** (`phase6_analytics_notifications`)
`SyncRun`, `SyncError`, `CreatorPerformanceSnapshot`, `CampaignPerformanceSnapshot`,
`ShopPerformanceSnapshot`, `Notification`, `NotificationReadState`

13 + 5 + 9 + 6 + 7 = 40. Each model appears exactly once.

---

## 10. M1 Dependency Order

Logical order (Prisma emits all `CREATE TABLE`s first, then `ALTER TABLE … ADD
CONSTRAINT`, so FKs never block creation; the order matters for review, manual
recovery, and rollback):

| # | Table | Depends on |
|---|---|---|
| 1 | `users` | — |
| 2 | `workspaces` | — |
| 3 | `workspace_members` | `users`, `workspaces` |
| 4 | `workspace_invitations` | `workspaces` |
| 5 | `permissions` | — (global catalog) |
| 6 | `roles` | `workspaces` |
| 7 | `role_permissions` | `roles (tenant_id,id)`, `permissions` |
| 8 | `member_roles` | `workspace_members (tenant_id,id)`, `roles (tenant_id,id)` |
| 9 | `platform_admin_grants` | `users` (×2, named relations) |
| 10 | `sessions` | `users`, `workspaces` (`active_tenant_id`, `SET NULL`) |
| 11 | `audit_logs` | — (no FKs by design) |
| 12 | `background_jobs` | `workspaces` (nullable, `SET NULL`) |
| 13 | `background_job_attempts` | `background_jobs` |

Rollback drops in reverse: attempts → jobs → audit_logs → sessions → grants →
member_roles → role_permissions → roles → permissions → invitations → members →
workspaces → users.

Deliberate choices worth naming:

- `audit_logs` is created inside M1 even though it has no FKs: every M1 mutation must
  be auditable from the first day.
- `background_jobs` is in M1 so the job envelope exists before any domain table; its
  `tenant_id` is nullable and re-validated by the worker.
- `permissions` has no tenant column (global reference data); `roles` do, because a
  workspace may customize its role set later.

---

## 11. M1 Acceptance Tests (must pass after M1; none executed now)

Run against a scratch schema, never production.

| # | Test | Expected |
|---|---|---|
| A1 | `prisma migrate status` | up to date, no drift |
| A2 | Table count | **13 application tables + `_prisma_migrations`** = 14 |
| A3 | `SHOW TABLE STATUS` for all 14 | InnoDB, `utf8mb4_unicode_ci` |
| A4 | FK count via `information_schema.REFERENTIAL_CONSTRAINTS` | equals the offline DDL for these 13 tables |
| A5 | Composite FK negative: insert `role_permissions` with tenant A + role of tenant B | **1452** rejected |
| A6 | Composite FK negative: insert `member_roles` with member of A + role of B | **1452** rejected |
| A7 | Tenant unique: duplicate `(tenant_id, user_id)` in `workspace_members` | **1062** rejected |
| A8 | `(tenant_id, id)` unique exists on all 12 tenant-scoped M1 tables | 12 present |
| A9 | Delete a user who is still a member | **1451** rejected (RESTRICT) |
| A10 | Delete a user with only sessions | succeeds, sessions cascade |
| A11 | Duplicate `background_jobs.idempotency_key` | **1062** rejected |
| A12 | `DATETIME(3)` round-trip through Prisma | value returned equals value written (UTC, no 7 h shift) |
| A13 | `CHAR(36)` id round-trip | exact string preserved |
| A14 | Enum rejection: `users.status = 'NOPE'` | rejected (1265/1048) |
| A15 | App account: `CREATE TABLE` | denied **1142** |
| A16 | App account: `UPDATE audit_logs` | denied **1142** |
| A17 | App account: `DELETE FROM audit_logs` | denied **1142** |
| A18 | App account: `SELECT` from `mysql.user` | denied **1142** |
| A19 | Migrate account: read `affiliateos_shadow` | denied **1142** |
| A20 | Shadow account: read `affiliateos.users` | denied **1142** |
| A21 | `GET /api/health` with the app account | 200 `{"status":"ok","database":"up"}` |
| A22 | Audit write path inserts exactly one row per mutation | 1 row, actor + request id populated |
| A23 | `permissions` seed idempotency (if seeded in M1) | second run inserts 0 rows |

Tests A15–A20 require the accounts from §3; they cannot pass before provisioning.

---

## 12. Validation Results

| Check | Command | Result |
|---|---|---|
| Prisma validate | `npx prisma validate` | **exit 0** |
| Prisma generate | `npx prisma generate` | **exit 0** (380 ms) |
| Unit tests | `npm test` | **20 pass, 0 fail** (10 tenancy + 10 pool) |
| Typecheck (all workspaces) | `npm run typecheck` | **exit 0** |
| Database package build | via typecheck/build | **exit 0** |
| Next production build | `npm run build` | **exit 0** ("Compiled successfully in 715ms", `ƒ /api/health`) |
| Dev smoke (new health probe) | `next dev` on :3128 | **200** `{"status":"ok","database":"up"}`, ready in 2 s |
| Listener left behind | `ss` on 3126–3128 | **0** |
| Migration executed | — | **none** |

The build still requires `DATABASE_URL` (known F-6B-1); the existing `.env` supplied it.

---

## 13. Security Findings

| ID | Severity | Status | Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| F-6D-1 | High | **NEEDS APPROVAL** | One account holds 13 schema privileges on both schemas (DDL + DML) | Runtime compromise can drop tables; violates `docs/02` §2 item 8 | Provision `affiliateos_app` / `affiliateos_migrate` / `affiliateos_shadow` per `docs/10` §4 |
| F-6D-2 | High | **OPEN** | The only writer account holds `UPDATE`/`DELETE` on `affiliateos.*` | Audit trail is mutable; append-only would be a false claim | Table-level `SELECT, INSERT` on `audit_logs` (+ triggers) after M1 |
| F-6D-3 | High | **OPEN** | `SHADOW_DATABASE_URL` uses the same account as the runtime URL | Shadow operations can reach the app schema | Dedicated shadow account scoped to `affiliateos_shadow` |
| F-6D-4 | Medium | **CLOSED** | `index.ts` no longer exports `prisma`; health route uses `checkDatabaseHealth()`; 0 remaining package-level consumers; typecheck/build/dev pass | Web has no unscoped query surface | Keep `withTenant`/`systemDb` as the only future entries |
| F-6D-5 | Medium | **CLOSED** | `prisma.config.ts` used `DATABASE_URL` (runtime) for DDL | CLI would run as the runtime account | Now prefers `MIGRATE_DATABASE_URL`; fallback marked for deletion |
| F-6D-6 | Medium | **CLOSED** | No guard prevented identical runtime/migration accounts | Silent use of DDL credentials at runtime | `assertSeparateAccounts()` + 10 tests; errors name the variable, not the URL |
| F-6D-7 | Medium | **DEFERRED** | Trigger/grants need DDL | Immutability not enforced | Ship with M1 or immediately after provisioning |
| F-6D-8 | Low | **OPEN** | App account has `CREATE TEMPORARY TABLES`, `LOCK TABLES`, `CREATE VIEW`, `SHOW VIEW`, unused | Wider surface than needed | Drop them in the new grant set |
| F-6D-9 | Low | **OPEN** | `MIGRATE_DATABASE_URL` absent; fallback active | Separation not provisioned | Add after account creation; delete fallback branch |
| F-6D-10 | Low | **ACCEPTED WITH REASON** | `prisma validate` fails without `SHADOW_DATABASE_URL` even though it does not use it | CLI needs a shadow URL for read-only commands | Keep explicit failure; document in `docs/10` §6 |

---

## 14. Database Safety Evidence

| Check | Result |
|---|---|
| Tables in `affiliateos` / `affiliateos_shadow` | **0 / 0** |
| `CREATE USER` / `ALTER USER` / `GRANT` / `REVOKE` | not executed |
| `CREATE` / `ALTER` / `DROP` / `TRUNCATE` / DML | not executed |
| `CREATE DATABASE` / `ALTER DATABASE` | not executed |
| `migrate dev/deploy/reset`, `db push`, `db pull` | not executed |
| Statements run | `SELECT`, `SHOW GRANTS`, `information_schema` reads, `@@` variables |
| Other schemas touched | none (`mysql` never queried; read of `mysql.user` refused by privilege, so not attempted) |
| Privileges changed | none |
| Credentials changed | none |
| Temporary files | all removed (`/tmp/aos*` gone) |

`SHOW GRANTS` output was sanitized before display: the stored password hash was
replaced at capture time, and no password was printed at any point.

---

## 15. Git Status

| Item | Result |
|---|---|
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd` — unchanged |
| Staged | 0 |
| Commit / push / reset / stash / rebase | none |
| New in 6D | `packages/database/src/health.ts`, `packages/database/src/pool.test.ts`, `docs/10-DATABASE-SECURITY-SEPARATION.md`, this report |
| Modified in 6D | `packages/database/src/index.ts`, `src/client.ts`, `src/pool.ts`, `prisma.config.ts`, `apps/web/src/app/api/health/route.ts`, `.env.example`, `packages/database/package.json` (test script covers all `*.test.js`) |
| Pre-existing modification | `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` (preserved) |
| `.env` | untracked, mode `600`, untouched |

---

## 16. Limitations

1. **L-1** — No account separation exists yet; every statement about the target model
   is a design, not a verified configuration.
2. **L-2** — Audit immutability is unenforced; no grant or trigger exists.
3. **L-3** — `assertSeparateAccounts` has unit-test coverage but has never rejected a
   real startup, because the migration URL is absent.
4. **L-4** — No M1 acceptance test has run; there are no tables to test.
5. **L-5** — Composite FK enforcement and UTC round-trip remain unproven (carried
   from 6C).
6. **L-6** — Connection visibility is limited to this account (no `PROCESS`); the
   privilege was deliberately not requested.
7. **L-7** — `withTenant`/`systemDb` are still design-only; the package therefore
   exposes no query API beyond the health probe.

---

## 17. Recommendation

1. **Approve provisioning** of the three accounts (`docs/10` §4) as the first action,
   before M1, so the very first table is created by a DDL account and read by a DML
   account.
2. Immediately after M1: generate table-level grants, then run acceptance tests
   A2–A20, and only then describe audit logging as append-only (if the triggers were
   included) or as "grant-restricted" (if not).
3. Remove the `DATABASE_URL` fallback in `prisma.config.ts` once the split exists.
4. Keep M1 at 13 tables; do not bundle M2–M5.
5. Proceed to the Phase 1 authentication work only after A1–A23 pass on a scratch
   schema.

**CHECKPOINT 6D LOCKED.** No account created, no privilege changed, no migration, no
table, no commit, no push. Waiting for explicit approval.
