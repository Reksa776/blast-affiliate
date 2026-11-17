# 09 — MIGRATION PLAN

> Checkpoint 6C deliverable.
>
> **NOTHING IN THIS DOCUMENT HAS BEEN EXECUTED.** No migration folder exists, no
> table exists, and the two schemas are still empty. The first migration requires a
> new, explicit approval after this plan is reviewed.

---

## 1. Recommendation: staged domain migrations, not one 40-table baseline

| Option | Assessment |
|---|---|
| One 40-table baseline | Atomic and simple to reason about, but bundles Phase 2/3/5 decisions into the Phase 1 gate, makes review a 900-line wall, and forces capability-gated tables (shops, snapshots) to exist before their phase |
| **Five domain migrations (recommended)** | Each migration is reviewable, matches a phase gate, and keeps `docs/02` §5's "prove isolation before credentials exist" intent |

Chosen split — 40 tables total:

| # | Migration name | Tables | Count | Gate |
|---|---|---|---|---|
| M1 | `phase1_identity_tenancy_rbac` | `users`, `workspaces`, `workspace_members`, `workspace_invitations`, `sessions`, `permissions`, `roles`, `role_permissions`, `member_roles`, `platform_admin_grants`, `audit_logs`, `background_jobs`, `background_job_attempts` | 13 | Phase 1 auth work — **first approval** |
| M2 | `phase2_shop_connections` | `shop_connections`, `shops`, `shop_sync_states`, `oauth_states`, `webhook_events` | 5 | Phase 2, after Partner Center approval |
| M3 | `phase3_creator_crm` | `creators`, `creator_profiles`, `creator_assignments`, `creator_activities`, `creator_status_histories`, `creator_tags`, `creator_tag_assignments`, `creator_notes`, `creator_blacklists` | 9 | Phase 3 |
| M4 | `phase4_campaigns` | `campaigns`, `campaign_shops`, `campaign_creators`, `campaign_contents`, `campaign_ad_codes`, `campaign_status_histories` | 6 | Phase 4 (needs M2 + M3) |
| M5 | `phase6_analytics_notifications` | `sync_runs`, `sync_errors`, `creator_performance_snapshots`, `campaign_performance_snapshots`, `shop_performance_snapshots`, `notifications`, `notification_read_states` | 7 | Phase 6 |

M1 is the only migration Phase 1 needs: authentication, tenant resolution, RBAC,
audit, and the job envelope. Nothing in M1 depends on TikTok.

Why not "one table per migration": 40 migrations of one table each make FK ordering
the dominant risk and multiply the failure surface, with no review benefit.

---

## 2. Creation Order (per migration)

Order is parents before children; Prisma emits `CREATE TABLE` then
`ALTER TABLE … ADD CONSTRAINT`, so FKs never block creation.

**M1**

```
users → workspaces → workspace_members → workspace_invitations
      → permissions → roles → role_permissions → member_roles
      → platform_admin_grants → sessions
      → audit_logs (no FK) → background_jobs → background_job_attempts
```

**M2**: `shop_connections` → `shops` → `shop_sync_states` → `oauth_states` →
`webhook_events`

**M3**: `creators` → `creator_profiles` → `creator_assignments` →
`creator_activities` → `creator_status_histories` → `creator_tags` →
`creator_tag_assignments` → `creator_notes` → `creator_blacklists`

**M4**: `campaigns` → `campaign_shops` → `campaign_creators` →
`campaign_contents` → `campaign_ad_codes` → `campaign_status_histories`

**M5**: `sync_runs` → `sync_errors` → `creator_performance_snapshots` →
`campaign_performance_snapshots` → `shop_performance_snapshots` →
`notifications` → `notification_read_states`

---

## 3. Constraint Summary (from the offline diff)

| Kind | Count |
|---|---|
| `CREATE TABLE` | 40 |
| `FOREIGN KEY` | 74 |
| `UNIQUE INDEX` | 51 |
| non-unique `INDEX` | 35 |
| DDL lines | 917 |

Key composite constraints, verbatim shape:

```sql
ALTER TABLE `campaign_shops`
  ADD CONSTRAINT `campaign_shops_tenant_id_shop_id_fkey`
  FOREIGN KEY (`tenant_id`, `shop_id`) REFERENCES `shops`(`tenant_id`, `id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `role_permissions`
  ADD CONSTRAINT `role_permissions_tenant_id_role_id_fkey`
  FOREIGN KEY (`tenant_id`, `role_id`) REFERENCES `roles`(`tenant_id`, `id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
```

Defaults and types: `CHAR(36)` ids with no default, `DATETIME(3)` with
`CURRENT_TIMESTAMP(3)` for `created_at`, native `ENUM` for every status,
`DECIMAL(18,2)` for money, `BINARY(32)` for hashes, `JSON` for payloads.
`updated_at` is client-maintained (`@updatedAt`), so the DDL has no DB default —
expected, not a defect.

---

## 4. Locking and Execution Considerations

| Concern | Plan |
|---|---|
| Metadata locks | All `ALTER TABLE … ADD CONSTRAINT` run against **empty** tables: instant, no table rebuild |
| Concurrent DDL | `migrate deploy` runs as a one-shot job **before** web/worker start; never from an app entrypoint |
| Lock wait | Set `SET SESSION lock_wait_timeout = 10` in the migration job (server default is 86400s — a hung DDL would stall the deploy for a day) |
| Long transaction | Migration runs outside business hours even at zero rows, so the habit is established |
| Rollback of a failed migration | Prisma marks it failed; fix forward or restore (§6). Never edit an applied migration |
| Zero-downtime expectation | None in Phase 1 (internal tool, maintenance window allowed) |
| `foreign_key_checks` | Never disabled, in any environment |

---

## 5. Shadow Database Validation

`prisma.config.ts` already points `shadowDatabaseUrl` at `affiliateos_shadow`
(exists, empty, `utf8mb4_unicode_ci`, DDL rights confirmed in 6B).

- `prisma migrate dev` replays all committed migrations against the shadow database
  before authoring a new one; a migration that only works on a populated database
  fails there.
- CI must run "migrate from zero" against a fresh MariaDB 11.8 service, then
  `prisma migrate status`.
- The shadow database is **not** a scratch pad: no experimental DDL, no manual
  tables. It is recreated by Prisma per migration run.
- In 6C the shadow database was **not touched** (forbidden without authorization).

---

## 6. Rollback Strategy

Prisma has no down migrations (ADR-007), so rollback is chosen per migration before
authoring it.

| Migration | Rollback while database is empty | Rollback once data exists |
|---|---|---|
| M1 | Drop M1 tables in reverse dependency order (requires written approval) | Restore pre-migration dump; drop-and-recreate only if the data is disposable |
| M2–M5 | Same, per migration | Restore dump, or a compensating migration that drops the added tables (data loss, needs approval) |

Reverse drop order for M1:

```
background_job_attempts → background_jobs → audit_logs → sessions
→ platform_admin_grants → member_roles → role_permissions → roles
→ permissions → workspace_invitations → workspace_members → workspaces → users
```

Rules:

1. Never roll back by mutating an applied migration file.
2. A rollback that drops a table with rows requires an explicit written approval and
   a verified backup taken **before** the migration.
3. Compensating migrations are preferred for additive changes; destructive changes
   are restored, not "fixed" in place.
4. Rollback rehearsal happens on a scratch schema, never on `affiliateos`.

---

## 7. Recovery Plan

| Step | Command / action | Evidence required |
|---|---|---|
| 1. Pre-migration dump | `mariadb-dump --single-transaction --routines --triggers --events <schema> \| gzip \| age -r <key>` | File size + sha256 recorded |
| 2. Baseline counts | row counts per table before | Stored in the change record |
| 3. Apply | `prisma migrate deploy` with the DDL credential | Exit code + migration name + duration |
| 4. Verify | `prisma migrate status`; `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='affiliateos'` | Expected table count per migration |
| 5. Smoke | `/api/health` 200 through the app credential | HTTP status, no DB detail in response |
| 6. Failure | stop deploy, restore dump into a scratch schema, verify checksums, then decide | Written incident note |

RPO/RTO targets are Phase 7 concerns; what matters here is that a dump exists and has
been restored at least once before production (a backup that was never restored is
not a backup).

---

## 8. Draft SQL — Header Convention

If a draft is ever written to disk, it goes in `docs/sql/` (never
`prisma/migrations`), and its first line must be exactly:

```
DRAFT ONLY — NOT EXECUTED — REQUIRES EXPLICIT APPROVAL
```

No script, CI job, or npm script may execute a file from `docs/sql/`. The only
sanctioned execution path is `prisma migrate deploy` on a committed migration under
`prisma/migrations`, after approval.

Illustrative excerpt (generated offline in 6C, then deleted; reproduced here for
review only):

```sql
DRAFT ONLY — NOT EXECUTED — REQUIRES EXPLICIT APPROVAL
-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(120) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

---

## 9. Prerequisites Before the First Migration

1. **Explicit approval** of the 6C report and of M1 specifically.
2. Decision on F-6C-3 (DDL credential = runtime credential). Recommended: create
   `affiliateos_migrate` (DDL) and `affiliateos_app` (DML only, no DDL, no
   `UPDATE`/`DELETE` on `audit_logs`) before M1 runs, so the grant model is right
   from the first table.
3. A verified dump (even of an empty schema, to prove the restore path).
4. Confirmation that `affiliateos_shadow` may be recreated by Prisma.
5. A maintenance window and the one-shot migration job definition.

## 10. Post-Migration Verification (future, not executed)

```
prisma migrate status                 → up to date
SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'affiliateos'
SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = 'affiliateos'          → composite FKs present
SHOW TABLE STATUS                                  → InnoDB, utf8mb4_unicode_ci
/api/health                                        → 200 {"status":"ok"}
cross-tenant insert attempt                        → 1452 (composite FK rejects)
```

The last line is the acceptance test for the isolation design: it must be run against
a scratch schema with two workspaces seeded, never against production data.
