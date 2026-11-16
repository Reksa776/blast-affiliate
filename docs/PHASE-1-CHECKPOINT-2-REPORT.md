# PHASE 1 — CHECKPOINT 2 REPORT

## Prisma 7 Architecture Reconciliation

- **Date:** 2026-11-16
- **Scope:** reconcile architecture and documentation with the Checkpoint 1 spike
- **Deliverables:** `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md`, this report
- **Status:** **PASS WITH LIMITATIONS** (documentation complete; database behaviour still unverified)
- **Applications code, schema, migrations, dependencies, Git:** untouched.

---

## 1. Review of Checkpoint 1 Results

Checkpoint 1 was a real execution spike, not a documentation review. Results carried
into this checkpoint:

| Area | Checkpoint 1 result | Confidence for Phase 1 |
|---|---|---|
| Install | 180 packages, exit 0, `npm ls --all` exit 0 | High |
| Next.js 16.4.6 build | exit 0, 3 static routes, 2.4–4 s | High (hello-world only) |
| TypeScript 7.0.2 | `tsc --noEmit` exit 0, incl. generated Prisma client + adapter | High |
| Prisma validate | exit 0 | High |
| Prisma generate | exit 0, 9 files, 22 ms | High |
| Tailwind 4.3.5 | utilities + `@apply` present in emitted CSS and standalone PostCSS | High |
| MariaDB connection | **never attempted** | **None** |
| Migration workflow | **never executed** | **None** |
| npm install scripts | two Prisma scripts withheld by npm 11; no observed breakage | Medium |

The one substantive defect found in Checkpoint 1 was mine, not Prisma's: an initial
search in `.next/static/css` produced a false negative because Turbopack emits CSS
under `.next/static/chunks/`. That was corrected before the report was written.

Three findings from Checkpoint 1 drive this checkpoint:

1. Prisma 7 rejects `datasource.url` in the schema (`P1012`) — the Phase 0 database
   design assumes the v6 form.
2. `PrismaClient` requires a driver adapter; there is no implicit env-based client.
3. The Prisma CLI evaluates `prisma.config.ts` eagerly, so a missing environment
   variable fails even `prisma -v`.

---

## 2. Required Architecture Changes

Recorded in `06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` §3–§10. Summary of what changes
relative to the Phase 0 documents (which were **not** edited):

| # | Change | Affects |
|---|---|---|
| A1 | Connection URL moves from `schema.prisma` to `prisma.config.ts` | `02-DATABASE-DESIGN.md` §8, all Prisma snippets |
| A2 | Generator becomes `provider = "prisma-client"` with mandatory `output` under `packages/database` | `01-ARCHITECTURE.md` §2, build order |
| A3 | `PrismaClient` is constructed with `PrismaMariaDb`; a singleton lives in `packages/database` | `01-ARCHITECTURE.md` §5 (`withTenant`/`systemDb` wrappers) |
| A4 | Migration command needs a DDL credential distinct from the app's DML credential | `02-DATABASE-DESIGN.md` §2 item 8, §8 |
| A5 | Every Prisma invocation (including `generate` at build time) needs its datasource variable resolvable | CI, Dockerfile, deployment runbook |
| A6 | Generated client is build output, git-ignored, produced before typecheck/build | repo layout, CI, Docker |
| A7 | Pool sizing/timeouts become explicit configuration (adapter owns the pool) | production deployment, worker budget |
| A8 | npm 11 install-script policy must be an explicit, reviewable allowlist | repo config, CI |

Deliberately **not** changed: topology (modular monolith + worker), tenant isolation
model, table catalog, forward-only migration policy, DML/DDL user split, and the
prohibition on `db push`. None of those are invalidated by Prisma 7.

---

## 3. Prisma 7 Decision

**Adopt Prisma 7.10.1 with the MariaDB driver adapter.** No attempt to remain on the
Prisma 6 configuration model.

Decided configuration:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "mysql"
}
```

```ts
// prisma.config.ts
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: required("MIGRATE_DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

```ts
// packages/database/src/client.ts — singleton per process
const adapter = new PrismaMariaDb(process.env.DATABASE_URL as string);
export const prisma = new PrismaClient({ adapter });
```

Rationale:

- It is the only supported path in 7.10.1 (the spike proved the v6 form fails).
- A separate migration credential preserves the Phase 0 least-privilege design; the
  alternative — one DDL-capable URL for everything — silently weakens it.
- A module-level singleton is required because the adapter owns a real connection
  pool; Next.js hot reload would otherwise leak pools in development.

Consequences accepted explicitly:

- Every developer and CI job needs the datasource variable present before any
  Prisma command.
- The generated client must be produced in each environment; a stale or missing
  output is a build-order defect.
- Adapter behaviour (UTC session, pool limits, reconnect) is now our configuration
  surface, not the engine's defaults.

---

## 4. npm Install-Script Policy Decision

**Decision: allow lifecycle scripts for `prisma` and `@prisma/engines` only, and
gate the pipeline on an explicit engine-binary check.**

- The allowlist must be committed and reviewable, limited to those two packages.
- CI asserts that a `schema-engine-*` binary exists after install; otherwise the
  job fails with a message pointing at the addendum.
- `--ignore-scripts` is not a project-wide default.
- New packages requiring scripts need written justification before being allowed.
- The npm 11.20.0 allowlist **syntax was not executed** in the spike (only the
  warning was observed), so it must be verified before being committed.

Rejected alternatives:

| Alternative | Why rejected |
|---|---|
| Approve all scripts | Reopens the supply-chain risk the npm 11 policy exists to reduce |
| Global `--ignore-scripts` | Breaks future legitimate build steps; hides the engine problem instead of checking it |
| Do nothing and rely on the warning | Failure would appear later as a confusing Prisma error on another machine |

This is a policy decision only. Nothing was configured or installed in this
checkpoint.

---

## 5. Environment Requirements

| Requirement | Detail | Status |
|---|---|---|
| `DATABASE_URL` | App runtime URL, DML-only user, URL-encoded password | Needs operator (B1) |
| `MIGRATE_DATABASE_URL` | DDL user for `migrate dev`/`migrate deploy` | Needs operator (B1) |
| `SHADOW_DATABASE_URL` | Dev only; migration user must be able to create/drop it | Needs operator (B1, Q2) |
| Env loading | `.env` auto-load is unproven for Prisma 7; choose explicit export or `dotenv` in `prisma.config.ts` and record the tested path | Undecided |
| Redaction | Add both DB URLs to the logger denylist (they can contain passwords) | Phase 1 |
| Node / npm | Node 26.13.0, npm 11.20.0 (tested) | Available |
| Generated client | Produced before typecheck/build; git-ignored | Phase 1 |
| CI pipeline | Does not exist (B6) | Blocked |
| Database service | MariaDB 11.8.6 active, but no application account or database | Blocked (B1) |

No `.env`, `.env.example`, or config file was created in this checkpoint.

---

## 6. Technical Risks

| # | Risk | Likelihood | Impact | Mitigation / trigger |
|---|---|---|---|---|
| P1 | Prisma 7.10.1 + `@prisma/adapter-mariadb` fails at runtime against MariaDB 11.8.6 (not just compile) | Medium | High | Make a trivial connect + `SELECT 1` the **first** Phase 1 task; if it fails, evaluate `@prisma/adapter-mysql`-class alternatives or a Prisma 7 patch, with a written review |
| P2 | Composite FKs / `CHAR(36)` / `BINARY(32)` / `JSON` behave differently than designed | Medium | Medium | Validate the P1 schema on a scratch DB before finalizing it; adjust design with a documented change |
| P3 | Migration workflow requires privileges the operator will not grant (shadow DB creation) | Medium | High | Ask explicitly for `CREATE`/`DROP` on shadow schema, or adopt a pre-created shadow database; decide before authoring migrations |
| P4 | Missing datasource variable breaks CI/build because config is evaluated eagerly | High | Medium | Explicit required-variable error + a pipeline step that fails fast with a clear message |
| P5 | npm 11 withholds Prisma engine scripts on another machine | Medium | Medium | Allowlist + engine-binary assertion (§4) |
| P6 | Generated client drifts or is committed by accident | Medium | Low | `.gitignore` + generate-before-build + CI check for a clean tree |
| P7 | Next.js dev hot reload exhausts MariaDB connections | High (if naive) | Medium | Module-level singleton, documented in `packages/database` |
| P8 | Timezone mismatch between Node and MariaDB session | Medium | High (wrong dates in money/audit data) | Force UTC session; integration test asserting stored `DATETIME(3)` values |
| P9 | Prisma 7.x patch upgrade changes config API | Low–Medium | Medium | Pin 7.10.1 exactly; upgrade only with a rerun of the spike checklist |
| P10 | Build memory pressure with Query Compiler + Next (3.2 GiB available) | Medium | Low–Medium | Serial CI jobs, isolated build, measure RSS (not measured in Checkpoint 1) |

Risk R4 in `05-ROADMAP.md` ("Node 26 / Prisma 7 / TypeScript 7 incompatibility")
can be downgraded from *Medium/Medium* to *Low/Medium* for build-time concerns; the
runtime-database half remains open as P1.

---

## 7. Readiness for Phase 1 Implementation

**Ready now (no external dependency):**

- npm workspaces scaffold, TypeScript config, path aliases.
- Next.js app shell, layout, Tailwind 4 wiring (verified in the spike).
- `packages/database` skeleton: `schema.prisma` (empty/partial), `prisma.config.ts`,
  client singleton, generated-output plumbing.
- Auth, tenancy, and permission logic that does not touch the database yet
  (pure functions, types, Zod schemas).
- Unit tests for hashing, redaction, signing — none need the DB.

**Not ready (hard dependencies):**

- Baseline P1 migration and `migrate deploy` on a fresh database (B1).
- Any integration test, cross-tenant attack suite, or RBAC matrix test (B1).
- `health/ready` returning 200 (B1).
- Worker + BullMQ smoke test (B2).
- `docker-compose.yml` execution (B3).
- CI pipeline (B6).

**Exit criteria impact (`05-ROADMAP.md` §2):** criteria 1, 2, 3 are unreachable until
B1; criterion 4 (Argon2id measurement) is reachable but untested; criterion 5
(`next build`) was proven for a hello-world in the spike and must be re-proven in
the monorepo; criterion 6 is procedural.

**Recommended ordering change:** DB connectivity and a trivial Prisma 7 query come
*before* authoring the full P1 schema. A large schema written against an unverified
adapter would convert one clear failure into many ambiguous ones.

---

## 8. Remaining Blockers

| # | Blocker | Status | Blocks |
|---|---|---|---|
| B1 | No MariaDB application account/database | **Open** | Migration, integration tests, `health/ready`, P1 verification |
| B2 | Redis not installed | **Open** | BullMQ smoke test |
| B3 | Docker not installed | **Open** | Compose execution |
| B4 | No TikTok Partner Center app/credentials | **Open** | All live affiliate capability |
| B5 | Indonesia affiliate availability / 2026-10 quota rollout unconfirmed | **Open** | Phase 5 design assumptions |
| B6 | Not a Git repository | **Open** | CI, commit workflow, reviewable allowlist |
| B7 | No non-interactive sudo | **Open** | Any system-level provisioning |
| B8 | Prisma 7 breaking config change vs Phase 0 design | **Resolved in documentation** (this addendum); Phase 0 docs still need a formal revision in an approved checkpoint | Schema authoring clarity |
| B9 | npm 11 install-script policy | **Decided** (§4); not yet implemented or syntax-verified | CI reliability |
| B10 | Datasource variable required by every Prisma CLI call | **Documented**; pipeline not yet built | CI build step |
| B11 | Env-loading strategy for `prisma.config.ts` (.env auto-load unproven) | **Open decision** | Developer setup, CI |

---

## 9. Recommended Next Actions

Ordered; all require human approval before execution.

1. **Approve this report and the addendum.** They are the current authority for
   Prisma configuration until Phase 0 documents are formally revised.
2. **Operator: provision the database (B1).** Database `affiliateos` (utf8mb4),
   `affiliateos_app` (DML only), `affiliateos_migrate` (DDL), and a shadow database
   the migration user may create/drop. Provide URLs via environment, never chat.
3. **Decide the env-loading strategy (B11)** — explicit export vs `dotenv` inside
   `prisma.config.ts` — and record which was tested.
4. **Approve the DB-connectivity spike as the first Phase 1 implementation step:**
   one table, `migrate deploy` on a fresh database, one insert/select through
   `PrismaMariaDb`, plus verification of UTC storage, `CHAR(36)`, `DECIMAL(18,2)`,
   `JSON`, and a composite FK. This closes the largest remaining unknown.
5. **Resolve Redis (B2) and Git (B6)** so integration tests and CI can exist.
6. **Only then** start Checkpoint 3 (monorepo scaffold), under a new explicit
   instruction.

Nothing in items 2–6 was performed here. No dependency was installed, no schema or
migration written, no database touched, no Git operation run, and no Phase 0
document modified.

---

## Verification Performed for This Checkpoint

| Check | Result |
|---|---|
| All Phase 0 documents re-read | Done (00, 01, 02, 03, 05, PHASE-0-REPORT in full; 04 targeted for env/secret/backup rules) |
| Checkpoint 1 report re-read | Done |
| Addendum written | `docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` |
| Phase 0 documents unmodified | Verified by SHA-256 before/after this checkpoint |
| `package.json` / `node_modules` absent | Verified |
| Schema / migration / `.env` created | None |
| Database contacted | No |
| Git operations | None |
| TikTok API called | No |
