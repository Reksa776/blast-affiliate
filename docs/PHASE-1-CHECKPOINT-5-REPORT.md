# AffiliateOS — Phase 1 Checkpoint 5 Report
## Database Connection Verification

**Date:** 2026-11-16
**Status:** **PASS WITH LIMITATIONS** — database connectivity and least-privilege scoping are proven for both schemas; Prisma 7.10.1 remains unverifiable because the repository still has no Prisma project.
**Supersedes:** v1 of this report (status `BLOCKED`, `root` credential in `.env`).

---

## 0. Document history

| Version | Verdict | Reason |
|---|---|---|
| v1 | **BLOCKED** | `.env` authenticated as `root`; no Prisma project existed. Verification deliberately not attempted. |
| **v2 (this)** | **PASS WITH LIMITATIONS** | Operator provisioned `affiliateos_dev`, both schemas exist, both URLs connect, privileges are schema-scoped and denial-tested. Prisma half still not executable. |

What changed between versions: user moved from `root` to `affiliateos_dev@127.0.0.1`; `SHADOW_DATABASE_URL` was added; `.env` permissions tightened from `664` to `600`. Findings F1 (root credential) and F4 (missing shadow URL) are **closed**. F2 (no Prisma project) persists. Two new findings are recorded: F7 (collation mismatch) and F5 re-confirmed (short password).

---

## 1. Connection verification — both databases

Credentials were consumed directly from `.env`; the password was passed to the client through the process environment (`MYSQL_PWD`) and never appeared on a command line, in `ps`, or in this report. No credential was requested from the operator.

### 1.1 Identity and target

| Evidence | `DATABASE_URL` → `affiliateos` | `SHADOW_DATABASE_URL` → `affiliateos_shadow` |
|---|---|---|
| Exit code | 0 | 0 |
| `SELECT VERSION()` | `11.8.6-MariaDB-0+deb13u1 from Debian` | `11.8.6-MariaDB-0+deb13u1 from Debian` |
| `SELECT DATABASE()` | `affiliateos` | `affiliateos_shadow` |
| `CURRENT_USER()` | `affiliateos_dev@127.0.0.1` | `affiliateos_dev@127.0.0.1` |
| `SESSION_USER()` | `affiliateos_dev@127.0.0.1` | `affiliateos_dev@127.0.0.1` |
| Tables in schema | **0** | **0** |
| Views in schema | **0** | **0** |

`CURRENT_USER()` is the authoritative answer to "which account am I?" and it matches the intended account on both URLs. `DATABASE()` matches the intended schema on both. Server version matches the pinned expectation in `docs/06` §5 (`11.8.6`). Both schemas are empty, confirming nothing was created ahead of the schema work.

These results independently reproduce the operator's manual evidence, with the difference that they were derived from `.env` rather than from an operator-supplied session.

### 1.2 Observation — schema defaults

| Schema | Default charset | Default collation |
|---|---|---|
| `affiliateos` | `utf8mb4` | **`utf8mb4_uca1400_ai_ci`** |
| `affiliateos_shadow` | `utf8mb4` | **`utf8mb4_unicode_ci`** |

The two schemas disagree. `uca1400` is MariaDB 11.8's server default; `utf8mb4_unicode_ci` is what the Checkpoint 4 design specified. Consequences are recorded as **F7** in §8. This is a schema-option defect, not a connection defect — it did not affect any test above.

---

## 2. Environment configuration audit

### 2.1 `.env`

| Property | Value | Assessment |
|---|---|---|
| Permissions | `600` `reksa:reksa` | **Fixed since v1** (`664`); owner-only read/write |
| Variables | `DATABASE_URL`, `SHADOW_DATABASE_URL` | Both present, as the design requires |
| Line count | 2, terminating newline present | Clean; no CRLF, no NUL bytes |
| `DATABASE_URL` | `mysql://` · `127.0.0.1` · `3306` · user `affiliateos_dev` · db `affiliateos` | Correct |
| `SHADOW_DATABASE_URL` | `mysql://` · `127.0.0.1` · `3306` · user `affiliateos_dev` · db `affiliateos_shadow` | Correct |
| Query parameters | none on either URL | No hidden `ssl`, `socket`, or `connection_limit` overrides |
| Password | 8 characters, no percent-encoding needed | `pwLen=8`; no reserved characters, so no encoding risk (see F5) |
| Same credential on both URLs | **yes** | Consistent with the operator's single-account development decision |
| Distinct databases | **yes** | App and shadow targets are separate schemas |

No `MIGRATE_DATABASE_URL` — correct for the chosen single-account approach, provided `prisma.config.ts` resolves `DATABASE_URL` for the CLI (§5.3).

### 2.2 Git exposure

| Check | Result |
|---|---|
| `git check-ignore -v .env` | `.gitignore:40:.env` → ignored |
| Env files tracked | **0** |
| Secret regex over `git ls-files` | 0 hits |
| `git status` | clean except three untracked checkpoint reports (3, 4, 5) |

`.env` cannot be committed under the current rules.

---

## 3. Privilege verification

### 3.1 Effective grants (from the account's own session)

`SHOW GRANTS FOR CURRENT_USER()` returns exactly three lines — two privilege-bearing, one structural:

```
GRANT USAGE ON *.* TO `affiliateos_dev`@`127.0.0.1` IDENTIFIED BY PASSWORD '<hash>'
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW
      ON `affiliateos`.*        TO `affiliateos_dev`@`127.0.0.1`
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, CREATE VIEW, SHOW VIEW
      ON `affiliateos_shadow`.* TO `affiliateos_dev`@`127.0.0.1`
```

The `IDENTIFIED BY PASSWORD` hash is deliberately truncated here; the real value is a credential derivative and is excluded from this report. It is not a secret in the sense of a usable password (it is a one-way hash), but there is no reason to publish it.

**On `GRANT USAGE ON *.*`:** this is not a privilege. MariaDB writes `USAGE ON *.*` for every account so the account can exist and authenticate; it grants nothing. The distinction matters because it is the exact string that a naive audit flags as "global grant".

Cross-checked through `information_schema`, which the account can query:

| Query | Result |
|---|---|
| `SCHEMA_PRIVILEGES` rows for `affiliateos_dev` | **26** = 13 privileges × 2 schemas — matches the two GRANT lines exactly |
| `USER_PRIVILEGES` rows other than `USAGE` | **0** — no global privilege of any kind |

So: **no `ALL PRIVILEGES ON *.*`, no global DDL, no `GRANT OPTION`, no `CREATE DATABASE`.** Confirms the operator's statement independently.

### 3.2 Denial tests (the ceiling, not just the floor)

`USE <schema>` requires at least one privilege on that schema, so it is a clean, data-free probe:

| Probe | Result |
|---|---|
| `USE tinggalklik` | `ERROR 1044 (42000) … Access denied … to database 'tinggalklik'` |
| `USE restaurant_app` | `ERROR 1044 (42000) … Access denied` |
| `USE phpmyadmin` | `ERROR 1044 (42000) … Access denied` |
| `USE solusisejalan` | `ERROR 1044 (42000) … Access denied` |
| `SHOW TABLES FROM tinggalklik` / `restaurant_app` / `phpmyadmin` / `solusisejalan` | all `ERROR 1044` |

`information_schema.SCHEMATA` confirms the same from the other direction — the account sees exactly three schemas:

```
affiliateos   affiliateos_shadow   information_schema
```

The other eight schemas present on the server (`mysql`, `performance_schema`, `sys`, plus the four other applications) are invisible. **Requirement 7 is satisfied by observation, not by assertion.**

### 3.3 Fit for purpose

| Capability | Needed | Held | Note |
|---|---|---|---|
| DML (`SELECT/INSERT/UPDATE/DELETE`) | yes | yes | Runtime queries |
| DDL (`CREATE/ALTER/DROP/INDEX/REFERENCES`) | yes (migrations) | yes | Scoped to the two schemas only |
| `CREATE TEMPORARY TABLES`, `LOCK TABLES` | yes (Prisma migrate) | yes | — |
| `CREATE VIEW`, `SHOW VIEW` | yes (future views) | yes | — |
| `CREATE DATABASE` / global | **no** | **no** | ✅ correct: `prisma migrate dev` must therefore never be asked to create its shadow DB |

The last row is why `SHADOW_DATABASE_URL` pointing at a **pre-created** schema is the right design rather than a workaround: the account has enough rights to rebuild tables *inside* `affiliateos_shadow`, but not to create a database. This is the intended least-privilege shape.

---

## 4. Security audit

| Rule | Status | Evidence |
|---|---|---|
| No `root` | **PASS** | `CURRENT_USER()` = `affiliateos_dev@127.0.0.1` on both URLs; no root session opened at any point |
| No password changes | **PASS** | No `ALTER USER` / `SET PASSWORD` issued |
| No account creation/deletion | **PASS** | No `CREATE USER` / `DROP USER` issued |
| No privilege changes | **PASS** | No `GRANT` / `REVOKE` issued |
| No access to other application databases | **PASS** | 8 denial probes, all `ERROR 1044`; those schemas are not even visible |
| No tables created | **PASS** | `information_schema.TABLES` = 0 in both schemas, before and after all testing |
| No migrations / DDL | **PASS** | No `CREATE`/`ALTER`/`DROP` executed; no `prisma migrate*` (nothing to run it with) |
| No secrets in output or report | **PASS** | Password never materialised in a shell argument; report contains only placeholders — verified by automated scan against the live value |
| No git commit / push | **PASS** | HEAD `5b5d061`, 1 commit, no remote |
| No Phase 0 document edits | **PASS** | No tracked file modified (`git diff HEAD -- docs` empty) |
| No scaffolding or dependency install | **PASS** | `package.json`, `node_modules`, `prisma/`, `src/` all still absent |

### 4.1 Residual risks (not violations)

1. **Password strength.** 8 characters. Checkpoint 4 recommended ≥16 with mixed classes; the account's hash is unsalted-MD5-style (`mysql_native_password`), which is weak against offline attack *if* the `mysql.user` table ever leaks. For a loopback-only development account on a single-user machine this is a low, accepted risk — but it must not survive into production, and the password should not be reused anywhere.
2. **Traffic is unencrypted.** The client warns that `--ssl-verify-server-cert` is disabled. Both endpoints are on loopback, which matches the design decision in `docs/06` §5 ("TLS not used on loopback"). No action needed locally; production must not inherit this.
3. **Same credential for runtime and migrations.** Accepted trade-off for development (§2.1). It means a runtime bug is capable of `DROP TABLE`. Production keeps the two-account split from Checkpoint 4.
4. **`.env` holds a live credential on disk.** Correct by design (mode 600, git-ignored), but it is a plaintext secret on the workstation; disk-level protection is the remaining control.

---

## 5. Prisma compatibility status

### 5.1 Actual state — re-checked, unchanged

| Item | State |
|---|---|
| `package.json` | **absent** |
| `package-lock.json` | **absent** |
| `node_modules/` | **absent** |
| `prisma.config.ts` | **absent** |
| `prisma/` (schema, migrations) | **absent** |
| `src/` | **absent** |
| `tsconfig.json` | **absent** |

Repository contains only `docs/`, `.git/`, `.gitignore`, `.env`. **No Prisma command was run and no Prisma claim is made.** The only Prisma evidence in this project's history is the Checkpoint 1 spike, executed in `/tmp/affiliateos-spike.L6q6Lx` (since deleted), which proved the 7.10.1 config API and `generate` work on this machine — not that this repository can connect, and never with the adapter against a live server.

Per the operator's instruction, no scaffolding or dependency install was performed to close this gap. Installing ~180 packages plus a schema would be Checkpoint 6 work, and a report claiming "Prisma PASS" without an executed `$queryRaw` would be false.

### 5.2 What is nevertheless now proven about the Prisma path

The *database half* of Prisma's requirements is satisfied, which is the part Checkpoint 5 was able to test:

- the `mysql` provider's transport target answers on `127.0.0.1:3306` at 11.8.6;
- the runtime URL authenticates and can select `affiliateos`;
- the shadow URL authenticates and can select `affiliateos_shadow` (prerequisite for `migrate dev`);
- the account holds exactly the DML+DDL set Prisma migrations need, scoped to those schemas;
- the account **cannot** create a database, so `shadowDatabaseUrl` must be supplied — confirming the config decision rather than contradicting it.

### 5.3 Configuration the implementation checkpoint should apply

Unchanged from v1 §4.3, now fully satisfiable because both variables exist:

```ts
// prisma.config.ts — single-account development variant
import { defineConfig } from "prisma/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Prisma CLI requires ${name}. Set it in the environment or a loaded .env file.`);
  return value;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: required("DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});

// runtime singleton
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
const adapter = new PrismaMariaDb(process.env.DATABASE_URL!);
export const prisma = new PrismaClient({ adapter });
```

**B11 is now the only open Prisma unknown:** Prisma 7 does not auto-load `.env` (proven in the spike), so the schema/config must be reachable through `dotenv` in `prisma.config.ts`, `node --env-file`, or an explicit export. That choice must be made and tested in Checkpoint 6, before any Prisma command is trusted.

---

## 6. Files changed

| File | Change |
|---|---|
| `docs/PHASE-1-CHECKPOINT-5-REPORT.md` | **Rewritten** (v2) with re-run evidence |

No other file created, edited, or deleted. `.env` read-only from this side (still mode `600`, unmodified). No `package.json`, no lockfile, no source, no migration. No commit, no push.

---

## 7. Tests executed

| # | Command (abridged) | Result |
|---|---|---|
| 1 | Structural parse of `.env` (2 vars, shapes only) | both `mysql://`, host `127.0.0.1:3306`, user `affiliateos_dev`, dbs `affiliateos` / `affiliateos_shadow` |
| 2 | `stat` on `.env` | `600 reksa:reksa` |
| 3 | `git check-ignore -v .env` | `.gitignore:40:.env` |
| 4 | `git ls-files \| grep -i '\.env'` | 0 tracked |
| 5 | Client query `VERSION()/DATABASE()/CURRENT_USER()/SESSION_USER()` with `-D affiliateos` | exit 0: `11.8.6`, `affiliateos`, `affiliateos_dev@127.0.0.1` |
| 6 | Same with `-D affiliateos_shadow` | exit 0: `11.8.6`, `affiliateos_shadow`, `affiliateos_dev@127.0.0.1` |
| 7 | `SHOW GRANTS FOR CURRENT_USER()` (both URLs) | 2 schema-scoped grants + `USAGE ON *.*` only |
| 8 | `information_schema.SCHEMA_PRIVILEGES` | 26 rows (13 × 2) |
| 9 | `information_schema.USER_PRIVILEGES` excluding `USAGE` | 0 rows |
| 10 | `information_schema.SCHEMATA` listing | `affiliateos`, `affiliateos_shadow`, `information_schema` |
| 11 | `USE tinggalklik` / `restaurant_app` / `phpmyadmin` / `solusisejalan` | 4 × `ERROR 1044` |
| 12 | `SHOW TABLES FROM` the same four schemas | 4 × `ERROR 1044` |
| 13 | `information_schema.TABLES` count per schema | 0 / 0 |
| 14 | `information_schema.VIEWS` count | 0 |
| 15 | Schema charset/collation query | drift detected → F7 |
| 16 | Presence probe for Prisma artifacts | all absent |
| 17 | `git status`, `git log`, `git diff HEAD -- docs` | 1 commit, no tracked changes |
| 18 | Secret scan of this report against the live password | no match |

Not run, deliberately: `npm install`, `npx prisma *`, any `CREATE`/`ALTER`/`DROP`, `GRANT`, `CREATE USER`, `sudo`, any access to another application's data.

---

## 8. Remaining blockers and findings

| ID | Severity | Status | Description | Owner |
|---|---|---|---|---|
| **F1** | Critical | **CLOSED** | `root` in `DATABASE_URL` | Operator, done |
| **F4** | Medium | **CLOSED** | `SHADOW_DATABASE_URL` missing | Operator, done |
| **F3** | Medium | **CLOSED** | `.env` mode `664` | Operator, now `600` |
| **F7 (new)** | **Medium** | **OPEN** | `affiliateos` default collation is `utf8mb4_uca1400_ai_ci`; `affiliateos_shadow` is `utf8mb4_unicode_ci`. Mismatch can cause "Illegal mix of collations" during migrations and inconsistent index behaviour between dev and shadow runs. | Operator / Checkpoint 6 |
| **F5** | Low | **OPEN** | DB password 8 chars; hash is weak-MD5 style | Operator (rotate at will) |
| **F2 / B14** | High | **OPEN** | No Prisma project; adapter never exercised live | Checkpoint 6 |
| **B11** | Medium | **OPEN** | Prisma 7 `.env` loading strategy undecided | Checkpoint 6 |
| **B1** | — | **RESOLVED** | Database provisioned, reachable, correctly scoped | Operator, verified here |
| **B2, B3, B4, B5, B7** | — | Open | Redis, Docker, TikTok credentials/market, non-interactive sudo | Later phases |

**Recommended fix for F7** (operator, one statement each; not executed here because DDL is out of scope):

```sql
ALTER DATABASE `affiliateos`        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER DATABASE `affiliateos_shadow` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`affiliateos` is empty, so changing the default now is free; after tables exist it would require per-column conversion. If the project instead standardises on `uca1400`, both schemas must move together — but `docs/02-DATABASE-DESIGN.md` and the Checkpoint 4 report specify `utf8mb4_unicode_ci`, so aligning to that is the consistent choice.

### Limitations of this report

- Prisma 7.10.1, `@prisma/adapter-mariadb`, `prisma generate`, and any `$queryRaw` round-trip were **not** tested — no project exists. Requirement 5 is unverified, not failed.
- No migration was run, so the account's DDL grants were verified by inspection, not by executing DDL.
- Pooling, timeouts, timezone (`timezone: "Z"`) and connection-limit behaviour remain unmeasured.
- MariaDB is still reachable only on `127.0.0.1`; remote/container access is out of scope until B3.

---

## 9. Final status

# **PASS WITH LIMITATIONS**

The database half of Checkpoint 5 is genuinely complete and evidenced:

- both `.env` URLs authenticate as **`affiliateos_dev@127.0.0.1`** — no root anywhere;
- both point at the **correct, empty** schemas (`affiliateos`, `affiliateos_shadow`);
- privileges are exactly 13 DML+DDL rights **per schema**, with **zero** global privileges;
- four independent cross-application probes fail with `ERROR 1044`, and those schemas are not even visible in `information_schema`;
- the account cannot create a database, which validates the pre-created-shadow design;
- `.env` is mode `600`, git-ignored, untracked, and no secret appears in this report.

The limitation is singular and honest: **Prisma has not been proven to talk to MariaDB**, because there is no Prisma project to run. That was true in v1, is true now, and cannot be fixed by verification — only by implementation.

One new defect was found and left unfixed by design: **F7, the collation mismatch between the two schemas.** It is cheap now and expensive later.

**STOP.** Checkpoint 6 is not started. Awaiting operator approval.
