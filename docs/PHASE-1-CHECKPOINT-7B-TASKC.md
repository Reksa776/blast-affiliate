# Task C — `withTenant()` + `systemDb()` + cross-tenant tests

**Status: DONE** — implemented, exported, and proven against the real database
(MariaDB 11.8.6, Prisma 7.10.1). Nothing is mocked; every query went through the
runtime account `affiliateos_app`, which is DML-only by grant.

Date: 2026-11-17

## Files

| File | Lines | Purpose |
|---|---|---|
| `packages/database/src/tenant-db.ts` | 256 | scoped client (`withTenant`), escape hatch (`systemDb`), model classification, error types |
| `packages/database/src/tenant-db.test.ts` | 194 | T1–T8 integration tests |
| `packages/database/src/index.ts` | edited | exports `withTenant`, `systemDb`, `tenantExtension`, the two error classes, `TenantScopedPrisma` |
| `.env.example` | edited | the three credentials and what each is allowed to do |

## Test result

```
✔ withTenant() / systemDb() (223.5ms)
  ✔ T1: findMany returns only the rows of the context tenant
  ✔ T2: update of another tenant's row is refused and changes nothing
  ✔ T3: delete of another tenant's row is refused and the row survives
  ✔ T4: create without a tenantId is refused before it reaches the database
  ✔ T5: create naming another tenant is refused
  ✔ T6: systemDb() is unscoped and sees both tenants
  ✔ T7: a forged context is rejected before any query
  ✔ T8: a platform model is refused with a named error

ℹ tests 28   ℹ pass 28   ℹ fail 0   ℹ skipped 0        exit 0
npm run typecheck                                     exit 0
```

**Count deviation:** the prompt expected 7 new tests (27 total). There are 8, so
28. T8 was added because "a model without `tenantId` must throw
`Model X is not tenant-scoped`" is a stated requirement with no numbered case;
leaving it untested would have meant shipping it unproven.

## How the scope is enforced

`withTenant(ctx, fn)` builds `prisma.$extends({ query: { $allModels: {
$allOperations } } })` and hands the result to `fn` as `TenantScopedPrisma`:

- **Reads and filters** (`findUnique`, `findFirst`, `findMany`, `count`,
  `aggregate`, `groupBy`, `update`, `updateMany`, `upsert`, `delete`,
  `deleteMany`, …) get `where: { …callerWhere, <scopeField>: ctx.tenantId }`.
  The scope is spread **last**, so `where: { tenantId: "B" }` cannot re-scope a
  query — the context always wins.
- **Creates** (`create`, `createMany`, `createManyAndReturn`) are rejected with
  `TenantWriteScopeError` when the tenant column is missing, blank, or names a
  different tenant. `upsert` is checked on both halves, because it can create.
- **Unclassified models and unknown operations fail closed** with
  `TenantModelAccessError`, so a future M2 model is a loud error rather than a
  silent unscoped read.
- `TenantScopedPrisma` omits the platform model delegates (`user`, `session`,
  `permission`, `platformAdminGrant`) and the raw-SQL escape hatches
  (`$queryRaw*`, `$executeRaw*`, `$runCommandRaw`), so a type-checked call site
  cannot reach them.

Model classification (all 13 M1 models, exhaustive):

| Scope field | Models |
|---|---|
| `tenantId` | `WorkspaceMember`, `WorkspaceInvitation`, `Role`, `RolePermission`, `MemberRole`, `AuditLog`, `BackgroundJob` |
| `id` | `Workspace` — the workspace *is* the tenant, so its key is `id` |
| refused | `User`, `Session`, `Permission`, `PlatformAdminGrant`, `BackgroundJobAttempt` |

`BackgroundJobAttempt` has no `tenant_id` (verified in the migration: `id`,
`job_id`, `attempt_number`, `status`, `started_at`, `finished_at`, `duration_ms`,
`error_class`, `error_summary`), so it is reachable only through its parent job.
The prompt's list of non-tenant models did not include it; adding it is the
fail-closed choice.

## Known limitations

1. **No per-test BEGIN → ROLLBACK.** Prisma 7's interactive transaction client is
   `Omit<DefaultPrismaClient, ITXClientDenyList>` with
   `denylist = ["$connect", "$disconnect", "$on", "$use", "$extends"]` (verified in
   `@prisma/client/runtime/client.d.ts:467`). `withTenant` builds its scoped client
   with `$extends` on the root client, so a scoped query cannot join an open
   transaction, and injecting a `tx` client is impossible without changing the
   API the task specified. Compensating control actually used: every mutation test
   asserts that the write is **refused**, the fixtures are deleted in `after()`,
   and `after()` asserts zero remaining rows. Independently verified after the run:
   `roles=0, workspaces=0, workspace_members=0, audit_logs=0, background_jobs=0`.
2. **Nested writes are not intercepted** (`create({ data: { …, permissions: {
   create: … } } })`). The composite FKs (`role_permissions(tenant_id, role_id) →
   roles(tenant_id, id)`) reject a cross-tenant nested row at the database, but a
   correct-tenant nested row is not validated by this layer.
3. **`$queryRaw`/`$executeRaw` exist at runtime** on the scoped client even though
   they are removed from the type; a cast can reach them. Raw SQL belongs to
   `systemDb()`, which is marked SYSTEM USE ONLY.
4. **`AuditLog.tenantId` is nullable.** A tenant context sees only rows whose
   `tenant_id` equals it, so platform-level audit rows (NULL) are invisible to
   tenants — intended, but it means `withTenant(auditLog).findMany()` is not "all
   audit rows for this tenant including system events".
5. **`campaign` cross-tenant test deferred to M4**, as agreed: the table does not
   exist yet (M1 has 13 tables).
6. The runtime account still has no grant on `_prisma_migrations`; irrelevant for
   these tests (Prisma Client does not read it at runtime) and correct by design.

## Tech Debt (tracked, not blocking)

| ID | Severity | Deskripsi | Target Fix |
|----|----------|-----------|------------|
| TD-7B-C1 | HIGH | Test T1–T8 tidak pakai BEGIN→ROLLBACK per test karena `$extends` tidak kompatibel dengan `TransactionClient` di Prisma 7. Kompensasi: cleanup di `after()` + assert nol baris. Risiko: residu kalau test crash di tengah, dan test paralel di CI akan saling ganggu. | Sebelum P1.2 (CI). Opsi: schema test terpisah, atau unique-prefix tenant ID per test. |
| TD-7B-C2 | LOW | Probe `taskC_probe` sempat menyisipkan 1 baris `audit_logs` karena `JSON.stringify` gagal pada BigInt. Sudah dihapus, `COUNT(*) = 0` terverifikasi. Root cause: tidak ada field `BigInt` di schema; angka `BigInt` berasal dari driver `mariadb` (bukan Prisma) yang memetakan `COUNT(*)`/`BIGINT` ke JS `BigInt` karena `bigIntAsNumber` default `false`. | Selesai (diverifikasi ulang 2026-11-17). |
| TD-7B-C3 | LOW | `$queryRaw` / `$executeRaw` hilang dari tipe `TenantScopedPrisma` tapi ada di runtime; cast masih bisa mencapainya. Raw SQL hanya untuk `systemDb()`. | Dokumentasi di P0.5 (auth) atau saat raw SQL pertama dipakai. |

### TD-7B-C2 — investigasi lengkap

`grep -n "BigInt" packages/database/prisma/schema.prisma` → **nol hasil**. Tidak ada
kolom `BigInt` di 40 model; Prisma sendiri mengembalikan `count()` sebagai `number`.

Error `Do not know how to serialize a BigInt` muncul di probe verifikasi Task B,
yang **tidak memakai Prisma**: ia memanggil driver `mariadb` langsung lalu mencetak
`JSON.stringify(rows)`. Driver memetakan hasil `COUNT(*)`/`BIGINT` ke JS `BigInt`
kecuali `bigIntAsNumber: true`
(`node_modules/mariadb/lib/config/connection-options.js:218`:
`this.bigIntAsNumber = Boolean(opts.bigIntAsNumber) || false;`). `JSON.stringify`
tidak punya serializer untuk `BigInt` → `TypeError`, yang lalu tertangkap blok
`catch` probe dan tampil seolah query gagal. Query-nya sendiri sukses, dan baris
probe ikut ter-insert. Perbaikannya di probe: `CAST(COUNT(*) AS CHAR)` (atau
`String(row.c)`). Kode aplikasi tidak terpengaruh.

## Environment notes (Langkah 1)

The test file loads the repository `.env` itself, through the existing
`loadRepoEnv()` helper, but only when `DATABASE_URL` is absent, and it imports
`tenant-db.js` **dynamically** afterwards. This matters because `client.ts` opens
its pool at module-evaluation time (`prisma:status` earlier in this task reported
`Database schema is up to date!`, exit 0). Consequence: `npm test` now needs a
reachable database, which is the intended contract for this file.

## Diff

Not committed. `git status --short` and `git diff --stat` were shown to the user
and the task stops for approval.
