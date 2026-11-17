# PHASE 1 — CHECKPOINT 4 REPORT

## MariaDB Preparation & Access Verification

- **Date:** 2026-11-16
- **Role:** database administrator + senior backend engineer
- **Status:** **BLOCKED** — no administrative credential is available, so no database or
  account was created and **no connection was verified**
- **Deliverable:** this report, containing the full least-privilege design and the exact
  SQL an operator must run

Nothing in this checkpoint modified MariaDB, its configuration, its accounts, or its
data. No `sudo` was used. No password was guessed, reset, or displayed.

---

## 1. Kondisi MariaDB (read-only)

| Property | Evidence | Value |
|---|---|---|
| Service | `systemctl show mariadb -p ActiveState,SubState` | `active` / `running` |
| Unit | `FragmentPath` | `/usr/lib/systemd/system/mariadb.service` |
| Enabled | `systemctl is-enabled` | `enabled` |
| Main PID | `ExecMainPID` | `1071` |
| Listener | `ss -lntp` | `LISTEN 127.0.0.1:3306` only |
| TCP reachability | `/dev/tcp/127.0.0.1/3306` | connection succeeds (protocol level) |
| Server version | `mariadb --version` | **11.8.6-MariaDB**, client 15.2 |
| Socket | `--print-defaults`, `ls /run/mysqld` | `/run/mysqld/mysqld.sock` (`srwxrwxrwx`) |
| Bind address | `/etc/mysql/mariadb.conf.d/50-server.cnf` | `bind-address = 127.0.0.1` |
| `skip-networking` | config grep | **not set** (TCP is enabled) |
| Datadir | `ls -ld /var/lib/mysql` | `drwxr-xr-x mysql:mysql` (directory listing readable, contents not) |
| Auth plugin files present | `ls /usr/lib/mysql/plugin` | `auth_ed25519.so`, `auth_pam*.so`, `simple_password_check.so` |

Server is healthy, loopback-only, and matches the Phase 0 baseline. Nothing was
restarted or reconfigured.

---

## 2. Hasil Pemeriksaan Autentikasi

| Attempt | Result | Interpretation |
|---|---|---|
| `mariadb -u root -e "SELECT 1"` (socket) | `ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)` | The account is not reachable without a password from OS user `reksa`. Cannot determine whether it is password-based or absent — `mysql.user` is unreadable without privileges |
| `mariadb -u reksa -e "SELECT 1"` (socket) | `ERROR 1698 (28000): Access denied for user 'reksa'@'localhost'` | **1698** is the plugin-specific denial (no password supplied, plugin did not authenticate), not 1045. This strongly indicates an account `reksa`@`localhost` exists with a socket/PAM-style plugin that does **not** authorize the current session |
| `mariadb -h 127.0.0.1 -u root` | same `1045` | TCP path behaves identically; no anonymous/trust auth |
| `mariadb -h 127.0.0.1 -u reksa` | same `1698` | Same conclusion over TCP |
| `mysqladmin -u probe_nonexistent ping` | `ERROR 1045 ... 'probe_nonexistent'@'localhost'` | Confirms the server is up and that unknown users are rejected with 1045 (so the 1698 above is meaningful) |
| `$HOME/.my.cnf` | absent | No client credential profile |
| `mysql_config_editor` | command not found | No encrypted login-path store |
| DB credential env vars | `ENV_DB_VARS=0` | No `DATABASE_URL`/`MYSQL_*` in the environment |
| Project `.env*` | absent | No credential file in the repository |
| `sudo -n` | **not attempted** | Prohibited without operator approval; `reksa` is in group `sudo` but needs a password |
| `/etc/mysql/debian.cnf` | mode `-rw------- root` | Exists but unreadable; it is the Debian maintenance credential file. **Not read, not used** |

**Conclusion:** there is no usable administrative or application credential in this
session. Authentication was not bypassed, no password was guessed, and no
`--skip-grant-tables`-style workaround was attempted. Reaching the server requires an
operator action.

---

## 3. Database dan User yang Ditemukan

Existing schemas (from datadir directory names only — no table content was read):

| Schema | Note |
|---|---|
| `mysql` | system catalog |
| `performance_schema` | system |
| `sys` | system |
| `phpmyadmin` | pre-existing, not ours |
| `restaurant_app` | pre-existing, not ours |
| `solusisejalan` | pre-existing, not ours |
| `tinggalklik` | pre-existing, not ours |
| `tinggalklik_test` | pre-existing, not ours |

- Total: **8** schemas. `affiliateos` does **not** exist.
- Accounts: cannot be enumerated without `SELECT` on `mysql.user`. No account was
  created, altered, or dropped.
- **None of the pre-existing schemas or accounts will be touched.** They belong to
  other applications; AffiliateOS gets its own database and its own two accounts, with
  no privileges on anything else.

---

## 4. Rancangan Database AffiliateOS

| Property | Value | Reason |
|---|---|---|
| Application schema | `affiliateos` | One schema, owned by this project |
| Shadow schema | `affiliateos_shadow` | `prisma migrate dev` needs a disposable schema; pre-created by the operator so Prisma never needs `CREATE DATABASE` |
| Charset | `utf8mb4` | Matches `02-DATABASE-DESIGN.md` §1 |
| Collation | `utf8mb4_unicode_ci` | Explicit, per Phase 0 design. MariaDB 11.8 may default to `utf8mb4_uca1400_*`; being explicit prevents environment drift |
| Storage engine | InnoDB per table | Set in schema, not server config |
| Time zone | session UTC | All `DATETIME(3)` stored UTC |
| Test schema | **not created now** | Integration tests may use `affiliateos_test` later; deliberately out of scope so no unused schema exists |

`CREATE DATABASE` is the only DDL the operator runs; every table is created later by
Prisma migrations under the migration account.

---

## 5. Rancangan Privilege

Two accounts per host form (`localhost` for socket, `127.0.0.1` for TCP), distinct
passwords, both scoped to the two AffiliateOS schemas only.

### 5.1 Runtime — `affiliateos_app`

Purpose: the web app and worker at runtime.

| Privilege | On | Why |
|---|---|---|
| `SELECT` | `affiliateos.*` | reads |
| `INSERT` | `affiliateos.*` | writes, audit rows |
| `UPDATE` | `affiliateos.*` | writes |
| `DELETE` | `affiliateos.*` | deletion paths defined in the design (sessions, etc.) |
| **not granted** | — | `CREATE`, `ALTER`, `DROP`, `INDEX`, `REFERENCES`, `CREATE TEMPORARY TABLES`, `LOCK TABLES`, `TRIGGER`, `EVENT`, `EXECUTE`, `FILE`, `PROCESS`, `SUPER`, `GRANT OPTION`, any global privilege |

The app account must be unable to change schema. A migration that "accidentally" runs
at runtime will fail with `1142`, which is the desired outcome.

Phase 1 refinement (after the tables exist): revoke `UPDATE`/`DELETE` on `audit_logs`
so it is append-only at the grant level, not only by convention.

### 5.2 Migration — `affiliateos_migrate`

Purpose: Prisma CLI only (`migrate dev`, `migrate deploy`, `migrate status`).

| Privilege | On | Why |
|---|---|---|
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `affiliateos.*` | Prisma reads `_prisma_migrations` and writes seed data |
| `CREATE`, `ALTER`, `DROP`, `INDEX`, `REFERENCES` | `affiliateos.*` | DDL for tables, indexes, composite foreign keys |
| `CREATE TEMPORARY TABLES`, `LOCK TABLES` | `affiliateos.*` | required by parts of the migration engine |
| `CREATE VIEW`, `SHOW VIEW` | `affiliateos.*` | reserved for future views; harmless and schema-scoped |
| same DDL/DML set | `affiliateos_shadow.*` | shadow database for `migrate dev` |
| **not granted** | — | any privilege outside these two schemas, `GRANT OPTION`, `SUPER`, `FILE`, `PROCESS`, `CREATE USER`, `CREATE DATABASE` |

Prisma never gets `CREATE DATABASE`: the operator creates both schemas up front. The
migration account cannot touch other applications' schemas.

### 5.3 Why the split matters

- A compromised web process cannot drop tables or read other schemas.
- A migration mistake cannot be executed by the running application.
- `MIGRATE_DATABASE_URL` is only present in the migration job/developer shell, never
  in the web/worker runtime environment.

---

## 6. Perintah Provisioning (dijalankan operator)

**Not executed by the agent.** Run as an administrator with MariaDB privileges. Replace
the two placeholders with strong, distinct, randomly generated passwords; do not paste
them into chat, tickets, or Git.

```sql
-- 1. Schemas (explicit charset/collation per docs/02-DATABASE-DESIGN.md §1)
CREATE DATABASE `affiliateos`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE `affiliateos_shadow`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Accounts — loopback only (server already binds 127.0.0.1)
CREATE USER 'affiliateos_app'@'localhost' IDENTIFIED BY '<APP_PASSWORD>';
CREATE USER 'affiliateos_app'@'127.0.0.1' IDENTIFIED BY '<APP_PASSWORD>';
CREATE USER 'affiliateos_migrate'@'localhost' IDENTIFIED BY '<MIGRATE_PASSWORD>';
CREATE USER 'affiliateos_migrate'@'127.0.0.1' IDENTIFIED BY '<MIGRATE_PASSWORD>';

-- 3. Runtime privileges: DML only
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.* TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.* TO 'affiliateos_app'@'127.0.0.1';

-- 4. Migration privileges: DDL + DML on affiliateos and the shadow schema
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES,
      CREATE VIEW, SHOW VIEW
  ON `affiliateos`.* TO 'affiliateos_migrate'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES,
      CREATE VIEW, SHOW VIEW
  ON `affiliateos_shadow`.* TO 'affiliateos_migrate'@'127.0.0.1';

-- 5. Apply and verify (repeat the two GRANT blocks for the 127.0.0.1 variants;
--    shown once here for brevity — every account/host pair must be granted)
FLUSH PRIVILEGES;

SHOW GRANTS FOR 'affiliateos_app'@'localhost';
SHOW GRANTS FOR 'affiliateos_migrate'@'localhost';
```

Notes for the operator:

- If `simple_password_check` is loaded, the policy may reject short passwords; use a
  generated password of ≥16 characters with mixed classes.
- `localhost` and `127.0.0.1` are separate accounts in MariaDB. `skip-name-resolve` is
  not set on this server, so a TCP connection from `127.0.0.1` usually resolves to
  `localhost`; creating both pairs keeps behaviour identical if that ever changes.
- Do **not** grant `ALL PRIVILEGES`. Do not grant anything on `*.*`.
- Do not alter `root`, `reksa`, `phpmyadmin`, or any existing account.

### 6.1 Credential handover

Deliver credentials out-of-band (password manager or a file the operator creates with
mode `0600`). They belong in a local `.env` (git-ignored) shaped like:

```
DATABASE_URL=mysql://affiliateos_app:<url-encoded-app-password>@127.0.0.1:3306/affiliateos
MIGRATE_DATABASE_URL=mysql://affiliateos_migrate:<url-encoded-migrate-password>@127.0.0.1:3306/affiliateos
SHADOW_DATABASE_URL=mysql://affiliateos_migrate:<url-encoded-migrate-password>@127.0.0.1:3306/affiliateos_shadow
```

Special characters in passwords must be percent-encoded. These values must never be
committed; `.gitignore` already excludes `.env*`.

---

## 7. Prosedur Verifikasi

### 7.1 Grant inspection (admin, read-only)

```sql
SELECT User, Host, plugin FROM mysql.user WHERE User LIKE 'affiliateos%';
SHOW GRANTS FOR 'affiliateos_app'@'localhost';
SHOW GRANTS FOR 'affiliateos_migrate'@'localhost';
SHOW GRANTS FOR 'affiliateos_migrate'@'127.0.0.1';
```

Expected: exactly the grants listed in §5, nothing global.

### 7.2 Runtime account — positive and negative tests

```bash
# positive: connect and read
mariadb -h 127.0.0.1 -P 3306 -u affiliateos_app -p -D affiliateos -e "SELECT 1;"
```

```sql
-- negative: DDL must be denied (expect ERROR 1142)
CREATE TABLE _priv_probe (id INT);

-- negative: no access to another application's schema (expect ERROR 1044)
SELECT 1 FROM `tinggalklik`.mysql_upgrade_info;
```

`CREATE TABLE` here is a deliberate denial test; if it unexpectedly succeeds it must be
reported as a misconfiguration, and the table dropped by the migration account.

### 7.3 Migration account — DDL on the empty database only

```sql
CREATE TABLE `affiliateos`.`_priv_probe` (id INT PRIMARY KEY);
DROP TABLE `affiliateos`.`_priv_probe`;
```

Only on the empty `affiliateos` schema. Never on a pre-existing schema.

### 7.4 Prisma 7 connectivity (to run after provisioning)

Run in a throwaway directory **outside** the repository so no `package.json` enters the
project:

```bash
d=$(mktemp -d) && cd "$d"
npm init -y
npm install prisma@7.10.1 @prisma/client@7.10.1 @prisma/adapter-mariadb@7.10.1 mariadb@3.5.5
# write prisma/schema.prisma + prisma.config.ts exactly as in
# docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md §3
export DATABASE_URL='mysql://affiliateos_app:...@127.0.0.1:3306/affiliateos'
export MIGRATE_DATABASE_URL='mysql://affiliateos_migrate:...@127.0.0.1:3306/affiliateos'
export SHADOW_DATABASE_URL='mysql://affiliateos_migrate:...@127.0.0.1:3306/affiliateos_shadow'
npx prisma validate
npx prisma migrate deploy
node -e 'const {PrismaMariaDb}=require("@prisma/adapter-mariadb");
const {PrismaClient}=require("./src/generated/prisma/client.js");
const p=new PrismaClient({adapter:new PrismaMariaDb(process.env.DATABASE_URL)});
p.$queryRaw`SELECT VERSION() AS v, @@character_set_database AS cs, @@collation_database AS coll`
 .then(r=>{console.log(r);return p.$disconnect()})
 .catch(e=>{console.error(e);process.exit(1)})'
cd / && rm -rf "$d"
```

This is the step that converts "compile-only" Prisma 7 evidence into runtime evidence.
It remains **unexecuted**.

### 7.5 What was actually verified in this checkpoint

| Check | Executed | Result |
|---|---|---|
| Service active/enabled, PID, unit path | yes | active / running / enabled |
| Loopback-only listener | yes | `127.0.0.1:3306` |
| TCP reachability | yes | connect succeeds |
| Server/client version | yes | 11.8.6 / client 15.2 |
| Existing schema names | yes | 8 schemas, none AffiliateOS |
| Admin or app login | yes (4 attempts) | all denied; no bypass attempted |
| Database creation | **no** | blocked |
| User creation / grants | **no** | blocked |
| Application or Prisma connection | **no** | blocked |
| Migration execution | **no** | blocked |

---

## 8. Blocker Tersisa

| # | Blocker | Status after this checkpoint |
|---|---|---|
| **B1** | No MariaDB administrative credential; no application database or accounts | **OPEN — narrowed.** The requirement is fully specified: the exact schemas, accounts, grants, and verification steps exist in §4–§7. It now needs one operator action, not design work |
| B2 | Redis not installed | Open, unchanged |
| B3 | Docker not installed | Open, unchanged |
| B4 | No TikTok Partner Center app/credentials | Open, unchanged |
| B5 | Indonesia affiliate availability / quota rollout unconfirmed | Open, unchanged |
| B6 | No Git repository | **Resolved** in Checkpoint 3 (`main`, commit `5b5d061`) |
| B7 | No non-interactive sudo | Open — this is the direct cause of B1 remaining open |
| B8 | Prisma 7 config breaking change | Resolved in documentation (addendum) |
| B9 | npm 11 install-script policy | Decided, not implemented |
| B10 | Datasource env var required by every CLI call | Documented |
| B11 | `.env` loading strategy for `prisma.config.ts` | Open decision |
| **B12 (new)** | `reksa`@`localhost` exists with a plugin-based credential that does not authorize this OS session; `root` method unknown | **Open, low impact.** Do not reset or modify either account; the operator should use an existing admin path (`sudo mariadb`, or `/etc/mysql/debian.cnf`) |

---

## 9. Status

**BLOCKED.**

- Read-only inspection is complete and recorded: the server is healthy, listening only
  on loopback, and already hosts 8 schemas belonging to other applications.
- No administrative credential exists in this session, so the least-privilege design
  could not be applied. No database, account, grant, or schema was created or changed.
- No application or Prisma connection was attempted, so **no claim is made that
  Prisma 7.10.1 can talk to MariaDB 11.8.6** — that remains unverified (B1).
- No TikTok API access is claimed.

The blocking condition is an authorization boundary, not a technical unknown: the SQL
in §6 and the verification in §7 are ready to execute as-is.

### Yang dibutuhkan dari manusia

1. Run §6 as an administrator (or grant the agent an approved admin method).
2. Store the two generated passwords in a local `.env` (§6.1) — never in Git or chat.
3. Re-run this checkpoint's verification (§7.1–§7.4) before Phase 1 implementation
   begins; §7.4 is the one that finally validates the Prisma 7 + MariaDB adapter at
   runtime.

---

## 10. Kepatuhan

| Larangan | Status |
|---|---|
| Reset password root | Tidak dilakukan |
| Mengubah plugin autentikasi root | Tidak dilakukan |
| Menghapus database | Tidak dilakukan |
| Mengubah user yang ada | Tidak dilakukan |
| `ALL PRIVILEGES` sembarangan | Tidak diberikan; rancangan memakai daftar eksplisit dan schema-scoped |
| Menampilkan password/credential | Tidak ada credential yang ditemukan atau ditampilkan |
| Credential masuk Git | Tidak ada; `.env*` sudah di-ignore, working tree hanya berisi laporan Checkpoint 3 yang belum di-commit |
| `DROP` / `TRUNCATE` / operasi destruktif | Tidak dijalankan |
| `sudo` tanpa izin | Tidak dijalankan |
| Mengubah konfigurasi server MariaDB | Tidak dilakukan |
| Bypass autentikasi | Tidak dicoba (tanpa `--skip-grant-tables`, tanpa menebak password, tanpa membaca tabel sistem) |

No Git operation was performed in this checkpoint; this report is left untracked for a
future explicitly approved commit.
