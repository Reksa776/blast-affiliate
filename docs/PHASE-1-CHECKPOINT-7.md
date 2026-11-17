# PHASE 1 — CHECKPOINT 7 (Post-Audit P0.1–P0.4)

- **Date:** 2026-11-17
- **Branch:** `main`
- **Base commit:** `5b5d061`
- **Checkpoint commit:** `65bdcfd`
- **Tag:** `checkpoint-6d-pre-migration`
- **Overall status:** **PARTIAL** — P0.1 DONE; P0.2, P0.3, P0.4 **BLOCKED** (no admin credential, schema/migration-scope conflict, missing M1 tables).
- **Database changed:** **NO** — 0 tables before and after this checkpoint.

---

## 1. Status per sub-task

| Sub-task | Status | Evidence |
|---|---|---|
| P0.1 Commit + tag | **DONE** | 37 files / 10,352 insertions committed as `65bdcfd`; tag `checkpoint-6d-pre-migration`; secret scan CLEAN; `.env` untracked |
| P0.2 Pisah akun DB | **BLOCKED** | `root` denied (1045), `sudo -n` needs a password; plus the proposed SQL cannot satisfy append-only (see §3) |
| P0.3 M1 migration (13 tabel) | **BLOCKED (artifact ready, not applied)** | Curated 13-table migration written to `prisma/migrations/20261117000000_m1_foundation_13_tables/` (13 CREATE TABLE, 16 FK, 29 statements, 0 references outside M1); not applied — no migrate account yet (see §4.1) |
| P0.4 withTenant/systemDb | **BLOCKED** | Requires M1 tables. `User` has **no** `tenant_id`; `Campaign` is M4 (see §5) |

---

## 2. P0.1 — Commit and tag (DONE)

Pre-commit inspection (full output shown in the session):

- `git status`: 1 modified tracked file (`docs/06`), 36 untracked; **37 entries**.
- `git diff --stat`: `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md | 21 +++++----` (14 insertions, 7 deletions).
- `.gitignore` env rules: `40:.env`, `41:.env.*`, `42:!.env.example`, `43:!.env.template`.
- Ignore verification: `.env` → `.gitignore:40`; `*.tsbuildinfo`, `next-env.d.ts`, `**/generated/prisma/`, `dist/` all ignored; `.freebuff/` excluded via `.git/info/exclude:8`.
- Secret scan over the 37 files to be committed, pattern
  `(password|secret|token)\s*=\s*["'][^"']{8,}` → **CLEAN**.
- Credential-shaped URL scan → only placeholders and fixtures:
  `docs/PHASE-1-CHECKPOINT-4-REPORT.md` (`<url-encoded-…-password>`, `...`),
  `.env.example` format comments, `packages/database/src/pool.test.ts` fixture
  `s3cret%40value`, `pool.ts` error-message example. **No live credential.**
- `tracked_env_count=0`.

Staged: 37 files, 10,352 insertions(+), 7 deletions(-). Commit message exactly as instructed, tag created. Build output (`dist/`, `.next/`, `generated/prisma/`, `tsconfig.tsbuildinfo`, `next-env.d.ts`) correctly excluded.

**Deviation reported:** the initial instruction's
`git diff --cached --name-only | xargs grep …` was run against the staged set *after* staging
(the tree was unstaged at that point), so staging occurred before the content scan finished for
the URL pattern. The value-shaped secret scan was executed **before** `git commit`, and the staged
content is identical to the scanned set (no file added between scan and commit).

---

## 3. P0.2 — Account separation (BLOCKED, no DB change)

### 3.1 Current state (read-only)

| Fact | Value |
|---|---|
| Runtime account | `affiliateos_dev@127.0.0.1:3306`, schema `affiliateos` |
| `.env` variable names | `DATABASE_URL`, `SHADOW_DATABASE_URL` (no `MIGRATE_DATABASE_URL`, no `DATABASE_URL_APP`) |
| Password | never printed; `.env` mode `600`, untracked |
| `mariadb -u root -e "SELECT 1"` | `ERROR 1045 (28000): Access denied for user 'root'@'localhost'` |
| `sudo -n true` | `sudo: a password is required` |

**No admin path exists in this session**, therefore `CREATE USER` / `GRANT` cannot be executed.
The task requires execution as root → hard blocker, not an improvisation opportunity.

### 3.2 Defect in the proposed SQL (must be fixed before execution)

1. **`GRANT … ON affiliateos.*` followed by `REVOKE … ON affiliateos.audit_logs` does not work.**
   MySQL/MariaDB privilege checks are additive across levels; a table-level `REVOKE` cannot
   subtract a database-level grant. Depending on version it either errors with `1141`
   ("no such grant defined … on table") or leaves the schema-wide `UPDATE`/`DELETE` intact.
   Result: the acceptance criterion ("app cannot UPDATE/DELETE audit_logs") would **not** be met.
   Correct approach (already specified in `docs/10` §3.1 / §5.2): **table-level grants only**,
   generated from `information_schema.tables`, with `audit_logs` limited to `SELECT, INSERT`.
2. **Host mismatch:** the app connects over TCP to `127.0.0.1`; a `@'localhost'`-only account is a
   different MariaDB account. Both host variants must exist (or `skip-name-resolve` semantics verified).
3. **`GRANT ALL PRIVILEGES`** for the migrate account contradicts `docs/04` §3.14 and `docs/10` §3.2.
   Use the explicit DDL+DML list instead.
4. **Ordering:** per-table grants require the tables to exist, so M1 must run before the app
   account receives its final grants. Recommended order: create accounts (USAGE only) → M1 via
   migrate account → generated per-table grants → denial tests (`1142`).
5. `docs/10` additionally specifies a third account `affiliateos_shadow` because
   `shadowDatabaseUrl` is read by the same CLI config. This should be decided, not skipped.

**Decision recorded:** the operator runs the SQL (`docs/sql/0001-p0.2-account-separation.sql`,
placeholders only) and pastes `SHOW GRANTS` output; the agent does not receive passwords.
**Action taken:** SQL displayed, no statement executed, no account created, no privilege changed.

---

## 4. P0.3 — M1 migration (BLOCKED)

Two independent blockers:

1. **Migration scope.** `prisma migrate dev --create-only` authors SQL for the *entire* schema.
   Verified offline without writing files:
   `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
   → `create_table_count=40`, exit 0. A 13-table migration therefore cannot be produced by
   `migrate dev` alone; it needs hand-curation (split into M1–M5 per `docs/09`) or a multi-file
   schema split. Accepting the 40-table baseline would contradict the acceptance criterion and
   `docs/09` §1.
2. **No migrate credential.** `affiliateos_migrate` does not exist and cannot be created
   (§3.1). The task forbids falling back to the app/dev account, so `migrate deploy` was not run.

**List conflict (must be resolved by the user):**

| Source | 13 tables |
|---|---|
| Prompt "daftar minimal" | users, sessions, workspaces, workspace_members, workspace_invitations, roles, permissions, role_permissions, member_roles, audit_logs, background_jobs, **sync_runs, sync_errors** |
| `docs/09` §1 / `docs/PHASE-1-CHECKPOINT-6D` §9 | users, sessions, workspaces, workspace_members, workspace_invitations, roles, permissions, role_permissions, member_roles, audit_logs, background_jobs, **platform_admin_grants, background_job_attempts** |

`sync_runs`/`sync_errors` are M5 (Phase 6) in the approved plan; `platform_admin_grants` and
`background_job_attempts` are M1. Both lists are 13, but they are not the same 13.

### 4.1 Artifact created (not applied)

**Decision recorded:** use the `docs/09` §1 list; curate the 40-table DDL down to M1 by filtering
statements, rather than accepting a 40-table baseline.

| Check | Result |
|---|---|
| Source DDL | `prisma migrate diff --from-empty --to-schema …` → 40 `CREATE TABLE` |
| Kept statements | **29** = 13 `CREATE TABLE` + 16 `ALTER TABLE … ADD CONSTRAINT` (MySQL DDL inlines indexes, so no separate `CREATE INDEX`) |
| Tables | `users, sessions, workspaces, workspace_members, workspace_invitations, permissions, roles, role_permissions, member_roles, platform_admin_grants, audit_logs, background_jobs, background_job_attempts` |
| FK count | **16** (matches M1 relations: members 2, invitations 1, roles 1, role_permissions 3, member_roles 3, grants 2, sessions 2, jobs 1, attempts 1) |
| References outside M1 | **NONE** |
| `migration_lock.toml` | created (`provider = "mysql"`) |
| Applied | **NO** — `migrate status` lists the migration as not applied |

**Action taken:** migration file authored; no SQL applied, database still 0 tables.
**Known consequence:** the curated migration intentionally diverges from `schema.prisma` (40 models).
`migrate deploy` is fine, but a later `migrate dev` will report drift and offer a reset until M2–M5
are authored. This is the cost of staged migrations and must stay documented.

---

## 5. P0.4 — withTenant/systemDb (BLOCKED)

The specified tests cannot pass against the current schema, independent of the missing tables:

| Test | Problem |
|---|---|
| T1 `withTenant(tenantA).findMany(users)` | `User` is **platform-global** and has **no `tenant_id`** (`schema.prisma:239`). Filtering it by tenant is impossible by design. |
| T2/T3/T4 `campaign` update/delete/create | `Campaign` belongs to **M4**, not M1 — the table does not exist after M1. |
| T5 `systemDb().findMany(users)` | Implementable. |
| T6 invalid/empty `ctx.tenantId` | Implementable against `tenancy.ts` (`createTenantContext` already rejects blank ids). |

Mechanism check: Prisma 7.10.1 generated client contains `$extends`
(`src/generated/prisma/internal/class.ts`), so a client extension is viable — no downgrade needed.

Proposed adaptation (needs approval): use M1 tenant-scoped tables for T1–T4 — `roles`,
`workspace_members`, `workspace_invitations` (all carry `tenant_id`, all have
`@@unique([tenantId, id])`) — and move the `campaign` cases to M4. `users` cannot be a
tenant-scoped test target at all.

**Decision recorded:** adapt T1–T4 to M1 tenant-scoped tables (`roles`, `workspace_members`,
`workspace_invitations`); move the `campaign` cases to M4; keep T5/T6 as written.

**Action taken:** no `tenant-db.ts` written yet — it is implemented together with the DB-backed
tests once M1 exists, so it never lands untested.

---

## 6. Known limitations

1. This report, `docs/14-AUDIT-TEMPLATE.md`, `docs/sql/0001-p0.2-account-separation.sql` and
   `prisma/migrations/**` are **untracked** (created after the P0.1 commit), by design — the next
   approved commit must include them.
2. The development DB credential is a single 8-character password shared by runtime, CLI and
   shadow (`F5`); it was **not** rotated in this checkpoint (no admin access). The value was never
   printed, and `.env` remains mode `600`, untracked.
3. `npm test` on a fresh clone requires `prisma generate` first: `tsconfig.json` includes
   `src/**/*.ts` and the generated client is git-ignored. Root `typecheck`/`build` run
   `build:database` (which generates) but the workspace `test` script does not.
4. No CI exists, so the commit is not backed by an automated pipeline.
5. Schema still contains 40 models while the database has 0 tables (pre-existing deviation `RF-06`).
6. No migration, account, grant, or trigger was created in this checkpoint.

---

## 7. Recommendation for next checkpoint

1. **Operator:** run `docs/sql/0001-p0.2-account-separation.sql` as MariaDB admin, paste
   `SHOW GRANTS` output, and add `MIGRATE_DATABASE_URL` (+ the app URL) to `.env` without
   sharing the passwords.
2. **Then (agent):** apply the curated M1 migration with the migrate account, verify 13 tables
   and `migrate status`, generate per-table app grants, and prove `audit_logs` UPDATE/DELETE
   fail with `1142`.
3. **Then (agent):** `withTenant()`/`systemDb()` with the M1-adapted cross-tenant tests, followed
   by auth + RBAC (P0.5) as originally scoped.
