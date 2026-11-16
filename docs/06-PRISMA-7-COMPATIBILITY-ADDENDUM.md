# 06 — PRISMA 7 COMPATIBILITY ADDENDUM

> Companion to the Phase 0 documents. Written after the Checkpoint 1 version
> compatibility spike (`docs/PHASE-1-CHECKPOINT-1-REPORT.md`).
>
> **Authority:** where this document contradicts `01-ARCHITECTURE.md` or
> `02-DATABASE-DESIGN.md`, this addendum is authoritative for Prisma-related
> configuration until those documents are formally revised in a later approved
> checkpoint. They were **not** edited here.
>
> **No evidence of a live database connection exists.** Nothing in this addendum
> was verified against a running MariaDB server, and no TikTok capability is
> claimed.

---

## 1. Scope and Evidence Basis

| Item | Value |
|---|---|
| Prisma CLI / Client | 7.10.1 (exact pin) |
| MariaDB adapter | `@prisma/adapter-mariadb` 7.10.1 |
| Adapter's underlying driver | `mariadb` 3.5.5 (transitive) |
| Node.js | v26.13.0 |
| TypeScript | 7.0.2 |
| MariaDB server | 11.8.6 active on `127.0.0.1:3306` — **never connected to** |
| Spike location | `/tmp/affiliateos-spike.L6q6Lx` (deleted after the checkpoint) |

What was actually executed in the spike (evidence in the Checkpoint 1 report):

```
prisma validate   → exit 0  "The schema at prisma/schema.prisma is valid 🚀"
prisma generate   → exit 0  "Generated Prisma Client (7.10.1) ... in 22ms" (9 files)
prisma -v         → 7.10.1 · Node v26.13.0 · TS 7.0.2 · Query Compiler: enabled
tsc --noEmit      → exit 0  including `new PrismaClient({ adapter })` and `PrismaMariaDb`
```

What was **not** executed: any connection, query, transaction, migration, shadow
database creation, or deployment. Statements about those are marked
**NOT VERIFIED** below.

The Prisma 6 column in §2 is derived from the Phase 0 design documents and general
`prisma-client-js` usage — it was **not** exercised in the spike. It is included
only to make the migration delta explicit.

---

## 2. Prisma 6 vs Prisma 7 — What Actually Changed

| Aspect | Prisma 6 (Phase 0 assumption, untested) | Prisma 7.10.1 (observed) |
|---|---|---|
| Connection URL location | `datasource db { url = env("DATABASE_URL") }` in `schema.prisma` | **Rejected**: `P1012 — The datasource property 'url' is no longer supported in schema files` |
| Config file | `package.json` `"prisma"` key or conventional layout | `prisma.config.ts` (TypeScript), evaluated by the CLI |
| Generator | `provider = "prisma-client-js"`, output hidden in `node_modules` | `provider = "prisma-client"`, explicit `output` **required**, emits TypeScript into the repo |
| Query engine | Rust query engine binary bundled per platform | **Query Compiler enabled**; data access goes through a driver adapter |
| `new PrismaClient()` | Reads the datasource URL from generated config/env | **Requires** `{ adapter }` or `{ accelerateUrl }`; there is no implicit URL |
| Database driver | Prisma-owned engine | Vendor driver (`mariadb` 3.5.5) via `@prisma/adapter-mariadb` |
| `provider` in schema | `mysql` | still `mysql` (MariaDB is served by the MySQL provider) |
| Node.js minimum | 18.x era | `^20.19 \|\| ^22.12 \|\| >=24.0` |
| Studio | bundled with CLI | reported separately by `prisma -v` (0.33.0) |

**Consequence:** every Prisma example written for v6 that puts `url` in the schema
or calls `new PrismaClient()` without an adapter is wrong for this project. Schema
and client construction are both breaking changes, not stylistic preferences.

---

## 3. Correct Prisma 7 Configuration

### 3.1 `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "mysql"
}
```

- No `url`, no `directUrl`, no `shadowDatabaseUrl` in the schema.
- `output` is mandatory and must be a path inside the package that owns the
  client (`packages/database/src/generated/prisma` in the target monorepo).
- Keep `provider = "mysql"`; MariaDB 11.8 is addressed through it.

### 3.2 `prisma.config.ts` (package root of `packages/database`)

```ts
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Verified in the spike: this exact shape made `validate` and `generate` pass after
`P1012`.

Design decision for the monorepo (recommended, **not yet executed**): resolve the
migration URL separately from the runtime URL, because migrations need a DDL user
while the app must use a DML-only user (`02-DATABASE-DESIGN.md` §2 item 8):

```ts
import { defineConfig } from "prisma/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Prisma CLI requires ${name} (migration/DDL connection). ` +
        `Set it in the environment or in a loaded .env file.`,
    );
  }
  return value;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: required("MIGRATE_DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

Rationale: the spike showed `env()` **throws** when the variable is absent — even
for `prisma -v` — because the config module is evaluated eagerly. A named,
explicit error is better than a stack trace, and a dedicated variable prevents the
DDL credential from becoming the app's runtime credential.

### 3.3 Client construction (runtime)

```ts
// packages/database/src/client.ts
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/prisma/client";

const adapter = new PrismaMariaDb(process.env.DATABASE_URL as string);

export const prisma = new PrismaClient({ adapter });
```

- `PrismaMariaDb` accepts `mariadb.Pool | mariadb.PoolConfig | string` (verified
  from its type surface; the string form is a connection URL).
- Use a **module-level singleton** per process. Next.js dev hot-reload will
  otherwise create a new pool on every reload and exhaust MariaDB connections.
- `packages/database` must not export the raw client. It exports `withTenant(ctx)`
  and `systemDb()` wrappers (per `01-ARCHITECTURE.md` §5) built on this singleton.

### 3.4 Generated client is build output, not source

- Add `packages/database/src/generated/**` to `.gitignore`.
- Run `prisma generate` before `tsc`/`next build` in every environment.
- Never hand-edit generated files; a diff there means the pipeline is wrong.

---

## 4. Environment Configuration

| Variable | Consumer | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | App runtime (`PrismaMariaDb`) | Yes | DML-only user; URL-encode the password; never logged |
| `MIGRATE_DATABASE_URL` | Prisma CLI (migrate) | Yes for migrate; must be resolvable for any CLI call | DDL user; separate credential from the app |
| `SHADOW_DATABASE_URL` | `prisma migrate dev` | Dev only | Must point to a database the migration user may create/drop |
| `TOKEN_ENCRYPTION_KEY` etc. | App (Phase 2) | Phase 2 | Unrelated to Prisma; listed in `04-SECURITY-PLAN.md` |

Rules established by evidence and existing policy:

1. **`.env` auto-loading is not proven for Prisma 7.** In the spike, `env()` only
   resolved values exported into the process; with nothing exported, the CLI failed
   with `PrismaConfigEnvError`. Phase 1 must either export variables explicitly or
   load them in `prisma.config.ts` (e.g. `dotenv`), and record which choice was
   tested. Do not assume v6's `.env` behaviour carries over.
2. `.env*` stays git-ignored; `.env.example` contains names only
   (`04-SECURITY-PLAN.md` §5).
3. Add `DATABASE_URL` / `MIGRATE_DATABASE_URL` to the logger redaction denylist —
   the URL can contain a password.
4. Distinct credentials per environment; no production URL in tests or fixtures.
5. `NODE_ENV` must not be used to silently switch database targets.

---

## 5. MariaDB Adapter Strategy

| Decision | Value |
|---|---|
| Adapter package | `@prisma/adapter-mariadb` 7.10.1 (pinned to the client version) |
| Driver | `mariadb` 3.5.5, pulled transitively; import `mariadb` types directly only if it is added as an explicit dependency |
| Schema provider | `mysql` |
| Pooling | One pool per process; `connectionLimit` from env, default 5 (web) / 3 (worker) — **not benchmarked** |
| Time zone | Force UTC on the session (`timezone: "Z"`); all `DATETIME(3)` are UTC by design (`02-DATABASE-DESIGN.md` §1) — **not verified** |
| TLS | Not used on loopback; production traffic stays on the internal Docker network, TLS only if the DB host is remote |
| Transactions | Standard `prisma.$transaction`; isolation level choice deferred to Phase 1 |
| Error handling | Map driver errors (deadlock, duplicate key, connection loss) to the `AppError` model; never surface raw driver text |

Why an adapter instead of the old engine: Prisma 7's Query Compiler expects a
driver adapter; there is no supported path back to the bundled Rust engine for
MariaDB in this version. This also means connection behaviour (pool sizing,
timeouts, reconnect) is now **our** responsibility via `mariadb` pool options,
which the old engine handled internally.

**Explicitly unverified:** that Prisma 7.10.1 + `@prisma/adapter-mariadb` +
MariaDB 11.8.6 can connect, run a query, honour `DECIMAL(18,2)`, store
`CHAR(36)`/`BINARY(32)`/`JSON`, and apply composite foreign keys. These are
Phase 1's first verification target, not assumed facts.

---

## 6. Command Workflow

All commands run from `packages/database` (or via the root workspace script that
delegates there) with the required environment resolvable.

| Command | Purpose | Status in spike |
|---|---|---|
| `npx prisma validate` | Parse and validate schema + config | **Executed, exit 0** |
| `npx prisma generate` | Emit the TypeScript client to `output` | **Executed, exit 0** (22 ms, 9 files) |
| `npx prisma format` | Normalise schema formatting | Not executed |
| `npx prisma migrate dev --name phase1_baseline` | Author + apply a migration, create shadow DB | **Not executed** — needs a live DB and `CREATE`/`DROP` rights |
| `npx prisma migrate deploy` | Apply committed migrations (CI/production) | **Not executed** |
| `npx prisma migrate status` | Drift/apply check | **Not executed** |
| `npx prisma migrate diff` | Review SQL before authoring destructive changes | **Not executed** |
| `npx prisma db push` | — | **Forbidden** by ADR-007 and `02-DATABASE-DESIGN.md` §8 |

Rules:

1. `prisma generate` runs in `postinstall`-equivalent position (explicit build
   step, not an npm script that may be suppressed) **and** in CI before typecheck.
2. Migrations are forward-only, named `YYYYMMDDHHMM_phaseN_short_description`, and
   committed under `prisma/migrations`.
3. `migrate dev` is a developer command only. CI applies `migrate deploy` to a
   fresh database; a migration that only works on populated data is a defect.
4. Production `migrate deploy` runs as a separate job with the DDL credential,
   after a verified backup, never from the web container's entrypoint.
5. Any `DROP`/narrowing/`NOT NULL`-without-default change requires written approval
   and a documented data-migration step (unchanged from Phase 0).

---

## 7. Production Deployment Impact

The deployment topology in `01-ARCHITECTURE.md` §10 does not change; the
*migration path* does.

- **Build stage** needs a resolvable Prisma datasource variable even though it does
  not connect. Provide it from the CI/deploy secret store; do not bake credentials
  into image layers.
- **Migrations** run in a one-shot job (`migrate deploy`) using the DDL user, before
  the new web/worker containers start. Web and worker containers get only the DML
  user.
- **No `db push`** anywhere, including "quick fixes".
- **Rollback** remains: compensating migration, or restore from the pre-migration
  backup with written approval (ADR-007).
- **Connection budget:** web (1 pool) + worker (1 pool) + migration job. The old
  bundled engine had its own defaults; pool limits are now explicit configuration
  and must be sized against MariaDB's `max_connections`.
- **Startup health:** `health/ready` must not depend on the Prisma CLI; it should
  issue a trivial query through the adapter.
- **Generated client** is produced during the image build, not copied from a
  developer machine.

---

## 8. CI Requirements

| # | Requirement | Reason |
|---|---|---|
| 1 | Node pinned (26.13.0 locally; ≥24 satisfies Prisma engines) | Verified working combination |
| 2 | `npm ci` against a committed lockfile, exact pins | Reproducibility; no range drift |
| 3 | A resolvable `MIGRATE_DATABASE_URL` (and `DATABASE_URL` if the app is typechecked against a real config) **before** any Prisma command | Config is evaluated eagerly; missing var = hard failure |
| 4 | `prisma generate` as an explicit step before `tsc`/`next build` | Client is build output, git-ignored |
| 5 | `prisma validate` | Cheap guard against schema/config drift |
| 6 | Post-install assertion that the schema engine binary exists | Protects against suppressed install scripts (§9) |
| 7 | Migration job: `migrate deploy` against a fresh MariaDB 11.8 service, then `migrate status` | Exit criterion 1 of Phase 1 |
| 8 | Secret scanning + `.env*` git-ignored from the first commit | Existing security plan requirement |
| 9 | No Prisma command in the web container entrypoint | Prevents concurrent DDL and slow boots |
| 10 | Build runs in isolation (single job, not parallel with tests) | 3.2 GiB RAM ceiling |

CI cannot be written yet: there is no repository and no pipeline (B6), and no
database service credentials (B1).

---

## 9. npm 11 `allowScripts` — Risk and Decision

### 9.1 Observed behaviour

```
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   prisma@7.10.1 (preinstall: node scripts/preinstall-entry.js)
npm warn install-scripts   @prisma/engines@7.10.1 (postinstall: node scripts/postinstall.js)
```

The install still exited 0, and the schema engine was present at
`node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x`. `validate`,
`generate`, and `-v` all worked.

### 9.2 Risk

- The behaviour is **environment-dependent by design**: npm 11 deliberately does
  not run unreviewed lifecycle scripts. On a different machine, a different
  platform, or a future npm version, the engine may be absent and the failure will
  surface as a confusing Prisma error rather than an install error.
- Blanket-approving all scripts re-opens the supply-chain hole the policy exists
  to close.
- `--ignore-scripts` globally would also disable legitimate build steps in other
  packages later.

### 9.3 Decision

**Allow install scripts for exactly two packages — `prisma` and `@prisma/engines` —
and verify the result, rather than relying on the warning.** Concretely:

1. Record the allowlist in the repository (npm 11 `allowScripts` configuration),
   limited to those two package names, so the approval is reviewable in a diff.
2. After `npm ci`, run an explicit check that a `schema-engine-*` binary exists
   under `node_modules/@prisma/engines/`; fail the job with a message naming this
   addendum if it does not.
3. Never use `--ignore-scripts` as the project default, and never approve scripts
   for any other dependency without a written justification.
4. Re-verify the npm 11.20.0 syntax for the allowlist before committing it — the
   command/field was **not** exercised in the spike, only the warning was observed.

Fallback if the allowlist mechanism proves unreliable: keep scripts disabled, and
make the engine-presence check the gate, documenting the required manual step. The
one outcome that is not acceptable is a silent skip.

---

## 10. Impact on Phase 1 Scope (`docs/05-ROADMAP.md` §2)

| Phase 1 scope item | Prisma 7 impact |
|---|---|
| npm workspaces monorepo | Unchanged. `packages/database` must own `prisma.config.ts`, schema, migrations, generated output |
| Prisma schema + baseline migration for P1 tables | Schema authoring unaffected; **migration step now needs a DDL user + shadow database** and a Prisma 7 config file. Cannot be verified without B1 |
| Session auth, Argon2id, CSRF, rate limiting | No Prisma change. Argon2id remains untested (spike V5) |
| Tenancy (`withTenant`, composite FKs) | Composite FK feasibility still unverified at the engine level. First task after DB access |
| RBAC seed (`permissions`, roles) | Seeding runs through the adapter client; idempotent seed strategy still undecided (Q3) |
| Audit logging | Unchanged; append-only grants belong to the DDL/DML split |
| Worker skeleton + `maintenance.ping` | Worker needs its own singleton client and pool budget; BullMQ still blocked (B2) |
| `docker-compose.yml` authored, unexecuted | Add a migration one-shot service and separate app/migration credentials |
| `health/ready` 200 | Must query through the adapter; cannot be claimed until B1 |
| Migration-from-zero test | Now also tests `migrate deploy` under Prisma 7 config — still blocked (B1) |
| Exit criterion 1 (fresh DB → `migrate deploy` → boot) | **Not attainable yet**; requires B1 |
| Exit criterion 5 (`next build`) | Achieved in the spike for a hello-world; must be re-proven in the monorepo |

**Conclusion:** Phase 1 scope does not need to shrink, but its *ordering* must
change: DB connectivity + a trivial Prisma 7 query + `migrate deploy` on a fresh
database are the first implementation tasks, before the P1 schema is finalized.
Writing the full P1 schema against an unverified adapter would hide failures behind
a large diff.

---

## 11. Not Verified (do not assume)

1. Any connection from Prisma 7.10.1 to MariaDB 11.8.6.
2. `migrate dev`, `migrate deploy`, `migrate status`, `migrate diff`, shadow DB creation.
3. Runtime behaviour of `PrismaMariaDb`: pooling, timeouts, reconnect, UTC session.
4. Prisma-level handling of `CHAR(36)` UUIDs, `BINARY(32)` hashes, `JSON` columns,
   composite foreign keys, `DECIMAL(18,2)`.
5. Interactive transactions and isolation levels.
6. Generated-client output inside an npm workspace package (path resolution,
   build order, `tsc` project references).
7. `.env` auto-loading under Prisma 7 config.
8. npm 11 allowlist syntax (only the warning was observed).
9. Memory impact of the Query Compiler + MariaDB driver in web and worker.
10. Prisma Studio against this schema.
11. Any Prisma 7.x patch upgrade (7.10.1 is the only tested version).
12. TikTok API access — unrelated to this document and still fully blocked.

---

## 12. Final Dependency Pin Recommendation

Based on the spike (compile + build evidence, not database evidence):

```json
{
  "dependencies": {
    "next": "16.4.6",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "@prisma/client": "7.10.1",
    "@prisma/adapter-mariadb": "7.10.1",
    "mariadb": "3.5.5"
  },
  "devDependencies": {
    "prisma": "7.10.1",
    "typescript": "7.0.2",
    "tailwindcss": "4.3.5",
    "@tailwindcss/postcss": "4.3.5",
    "postcss": "8.5.6",
    "@types/node": "24.10.1",
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.3"
  }
}
```

Notes on specific choices:

- **`prisma` and `@prisma/client` must stay equal.** 7.10.1 is the only tested
  pair; do not accept the suggested 8.x prerelease.
- **`mariadb` as a direct dependency** (3.5.5, already transitive): the adapter
  exposes `mariadb.PoolConfig` types, and relying on a transitive package for
  imported types is fragile.
- **`@types/node` 24.10.1** while running Node 26: the runtime works, but no 26.x
  types were validated. Upgrade only with a typecheck run.
- **No Tailwind config file** is needed (v4 CSS-first); the spike verified
  `@tailwindcss/postcss` output containing utilities and `@apply`.
- **No shadcn/ui, Zod, BullMQ, Argon2, Vitest, Playwright pins** are recommended
  yet — they were outside the spike and must not be presented as validated.

### Configuration files this pin implies

```
packages/database/prisma/schema.prisma      (no url; provider "mysql")
packages/database/prisma.config.ts          (datasource.url, migrations.path)
packages/database/src/client.ts             (singleton + PrismaMariaDb)
packages/database/src/generated/prisma/**   (build output, git-ignored)
```

---

## 13. Compliance Note

This addendum was written without implementing application code, without creating
`package.json`, a Prisma schema, a migration, a database, or an environment file,
without installing dependencies, and without any Git operation. The seven Phase 0
documents are unchanged.
