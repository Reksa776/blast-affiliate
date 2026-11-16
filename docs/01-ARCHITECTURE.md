# 01 — ARCHITECTURE

> Phase 0 deliverable. Target architecture for AffiliateOS. Decisions marked
> **DECIDED** are binding for Phase 1 unless a later written review supersedes
> them. Decisions marked **TO VALIDATE** are deliberate open points with a named
> spike.

---

## 1. Shape

**Modular monolith** with two runnable processes sharing one codebase:

```
apps/web      Next.js 16 (App Router) — UI + Route Handlers
apps/worker   Node process — BullMQ consumers + scheduler loop
```

One deployable image family, one database, one Redis. No microservices, no
service mesh, no message bus beyond Redis. A microservice split is only permitted
after a written architectural review demonstrates a concrete requirement
(independent scaling bottleneck, separate failure domain, or org boundary), which
does not exist for an internal agency tool of this size.

### Why this shape fits the constraints

- 3.2 GiB available RAM rules out a container-per-service topology.
- The domain is CRUD-heavy with a modest background workload (sync jobs,
  outreach batches, snapshots). A monolith with a separate worker gets isolation
  of long-running work without distributed-systems overhead.
- Tenant isolation is a *logical* boundary enforced in one place, which is easier
  to prove correct than across many services.

---

## 2. Repository Layout

```
affiliateos/
├── apps/
│   ├── web/
│   │   ├── src/app/                     App Router: (auth), (dashboard), api/
│   │   ├── src/components/              UI only — no business logic
│   │   ├── src/server/                  route-handler adapters, session glue
│   │   └── next.config.ts
│   └── worker/
│       └── src/
│           ├── main.ts                  worker bootstrap
│           ├── scheduler.ts             cron-like enqueue loop
│           ├── queues/                  queue definitions + job payload schemas
│           └── processors/              one file per job type
├── packages/
│   ├── database/          Prisma schema, migrations, generated client, repositories
│   ├── auth/              password hashing, sessions, cookie handling, OAuth state
│   ├── permissions/       permission catalog, role→permission evaluation
│   ├── tenancy/           tenant context types, guards, scoped-repository helpers
│   ├── shared/            Result/error types, IDs, time, money, logging, redaction
│   ├── validation/        Zod schemas shared by web + worker + tests
│   ├── modules/           business modules (see §3)
│   └── integrations/
│       └── tiktok/        API client, signing, OAuth, capability registry, mocks
├── docs/
├── tests/
│   ├── integration/       DB-backed module tests
│   ├── security/          cross-tenant + authz attack tests
│   └── e2e/               Playwright
├── docker-compose.yml
├── package.json
└── README.md
```

**DECIDED:** npm workspaces (npm 11 is present; pnpm/yarn are not). Adding a
package manager is an unnecessary dependency and an install step the host cannot
currently satisfy.

**DECIDED:** `packages/modules/*` contains one folder per business module, each
exporting: `service` (use cases), `repository` (Prisma access), `schemas` (Zod),
`types`, and `index.ts` public surface. Nothing outside a module imports its
internals — only its `index.ts`.

---

## 3. Modules and Responsibilities

| Module | Owns | Must not |
|---|---|---|
| `identity` | users, credentials, sessions, password reset | know about tenants or shops |
| `tenancy` | tenants, workspaces, memberships, invitations | own roles/permissions |
| `permissions` | permission catalog, roles, role grants, member role grants, `can()` | query business tables |
| `shops` | shops, TikTok connections, OAuth states, shop status | call TikTok directly (uses `integrations/tiktok`) |
| `creators` | creator records, profiles, tags, notes, status history, blacklist, assignments | own campaigns |
| `campaigns` | campaigns, products, briefs, assets, campaign↔creator links, ad codes | perform outreach |
| `outreach` | templates, batches, records, quota snapshots, eligibility, dedupe | send messages outside the official API |
| `analytics` | affiliate orders, snapshots, metric definitions, exports | invent metrics with no source |
| `team` | targets, BD assignment reporting | own membership |
| `notifications` | in-app notifications, delivery state | send unofficial channel messages |
| `audit` | audit log writes, read API for admins | mutate business data |
| `sync` | API sync logs, sync orchestration, idempotency keys | contain business rules |

Dependency direction (acyclic, enforced by an import-boundary lint rule in Phase 1):

```
shared, validation, database
        ↑
    tenancy, permissions, auth
        ↑
      modules/*        (may depend on each other ONLY through public index.ts;
                        forbidden pairs listed in .dependency-cruiser config)
        ↑
   apps/web, apps/worker
```

**Hard rules**

1. Route handlers contain no business logic: parse → authorize → call module →
   map result to HTTP. Target ≤ 40 lines per handler.
2. React components never import from `packages/modules` or `packages/database`.
3. No module imports another module's repository.
4. `integrations/tiktok` never imports `modules/*` — it is a leaf that knows only
   HTTP, signing, tokens, and its own DTOs.
5. Circular imports fail CI.

---

## 4. Request Lifecycle (web)

```
Request
  → middleware: secure headers, host/origin check, request id, coarse rate limit
  → route handler
      1. parse input with Zod (packages/validation)
      2. resolveSession()                 ← packages/auth (cookie → session row)
      3. resolveTenantContext(session)    ← packages/tenancy
           - active tenant from server-side membership row, NOT from URL/body
           - membership status must be ACTIVE
      4. authorize(permission, resource?) ← packages/permissions (server-side)
      5. call module service with TenantContext (required argument, not optional)
      6. module repository builds queries that ALWAYS include tenant_id
      7. map Result → HTTP; audit-log mutating actions
```

**Tenant resolution rules (binding):**

- The browser may send a tenant *selector* (e.g. `x-workspace-slug` or a URL
  segment), but it is treated as a hint. The authoritative tenant comes from a
  server-verified membership lookup for the session user.
- A request with a tenant hint that does not match an active membership is
  rejected `403` — never silently scoped to a default tenant.
- `tenant_id` is never read from a JSON body or query string for authorization.
- Background jobs carry `tenantId` in their payload, and the worker re-validates
  it against a persisted job record before touching data.

---

## 5. Tenant Context as a Type

```ts
// packages/tenancy
type TenantContext = {
  tenantId: string;          // brand: TenantId
  userId: string;
  membershipId: string;
  roles: string[];
  permissions: ReadonlySet<string>;
  requestId: string;
  actorType: 'user' | 'system' | 'worker';
};

declare const tenantContextBrand: unique symbol;
type TenantContext = { readonly [tenantContextBrand]: true; /* ... */ };
```

Repository functions accept `ctx: TenantContext` as their **first** parameter and
derive `tenantId` from it. A raw `PrismaClient` is not exported from
`packages/database`; only `withTenant(ctx)` and explicitly-named admin escape
hatches (`systemDb()`), each of which is greppable and reviewed in CI.

Defence in depth (all four layers required, per §6 of the master instruction):

1. **Type layer** — no API to query without a context.
2. **Repository layer** — every `where` includes `tenant_id`.
3. **Database layer** — `tenant_id` on every business table, composite FKs
   `(tenant_id, id)` so a child cannot reference a parent in another tenant.
4. **Test layer** — cross-tenant read/update/delete/assign attack suite.

---

## 6. Worker and Scheduler

```
apps/worker
  main.ts        → N BullMQ Worker instances (concurrency from env, default 2)
  scheduler.ts   → single loop, uses BullMQ repeatable jobs; guarded by a Redis lock
  queues/        → queue names + Zod payload schemas (single source of truth)
  processors/    → pure-ish handlers: load job record → validate tenant → call module
```

**DECIDED:** queue payloads contain identifiers only, never secrets and never an
authorization decision. The worker re-derives permissions from the persisted job
record (which stores the initiating user + tenant) instead of trusting the payload.

**DECIDED:** every job is idempotent. Each processor takes an `idempotencyKey`
derived from `(jobType, tenantId, natural key)`, recorded in `job_runs` with a
unique index. Re-delivery returns the prior result.

**DECIDED:** the scheduler is a module inside `apps/worker` guarded by a Redis
lock, not a third process — this halves memory use on the constrained host. Split
it out later only if lock contention is measured.

Job classes: `tiktok.sync.shops`, `tiktok.sync.orders`, `tiktok.sync.analytics`,
`outreach.batch.execute`, `outreach.quota.snapshot`, `analytics.snapshot.daily`,
`notification.dispatch`, `maintenance.cleanup`.

Retry policy: exponential backoff with jitter (base 5s, factor 2, cap 30 min,
max 6 attempts), plus a dead-letter queue inspected from the admin UI.

---

## 7. TikTok Integration Adapter

```
packages/integrations/tiktok
├── client.ts            HTTP client: signing, retry, timeout, request id capture
├── signing.ts           HMAC-SHA256 canonical string (pure, unit tested)
├── auth.ts              authorization URL builder, token exchange, refresh, revoke
├── capabilities.ts      Capability enum + registry: {available, reason, evidence}
├── endpoints/           one typed function per documented endpoint
├── errors.ts            TikTokErrorCode → normalized domain error
├── schemas/             Zod response validation (never trust upstream shapes)
└── mocks/               recorded-shape fixtures, explicitly labelled MOCK
```

**DECIDED — capability gating:** every feature that depends on TikTok asks
`capabilities.require('affiliate_orders_read')`. In `MOCK` mode the call returns
fixture data and the UI shows a persistent "MOCK DATA — not live" badge and a
banner naming the blocker. There is no code path where a seeded/mock response is
labelled live.

**DECIDED — strict endpoint discipline:** endpoints exist only for rows in
`03-TIKTOK-API-CAPABILITY-MATRIX.md` with a documented path, method, scope, and
version. No inferred paths, no invented fields, no scraping fallbacks, no browser
automation.

**DECIDED — token storage:** tokens live only in `tiktok_connections`, encrypted
with AES-256-GCM (see `04-SECURITY-PLAN.md`). They never reach the browser, never
enter a job payload, and never appear in logs or error messages.

---

## 8. Error Model

```ts
type AppError =
  | { kind: 'validation'; issues: ZodIssue[] }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden'; permission?: string }
  | { kind: 'not_found'; resource: string }        // also used for cross-tenant access
  | { kind: 'conflict'; reason: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'upstream'; service: 'tiktok'; code?: string; retriable: boolean }
  | { kind: 'internal'; incidentId: string };
```

Rules:

- Cross-tenant access returns `not_found`, never `forbidden` — prevents existence
  oracles.
- `internal` never returns stack traces or upstream bodies to the client; it logs a
  redacted record keyed by `incidentId`.
- Upstream TikTok error codes are mapped to a small enum; unknown codes are logged
  with the code+message only (no token, no full payload).

---

## 9. Observability

- **Structured logs**: pino JSON to stdout; fields `requestId`, `tenantId`,
  `userId`, `route`, `durationMs`, `outcome`.
- **Redaction**: a central denylist (`authorization`, `cookie`, `access_token`,
  `refresh_token`, `app_secret`, `password`, `token`, `sign`) plus value-pattern
  redaction for `TTP_…` tokens, applied at the logger, not at call sites.
- **Audit log** (database, not logs) for every mutation: actor, tenant, action,
  entity, before/after diff (redacted), IP hash, request id, timestamp.
- **Job runs**: every execution recorded with attempt, duration, outcome, error
  class.
- **Health**: `GET /api/health` (liveness, no DB) and `GET /api/health/ready`
  (DB + Redis, no secrets, admin-only detail).

No third-party APM/SaaS is introduced in Phase 1. If monitoring is wanted later,
select it explicitly rather than defaulting.

---

## 10. Deployment Topology (target)

```
Internet ──HTTPS──> nginx (TLS, HSTS, rate limit, request size cap)
                      ├── /            → web:3000
                      └── /api/tiktok/webhook → web:3000 (raw-body path)
                    mariadb:3306   (internal network only)
                    redis:6379     (internal network only, requirepass)
                    worker         (no ports)
                    scheduler      (in worker process)
```

- No database or Redis port published to the host in the production Compose file.
- Separate Compose override for development.
- Healthchecks on every service; `depends_on: condition: service_healthy`.
- Secrets from environment files that are git-ignored, mounted read-only, with
  `.env.example` committed containing names only.

**BLOCKED locally:** Docker is not installed, so the Compose file can be authored
and statically reviewed in Phase 1 but not executed here.

---

## 11. Decision Log

| ID | Decision | Rationale | Reversal cost |
|---|---|---|---|
| ADR-001 | Modular monolith + separate worker | Resource ceiling, single team, logical tenant isolation | High |
| ADR-002 | npm workspaces | npm installed, pnpm/yarn absent | Low |
| ADR-003 | First-party session auth (opaque token, DB-backed) instead of `next-auth` | No third-party churn in an auth-critical path; full control over session revocation and tenant binding; avoids Next 16 compatibility risk in a v4-era library | Medium |
| ADR-004 | Argon2id for passwords (`@node-rs/argon2`, prebuilt binaries) with `scrypt` fallback | Memory-hard; prebuilt avoids native compile on Node 26 | Low |
| ADR-005 | Tenant context as a branded type, first parameter of every repository call | Compile-time enforcement of the isolation rule | Medium (early is cheap) |
| ADR-006 | `CHAR(36)` UUIDv7 primary keys, app-generated; `VARCHAR(64)` for TikTok IDs | Readable, portable, composite-FK friendly; avoids binary-ID friction in Prisma/JS | Medium |
| ADR-007 | Forward-only Prisma migrations with backup-gated rollout | Prisma has no down migrations; rollback = restore or compensating migration | Low |
| ADR-008 | Capability registry gates every TikTok feature; mock mode is visible in the UI | Prevents accidental claims of live integration | Low |
| ADR-009 | Money as `DECIMAL(18,2)`, commission as integer basis points | Exact arithmetic; no floats for money | Low |

## 12. Open Points to Validate in Phase 1

| # | Point | Spike |
|---|---|---|
| V1 | Next 16.4.6 runs on Node 26.13.0 (dev + build) | Hello-world build, measure RSS and build time |
| V2 | Prisma 7.10.1 + MariaDB 11.8 (`provider = "mysql"`), including generator/engine defaults and migration engine behaviour | Create one model, migrate, query, inspect generated SQL |
| V3 | TypeScript major choice (7.x native port vs latest 5.x) against Next and Prisma types | Compile the spike app with both |
| V4 | Tailwind 4 CSS-first config with shadcn/ui | Render two components |
| V5 | Argon2id prebuilt binary availability on this platform | Hash/verify benchmark, target ≤ 250 ms |
| V6 | MariaDB account provisioning path (operator action) | See `PHASE-0-REPORT.md` blockers |
