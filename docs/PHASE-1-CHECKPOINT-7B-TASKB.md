# Task B — Per-Table Grants for `affiliateos_app`

**Status: DONE** — grants applied by the operator from
`docs/sql/0002-p0.3-per-table-grants.sql` and verified by the agent against the
real database (see §Verification below).

The section order below is chronological: the runbook was generated while the
agent had no admin login (`sudo -n` → `sudo: a password is required`,
`mariadb -u root` → `ERROR 1045 (28000)`), so the grants were executed as an
operator action and the post-checks were run afterwards.

### Verification (after the operator applied the grants)

Executed as `affiliateos_app` over the app DSN — no root needed for this half:

```
SHOW GRANTS FOR CURRENT_USER()
  → GRANT USAGE ON *.*
  → GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`<table>` … (12 tables)
  → GRANT SELECT, INSERT ON `affiliateos`.`audit_logs`
  → no `ON affiliateos.*` line anywhere

SELECT COUNT(*) FROM roles                     → OK (query succeeded)
INSERT INTO audit_logs (…, actor_type, …)      → OK (row written, then removed)
UPDATE audit_logs SET action='hacked' …        → ERROR 1142 UPDATE denied
DELETE FROM audit_logs WHERE …                 → ERROR 1142 DELETE denied
CREATE TABLE `_probe` (id INT)                 → ERROR 1142 CREATE denied
```

The app therefore cannot mutate or drop the audit trail and cannot run DDL,
while `affiliateos_migrate` still holds exactly its 3 grant lines.

Housekeeping: the probe above inserted one `audit_logs` row
(`action='taskC_probe'`) because the probe's `JSON.stringify` failed on the
driver's BigInt count and masked the success. It was deleted through the migrate
account and `SELECT COUNT(*) FROM audit_logs` is **0**.

Date: 2026-11-17 · Prisma 7.10.1 · MariaDB 11.8.6

## Pre-flight evidence (Langkah 1)

Verified through `affiliateos_migrate` (read-only catalog access), because
`SHOW GRANTS FOR 'affiliateos_app'@…` requires privileges on `mysql.*`:

| Check | Expected | Actual |
|---|---|---|
| Base tables in `affiliateos` | 14 | **14** ✅ |
| FK constraints | 16 | **16** ✅ |
| Migration recorded as applied | 1 row, not rolled back | `20261117000000_m1_foundation_13_tables`, `finished_at=2026-11-16T20:15:28.021Z`, `rolled_back_at=null` ✅ |
| `migrate` grants | 3 lines, unchanged | 3 lines: `USAGE ON *.*`, `… ON affiliateos.*`, `… ON affiliateos_shadow.*` ✅ |
| `app` grants on `affiliateos` | `USAGE` only | **none** — the app cannot even open the schema: `ERROR 1044 (42000) Access denied for user 'affiliateos_app'@'localhost' to database 'affiliateos'` ✅ (pre-grant state) |
| `ON affiliateos.*` for app | must not exist | does not exist (1044 proves absence of any schema-level privilege) ✅ |

```
--- M1 table count        [{"c":"14"}]
--- FK count              [{"c":"16"}]
--- applied migrations    [{"migration_name":"20261117000000_m1_foundation_13_tables",
                            "finished_at":"2026-11-16T20:15:28.021Z",
                            "rolled_back_at":null,"applied_steps_count":1}]
--- app connect           ERROR 1044 ER_DBACCESS_DENIED_ERROR:
                          Access denied for user 'affiliateos_app'@'localhost' to database 'affiliateos'
```

## Grant Summary (generated from the live catalog, not hand-written)

- 12 business tables (all except `audit_logs`): `SELECT, INSERT, UPDATE, DELETE`
- `audit_logs`: `SELECT, INSERT` only
- `_prisma_migrations`: no grant (Prisma-internal; the migrate account owns it)
- `affiliateos_migrate`: untouched
- No statement uses `ON affiliateos.*`

Generator output (`table_name NOT IN ('audit_logs','_prisma_migrations')`, 12 rows):

```
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_jobs` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_job_attempts` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`member_roles` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`permissions` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`platform_admin_grants` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`role_permissions` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`roles` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`sessions` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`users` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspaces` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_invitations` TO 'affiliateos_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_members` TO 'affiliateos_app'@'127.0.0.1';
```

`docs/sql/0002-p0.3-per-table-grants.sql` holds both host blocks (the
`@'localhost'` block is active, the `@'127.0.0.1'` block is commented out — see
red flag 2), the post-check, the denial tests, and the rollback.

## Red flags found in the task prompt / assumptions

1. **The test INSERT in the prompt does not match this schema.** It lists
   `user_id` (column does not exist; the column is `actor_user_id`) and omits
   `actor_type`, which is `enum('USER','WORKER','SYSTEM','SUPER_ADMIN') NOT NULL`.
   That statement would fail with `1054 Unknown column` / `1364 Field 'actor_type'
   doesn't have a default value` — which the prompt's own red-flag list would
   misread as "grant problem". Corrected statement:
   `INSERT INTO audit_logs (id, tenant_id, actor_type, action, resource_type, resource_id) VALUES (UUID(), NULL, 'SYSTEM', 'taskB_probe', 'test', 'test_id');`
2. **`GRANT` to a non-existent host creates a passwordless account.** MariaDB
   auto-creates the account with an empty password when granting to an unknown
   `user@host`. Granting the `@'127.0.0.1'` block blindly could create
   `affiliateos_app@127.0.0.1` with no password. The block is therefore
   commented out behind a pre-flight check (`SELECT user, host FROM mysql.user`).
3. **The operative host is `@localhost`, not `@127.0.0.1`.** The app DSN connects
   to `host=127.0.0.1`, yet the server reports the session as
   `affiliateos_app@localhost` (same for `affiliateos_migrate@localhost`). Granting
   only `@'127.0.0.1'` — the block the prompt writes out in full — would leave the
   app with **zero** rights. Pre-flight must decide block B, not the prompt.
4. **Root is unreachable from the agent** (1045 / sudo password), so steps 3–4 of
   the prompt cannot be executed here. They are operator actions.

## What is NOT verified (no claim of PASS)

- `SHOW GRANTS FOR 'affiliateos_app'@…` as admin — never executed (needs root).
- `UPDATE`/`DELETE audit_logs` → `1142` — not executed; the app cannot connect to
  the schema at all yet (`1044`).
- `INSERT audit_logs` success — not executed.
- No probe row was written; the cleanup step was unnecessary (and its connection
  had already been closed, reporting `45013` — cosmetic, no data effect).

## Known limitations

- `_prisma_migrations` is not granted; any runtime code that used the app DSN to
  run `prisma migrate` would fail. Intended: migrate uses `MIGRATE_DATABASE_URL`.
- Both host blocks are needed only because host resolution differs; if the
  pre-flight shows a single `@localhost` row, block B stays commented out.
- New tables later (M2–M5) will be invisible to the app until granted — by design
  (fail-closed), but it means every migration needs a grant step.

## Task C — Status: DONE

`withTenant()` / `systemDb()` implemented and covered by 8 integration tests
against this database.

- New files: `packages/database/src/tenant-db.ts`, `packages/database/src/tenant-db.test.ts`
- Exported from `packages/database/src/index.ts`
- `npm test`: **28 pass, 0 fail, 0 skipped** (exit 0) — 20 previous + 8 new
- `npm run typecheck`: **exit 0**
- Post-run residue check: `roles=0, workspaces=0, workspace_members=0,
  audit_logs=0, background_jobs=0`

Details, deviations and limitations: `docs/PHASE-1-CHECKPOINT-7B-TASKC.md`.

## Next

1. Task D / P0.5 (auth) — blocked until the user approves this diff.
2. M2–M5 tables will need their own per-table grants; the runbook's generator
   query is the command to re-run for each migration.
