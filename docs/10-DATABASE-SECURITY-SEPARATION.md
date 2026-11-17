# 10 — DATABASE SECURITY SEPARATION

> Checkpoint 6D deliverable. **Design only for everything that needs a new account,
> a grant, or a trigger.** Nothing in §4–§7 has been executed: no `CREATE USER`, no
> `GRANT`, no `CREATE TRIGGER`, no migration.
>
> What *was* implemented (no database write): `prisma.config.ts` now prefers
> `MIGRATE_DATABASE_URL`, and the runtime refuses to start if the runtime and
> migration URLs name the same account (§8).

---

## 1. Current State (measured, read-only)

| Fact | Value |
|---|---|
| Account used by runtime, Prisma CLI, and shadow | `affiliateos_dev@127.0.0.1` — **one account for all three roles** |
| Global privileges | `USAGE` only (no `SUPER`, `PROCESS`, `FILE`, `GRANT OPTION`) |
| Schema privileges on `affiliateos` | `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW` |
| Schema privileges on `affiliateos_shadow` | identical |
| Table-level grants | 0 rows |
| Tables | 0 |
| `.env` permissions | `600`, two variables: `DATABASE_URL`, `SHADOW_DATABASE_URL` |
| `MIGRATE_DATABASE_URL` | absent |

Consequence: the application credential can `DROP` every table it can read, and can
`UPDATE`/`DELETE` audit rows. **Audit logging is therefore not append-only today**;
that claim would be false. This is finding F-6D-1/F-6D-2.

---

## 2. Target Account Model

| Account | Used by | Scope | Never used by |
|---|---|---|---|
| `affiliateos_app` | web, worker, DB-backed tests | DML on `affiliateos` only | Prisma CLI, migrations |
| `affiliateos_migrate` | Prisma CLI (`migrate dev/deploy`) | DDL + DML on `affiliateos` only | web, worker, tests |
| `affiliateos_shadow` | Prisma CLI shadow URL only | full rights on `affiliateos_shadow` only | anything in production |

Why a third account: `shadowDatabaseUrl` is read by the same config as the migration
URL. If the migration account also owns the shadow schema, a mistake in migration
ordering can drop objects in the app schema. Giving the shadow URL its own account,
scoped to `affiliateos_shadow`, makes "shadow cannot touch the app schema" a grant
fact rather than a convention. The checkpoint asked for two accounts; the third is
the minimum that satisfies its own shadow-isolation requirement.

No account gets rights on `mysql`, on other applications' schemas, or `GRANT OPTION`.

---

## 3. Minimum Privileges

### 3.1 `affiliateos_app` — runtime

| Object | Privileges | Why |
|---|---|---|
| each business table (all except `audit_logs`) | `SELECT, INSERT, UPDATE, DELETE` | Normal CRUD |
| `audit_logs` | `SELECT, INSERT` **only** | Append-only from the app's perspective |
| everything else | none | No DDL, no other schema |

MySQL/MariaDB has no `DENY`: a schema-wide `GRANT … ON affiliateos.*` would re-grant
`UPDATE`/`DELETE` on `audit_logs`. Table-level grants are therefore mandatory, not
stylistic. The cost is that every new table needs a grant (fail-closed), which is the
correct failure direction.

Not granted: `CREATE`, `DROP`, `ALTER`, `INDEX`, `REFERENCES`, `CREATE TEMPORARY
TABLES`, `LOCK TABLES`, `CREATE VIEW`, `SHOW VIEW`, `PROCESS`, `FILE`, `SUPER`,
`GRANT OPTION`.

### 3.2 `affiliateos_migrate` — Prisma CLI

| Privilege | Why |
|---|---|
| `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES` on `affiliateos` | Prisma creates `_prisma_migrations`, then DDL, and must read/update that table |
| `LOCK TABLES` | optional; add only if a migration actually needs it |

Not granted: anything on `affiliateos_shadow` (that is the third account), other
schemas, `PROCESS`, `FILE`, `SUPER`, `GRANT OPTION`, `CREATE USER`.

`CREATE VIEW` / `SHOW VIEW` are dropped from the current set: the schema defines no
views, and a view would be a second access path around the tenant rules.

### 3.3 `affiliateos_shadow` — shadow database only

`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES` on
`affiliateos_shadow` and nothing else. Prisma drops and recreates objects there on
every `migrate dev`.

### 3.4 Optional: `affiliateos_monitor`

`SELECT` only on `audit_logs` and a few counters, if an operator wants a read-only
dashboard. Not required for M1.

---

## 4. Proposed GRANT Statements — **NOT EXECUTED**

> All passwords are placeholders. Generate them locally, store them only in `.env`
> (mode 600), never in Git, never in a ticket.

```sql
-- DRAFT ONLY — NOT EXECUTED — REQUIRES OPERATOR APPROVAL
CREATE USER 'affiliateos_app'@'127.0.0.1'      IDENTIFIED BY '<generated>';
CREATE USER 'affiliateos_migrate'@'127.0.0.1'  IDENTIFIED BY '<generated>';
CREATE USER 'affiliateos_shadow'@'127.0.0.1'   IDENTIFIED BY '<generated>';

-- Runtime: table-level DML, generated from the catalog so no table is forgotten.
SELECT CONCAT(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`', table_name,
  '` TO ''affiliateos_app''@''127.0.0.1'';')
FROM information_schema.tables
WHERE table_schema = 'affiliateos' AND table_type = 'BASE TABLE'
  AND table_name <> 'audit_logs';

GRANT SELECT, INSERT ON `affiliateos`.`audit_logs` TO 'affiliateos_app'@'127.0.0.1';
FLUSH PRIVILEGES;

-- Migration: DDL on the app schema only.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos`.* TO 'affiliateos_migrate'@'127.0.0.1';

-- Shadow: only the shadow schema.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos_shadow`.* TO 'affiliateos_shadow'@'127.0.0.1';
```

The first statement is a **generator**, not a grant: it prints the table-level grants
to be reviewed and executed. Re-run it after every migration that adds a table.

---

## 5. Audit Log Immutability

### 5.1 Current state

`audit_logs` does not exist yet, and the account that will write it holds
`UPDATE`/`DELETE` on `affiliateos.*`. So: **not append-only, and it must not be
described as such.**

### 5.2 Target: grants (primary control)

`GRANT SELECT, INSERT ON affiliateos.audit_logs` only. Then:

| Actor | INSERT | SELECT | UPDATE | DELETE |
|---|---|---|---|---|
| app | ✓ | ✓ | ✗ (1142) | ✗ (1142) |
| migrate | ✓ | ✓ | ✓ (maintenance only) | ✓ (maintenance only) |

Any accidental `prisma.auditLog.update(...)` fails at the server.

### 5.3 Target: triggers (defence in depth)

Grants can drift when a new table is added or a schema-wide grant is pasted in.
Two triggers make the intent explicit and account-independent:

```sql
-- DRAFT ONLY — NOT EXECUTED — REQUIRES APPROVAL
CREATE TRIGGER audit_logs_block_update BEFORE UPDATE ON audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER audit_logs_block_delete BEFORE DELETE ON audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
```

Prisma cannot model triggers, so they must be added as hand-written SQL inside a
migration created with `--create-only`. That is a deliberate exception to "schema is
the source of truth" and needs review. Retention is the trade-off: a purge requires
dropping and recreating the triggers inside a maintenance window, performed by the
migration account and itself audited.

Recommendation: **grants for M1**, triggers in the same migration if review accepts
the operational cost. Do not claim immutable until one of the two is active.

### 5.4 Does the runtime support it?

Yes, with one repository rule:

- Writes go through `writeAuditLog()` → `create` (INSERT). Compatible.
- Reads go through `listAuditLogs()` → `findMany` (SELECT). Compatible.
- No code path may call `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, or
  `$executeRaw` against `audit_logs`. Enforced by review + the grants themselves.
- `audit_logs` has no foreign keys, so no cascade can ever demand `DELETE` on it —
  the reason the model was designed that way in 6C.

---

## 6. Environment Separation

| Process | `DATABASE_URL` | `MIGRATE_DATABASE_URL` | `SHADOW_DATABASE_URL` |
|---|---|---|---|
| web | `affiliateos_app` | **unset** | unset |
| worker | `affiliateos_app` | **unset** | unset |
| Prisma CLI (authoring) | unset | `affiliateos_migrate` | `affiliateos_shadow` |
| migration job (CI/prod) | unset | `affiliateos_migrate` | n/a |
| DB-backed tests | `affiliateos_app` on a scratch schema | n/a | n/a |

Rules:

1. Only the CLI reads `MIGRATE_DATABASE_URL`. `prisma.config.ts` prefers it and
   falls back to `DATABASE_URL` **only** while the split is not provisioned.
2. The runtime refuses to start if both variables name the same account
   (`assertSeparateAccounts`, implemented).
3. The shadow URL always targets `affiliateos_shadow` — verified in 6D: the path is
   `affiliateos_shadow`, host and port match the runtime host.
4. `.env` stays mode 600; `.env.example` contains names only.
5. No URL is logged. Errors name the variable, never the value.
6. Production injects secrets from the environment/secret store, never from a file in
   the image.

---

## 7. Provisioning Runbook — **NOT EXECUTED**

Requires a MariaDB login with `CREATE USER`/`GRANT` (socket/`root`), i.e. an
operator action. Writing the password to disk is the only file change.

1. Generate three independent passwords (e.g. `openssl rand -base64 32`), URL-encode
   them for the URL form (`@` → `%40`, `:` → `%3A`, `/` → `%2F`).
2. As the privileged account, run §4 (after review), using the real passwords.
3. Put the three URLs into `.env` (600):
   - `DATABASE_URL` → `affiliateos_app` on `affiliateos`
   - `MIGRATE_DATABASE_URL` → `affiliateos_migrate` on `affiliateos`
   - `SHADOW_DATABASE_URL` → `affiliateos_shadow` on `affiliateos_shadow`
4. Verify (expected results):
   - `SHOW GRANTS` for app: table-level DML, `audit_logs` INSERT/SELECT only.
   - app: `CREATE TABLE x (id INT)` → **denied 1142**.
   - app: `UPDATE audit_logs SET action='x'` → **denied 1142**.
   - migrate: `SELECT` on `affiliateos_shadow` → **denied 1142**.
   - shadow: `SELECT` on `affiliateos.users` → **denied 1142**.
   - app: `SELECT` from `mysql.user` → **denied 1142**.
5. Remove the transitional fallback comment in `prisma.config.ts` and delete the
   `DATABASE_URL` fallback branch, then re-run `prisma validate`.
6. Re-run §4's generator after every migration that adds a table.

Rollback: `REVOKE ALL` for the three accounts, `DROP USER`, restore `.env` from the
pre-change copy. Requires the same approval.

---

## 8. Implemented in 6D (no database change)

| Change | File | Effect |
|---|---|---|
| Migration URL preference | `packages/database/prisma.config.ts` | Uses `MIGRATE_DATABASE_URL` when present; documented fallback otherwise |
| Account collision guard | `packages/database/src/pool.ts` + `client.ts` | Runtime throws if `DATABASE_URL` and `MIGRATE_DATABASE_URL` share `user@host:port` |
| Tests for the guard | `packages/database/src/pool.test.ts` | 10 tests (parsing, defaults, collision) |
| Env template | `.env.example` | `MIGRATE_DATABASE_URL` name added, no value |

The guard is a no-op today because `MIGRATE_DATABASE_URL` is absent — that is
intentional and stated, not silently skipped.

---

## 9. What Remains Blocked

1. Creating the three accounts (needs operator privileges + approval).
2. Table-level grants (no tables exist yet; must follow M1).
3. Triggers (need DDL, i.e. the M1 migration window).
4. Removing the fallback in `prisma.config.ts` (needs the split to exist).
5. Any claim that audit logging is append-only.
