# 05 — ROADMAP

> Phase 0 deliverable. Each phase starts only after the previous phase report is
> reviewed and **explicitly approved**. Nothing here authorizes Phase 1.

## Current implementation snapshot (2026-11-20)

| Area | Current state |
|---|---|
| Identity, workspace, RBAC, audit | Implemented in the existing app; see `PHASE-1-2-CLOSURE.md`. |
| Creator CRM | Local workflow implemented: create/list/search/filter, pipeline changes, profile notes, interaction notes, tags, assignment, blacklist, CSV import/export. The CRM migration is deployed to the current local database. |
| Campaign planning | Local workflow implemented: create/status, creator links, versioned briefs, manual batch invite preparation for up to 100 creators, and recorded failed attempts with manual retry. The campaign migrations are deployed to the current local database. Campaign shop label is manual text until a real shop connection exists. |
| Team onboarding | First account can create a workspace and become its owner. Invite tokens can create an account and activate membership; development UI exposes a one-time link for manual sharing. Production email delivery is still missing. |
| TikTok connection and live data | Not implemented. Partner Center approval and credentials are still prerequisites. |
| TikTok/WhatsApp/email message delivery, outreach queue/quota engine, analytics, production deployment | Not implemented. The campaign bulk invite tool creates personalized message text for manual sending and records success/failure reported by the operator; it cannot observe or retry external sends automatically. |

The current local database has all tracked migrations applied, the permission catalog seeded, and runtime grants verified for the new tables. Typecheck and a webpack production build pass. Automated test suites and production deployment have not been run.

---

## 0. Sequencing Principle

Build in this order: isolation → identity → access control → audit → external
integration → business features. Reason: every later feature inherits tenant scoping
from day one; retrofitting it is the single most expensive mistake available to this
project.

TikTok-dependent work is deliberately late and capability-gated, because approval may
never arrive. Everything before Phase 5 has standalone value without any TikTok
credential.

---

## 1. Phase Summary

| Phase | Theme | Hard dependency | Can start today? |
|---|---|---|---|
| 0 | Discovery & feasibility | — | Done (this report) |
| 1 | Foundation: monorepo, DB, auth, tenancy, RBAC, audit | Node/npm; MariaDB account; Redis for queue smoke test | Partially — see blockers |
| 2 | TikTok integration foundation | Partner Center app + approval for scopes; Redis; DB | No |
| 3 | Creator CRM | Phase 1 | No |
| 4 | Campaign management | Phase 3 | No |
| 5 | Outreach engine | Phase 4 **and** approved outreach-capable API + quota API | No |
| 6 | Analytics | Phase 2 (data source) + Phase 4 | No |
| 7 | Production hardening | All prior | No |

---

## 2. Phase 1 — Foundation

**Goal:** a running, tenant-isolated, RBAC-protected skeleton with audit, before any
business feature exists.

**In scope**
- npm workspaces monorepo per §2 of `01-ARCHITECTURE.md`; TypeScript project
  references; path aliases.
- Next.js 16 App Router app with: sign-in, sign-out, workspace switcher, member list,
  role assignment, audit log viewer (read-only), health endpoints.
- Prisma schema + baseline migration for the P1 tables in `02-DATABASE-DESIGN.md`.
- Session auth (ADR-003), Argon2id, CSRF, rate limiting, secure headers, redaction.
- Tenancy: `TenantContext`, `resolveTenantContext`, `withTenant`, composite FKs.
- RBAC: permission catalog, seeded roles, `requirePermission`, route-permission
  startup check.
- Audit logging for all P1 mutations.
- Worker skeleton + one trivial job (`maintenance.ping`) to prove BullMQ wiring.
- `docker-compose.yml` (authored, marked unexecuted on this host) + `.env.example`.
- Tests: unit (signing/password/redaction), integration (RBAC matrix, tenant attack
  suite), migration-from-zero test.

**Out of scope:** any TikTok call, any creator/campaign table, CSV import, UI polish
beyond functional.

**Exit criteria**
1. Fresh database → `migrate deploy` → app boots, `health/ready` 200.
2. A user in tenant A cannot read/update/delete any tenant-B row (test output
   recorded), for all P1 entities.
3. RBAC matrix test passes for all seeded roles.
4. Argon2id hash/verify measured and within budget.
5. `next build` succeeds on this host, run in isolation.
6. Phase report with actual command output.

**Known blockers to resolve first:** DB account + database creation; Redis install;
`git init` approval; package-manager choice confirmed (npm).

---

## 3. Phase 2 — TikTok Integration Foundation

**Goal:** a correct, auditable TikTok client and connection lifecycle — live **only**
where approval exists, mock everywhere else, with no ambiguity about which is which.

**In scope**
- HTTP client with signing, timeouts, retry/backoff, request-id capture, error mapping.
- OAuth: authorization URL builder, state issuance/consumption, code exchange, token
  refresh with skew, encrypted storage, deauthorization handling.
- `Get Authorized Shops` → `tiktok_connections` + `shops`; shop list UI.
- Capability registry with explicit `available | blocked | mock` states and reasons.
- `api_sync_logs`; webhook ingress with HMAC verification + `webhook_events` dedupe.
- Sync jobs: shop refresh; order sync only if the capability is approved.

**Exit criteria**
1. Signing passes the documented worked example (unit test) and a live call **if**
   credentials exist; otherwise recorded as BLOCKED.
2. OAuth round-trip completes against a real shop, or is explicitly BLOCKED with the
   exact missing prerequisite named.
3. Token encryption test: AAD swap fails; rotation round-trip passes.
4. UI cannot display mock data without the MOCK badge (test asserts the badge).
5. Webhook signature test: tampered body → 401, duplicate → deduped.

**Do not** implement any endpoint absent from
`03-TIKTOK-API-CAPABILITY-MATRIX.md` with a documented path.

---

## 4. Phase 3 — Creator CRM

**Scope:** creators, profiles, tags, notes, status pipeline, BD assignment, blacklist,
search/filter, CSV import (staged + validated + deduped) and export.

**Exit criteria:** tenant isolation extended to all CRM entities; CSV import is
idempotent and reports row-level errors; blacklisted creators cannot enter any
outreach selection; 10k-row list query has a measured `EXPLAIN` using the composite
index.

---

## 5. Phase 4 — Campaign Management

**Scope:** campaign CRUD, shop + product association, creator assignment, timeline,
briefs (versioned), assets, ad codes; read-only collaboration mirror from TikTok
where approved.

**Exit criteria:** campaign ↔ creator ↔ product association cannot cross tenants;
publishing to TikTok only via an approved capability, otherwise local-only campaign
with explicit "not synced" state.

---

## 6. Phase 5 — Outreach Engine

**Preconditions (all required):** approved write scopes, `Create Target Collaboration`,
quota API, eligibility API, and a written decision on messaging semantics. Without
them this phase does not start.

**Scope:** templates, eligibility check, per-level quota enforcement, batches,
duplicate prevention (weekly unique key), queue processing with rate shaping, result
tracking, retry policy that **never** retries `16024049`.

**Exit criteria:** dry-run mode produces a plan with zero API calls; live send is
idempotent; quota exhaustion is handled per level; audit records every send.

---

## 7. Phase 6 — Analytics

**Scope:** affiliate order ingestion, GMV reporting, creator/campaign/team
performance, snapshots with explicit metric definitions, CSV export.

**Exit criteria:** every displayed metric maps to a documented data source; no metric
is computed from mock data in a production build; reconciliation job compares our
totals against a TikTok-reported total and reports drift.

---

## 8. Phase 7 — Production Hardening

**Scope:** security audit, tenant isolation audit, E2E suite, performance test,
queue recovery drill, backup + restore verification, deployment documentation,
production readiness report.

**Exit criteria:** restore verified with checksums; queue drain/restart loses no job;
p95 latency recorded for key routes; every security control in
`04-SECURITY-PLAN.md` §4 has a recorded verification; residual risks listed.

---

## 9. Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Trigger to revisit |
|---|---|---|---|---|---|
| R1 | Affiliate API approval denied or delayed | Medium-High | High (Phases 2/5 blocked) | Capability-gated architecture; CRM/campaigns work without it; manual CSV path as fallback | Partner Center response |
| R2 | Indonesia-specific capability differs from global docs | Medium | High | Verify in Partner Center before Phase 2; keep endpoint layer swappable | Any doc/market discrepancy |
| R3 | Redis/Docker/DB never provisioned | Medium | High (Phase 1 partially blocked) | Deliver everything that does not need them; escalate as operator action | Start of Phase 1 |
| R4 | Node 26 / Prisma 7 / TypeScript 7 incompatibility | Medium | Medium | Phase 1 spikes V1–V3 before broad code | Spike results |
| R5 | Quota rules change again (already changed 2026-10) | High | Medium | Quota logic isolated in one module; snapshot + re-read before send; no hardcoded limits | Changelog review each phase |
| R6 | Endpoint versions sunset mid-build | Medium | Medium | Version pinned per endpoint with source + date; changelog check at phase start | Any 4xx/404 on previously working call |
| R7 | Scope creep into public SaaS (billing, registration) | Medium | Medium | Explicitly out of scope; tenant model leaves room | Product decision |
| R8 | 3.2 GiB RAM causes build/test thrash | High | Low-Medium | Serial checks, concurrency caps, no parallel builds | Observed OOM |
| R9 | Token leakage through logs | Low | High | Central redaction + test; no token in query strings we build | Any incident |
| R10 | Cross-tenant bug in a later module | Medium | High | Attack suite per phase; composite FKs; branded context type | Any new entity |

---

## 10. Approval Gates

| Gate | Requires |
|---|---|
| Start Phase 1 | Approval of `PHASE-0-REPORT.md`; operator action on DB/Redis/git |
| Start Phase 2 | Phase 1 PASS/PASS WITH LIMITATIONS; Partner Center app status known |
| Start Phase 5 | Written confirmation of outreach capability approval + quota rules for ID |
| Any destructive migration | Written approval + backup + rollback plan |
| Commit / push / deploy | Explicit approval each time |

No phase begins automatically. No commit is made without being asked.
