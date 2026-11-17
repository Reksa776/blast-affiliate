# PHASE 2 — WORKSPACE & MEMBER MANAGEMENT

**Tanggal:** 2026-11-17
**Repo:** `/home/reksa/affiliateos` (branch `main`)
**HEAD saat verifikasi:** `05cb987` — `feat(worker): placeholder worker + dev stack (P1.1)`
**Basis:** `docs/PHASE-1-CLOSURE.md` dan
`docs/PHASE-1-CHECKPOINT-7F-CROSSTENANT.md`
**Scope:** checklist Phase 2 item 2.1–2.7 (workspace/member management lengkap).
**Metode:** implementasi + test integrasi terhadap `next dev` dan database test,
lalu `typecheck`, `prisma validate`, dan `next build`. Tidak ada commit/push.

> Dokumen ini memisahkan **yang terverifikasi** dari **yang tidak diklaim**. Setiap
> item yang dicentang punya file dan test pendukung. Tech debt baru diberi ID
> `TD-8-Rn` dan dialokasikan; tidak ada yang disembunyikan.

---

## 1. Status akhir

**DONE WITH NOTES** untuk scope checklist 2.1–2.7.

Seluruh tujuh item diimplementasikan dan diverifikasi oleh test otomatis:

- daftar workspace + daftar member (GET) dengan isolasi cross-tenant;
- accept-invitation end-to-end (valid / salah / kedaluwarsa / dipakai ulang);
- readiness probe yang memeriksa katalog permission;
- rate limit per-user pada mutasi workspace;
- semantik `withTenant()` untuk `Workspace` (TD-7F-R3) didokumentasikan;
- schema + migration terpisah untuk office settings;
- API + halaman office settings dengan validasi dan audit.

Catatan yang membuat status **bukan** `DONE` polos:

1. **Token undangan bertahan hanya lewat echo khusus non-production
   (`devToken`)**. Belum ada mail transport, jadi di produksi pengguna tidak akan
   menerima token sampai transport dibuat (TD-8-R3). Item 2.2 lulus test, tetapi
   "accept-invitation bisa dipakai pengguna nyata" bergantung pada TD-8-R3.
2. **Halaman admin belum punya automated UI test.** Halaman dikompilasi oleh
   `next build` dan memakai jalur otorisasi yang sama dengan API, tetapi tidak ada
   test browser/komponen (TD-8-R6).
3. **Belum ada UI ubah role.** Perubahan role hanya lewat API
   `PATCH …/members/:memberId/role` (TD-8-R7).
4. **Rate limiter tetap per-process**, bukan distributed. Ini mewarisi TD-7C-A1;
   bucket per-user hanya membuatnya bermakna per instance (TD-8-R4).
5. **Jam kerja office hanya disimpan, belum ditafsirkan.** Tidak ada shift,
   hari libur, atau perhitungan terlambat — itu Phase 3 (TD-8-R5).
6. **Accept-invitation bukan satu transaksi.** Aktivasi membership dan konsumsi
   undangan adalah dua statement (TD-8-R2), dengan urutan yang dipilih agar
   kegagalan lebih mudah dipulihkan.
7. **Daftar workspace berbasis membership.** Platform admin tanpa membership
   melihat daftar kosong (TD-8-R8); ini konsekuensi kontrak "hanya workspace dengan
   membership ACTIVE".

Tidak ada item Phase 3+ (GPS, foto, geofence, revisi kehadiran, dashboard,
notifikasi) yang dikerjakan. Tidak ada phase yang di-rename atau di-renumber.

---

## 2. Checklist 2.1–2.7 + bukti

Legenda: `[x]` = ada file + test; `[~]` = ada file + build, tetapi bukti test
terbatas pada yang disebutkan.

### [x] 2.1 Daftar workspace dan daftar member (GET) + halaman

**Implementasi**

- `apps/web/src/app/api/workspaces/route.ts` — `GET /api/workspaces`.
  Membership discovery lewat `systemDb()` (SYSTEM: harus jalan sebelum tenant
  diketahui), lalu setiap baris workspace + role dibaca lewat `withTenant()`.
  Hanya membership `ACTIVE`.
- `apps/web/src/app/api/workspaces/[workspaceId]/members/route.ts` — `GET` daftar
  member. Gate `member.read`; workspace/member dibaca lewat `withTenant()`.
- `apps/web/src/lib/workspaces/data.ts` — `listWorkspacesForUser()`,
  `listWorkspaceMembers()`, `readOfficeSettings()`,
  `tenantContextForWorkspace()`; dipakai bersama oleh API dan halaman.
- `apps/web/src/app/workspaces/page.tsx` — daftar workspace.
- `apps/web/src/app/workspaces/[workspaceId]/members/page.tsx` — tabel member +
  form undang (`apps/web/src/components/invite-member-form.tsx`).
- `apps/web/src/lib/auth/page-auth.ts` — `requirePageAuth()` /
  `requirePagePermission()` memakai `requireAuth`/`requirePermission` yang sama
  dengan API, melalui cookie jar `next/headers`.
- `apps/web/src/app/page.tsx` — tautan ke `/workspaces`.

**Bukti test** (`cross-tenant.test.ts`)

```
✔ T11: GET /api/workspaces hanya mengembalikan workspace milik A
✔ T12: GET member A↔B terisolasi, dan workspace asing identik dengan yang tidak ada
```

T11: A hanya melihat workspace A (dengan `membershipId` dan role yang benar), B
hanya melihat workspace B, tanpa session → 401.
T12: daftar member A tidak memuat user B; `GET` member workspace B oleh A → 403
dengan body **identik** dengan workspace yang tidak ada (tidak ada existence
oracle); B tetap bisa membaca daftarnya sendiri.

### [x] 2.2 Accept invitation + token survival

**Implementasi**

- `apps/web/src/app/api/invitations/accept/route.ts` —
  `POST /api/invitations/accept`.
  - Token mentah dari body di-hash SHA-256 dan dicari lewat `token_hash`
    (`systemDb`, SYSTEM: pencarian ini yang menetapkan tenant).
  - Status harus `PENDING`, `expiresAt > now`, dan email session harus sama
    (case-insensitive) dengan email undangan.
  - Membership yang belum ada dibuat `ACTIVE`; membership `INVITED` diaktifkan;
    role undangan di-assign; undangan ditandai `ACCEPTED` + `acceptedAt` +
    `acceptedByUserId`; satu audit `member.accept_invite` ditulis dengan
    `tenant_id` workspace.
  - Token/hash **tidak** masuk audit metadata.
- `apps/web/src/app/api/workspaces/[workspaceId]/members/route.ts` — respons
  invite menyertakan `devToken`/`devTokenOnly` **hanya bila
  `NODE_ENV !== "production"`**. Di produksi field itu tidak ada. Ini kompensasi
  sementara untuk tidak adanya mail transport (TD-8-R3).
- Invitation TTL 7 hari (`INVITATION_TTL_MS`).

**Bukti test** (`accept-invitation.test.ts`, 5 test)

```
✔ token salah ditolak 400 dan tidak membuat membership
✔ email session tidak cocok dengan invitation → 403
✔ token valid mengaktifkan membership ACTIVE + role + audit
✔ token kedaluwarsa ditolak 400 dan tidak membuat membership
✔ token yang sudah dipakai tidak bisa dipakai ulang
```

Test valid memeriksa: membership `ACTIVE`, `joinedAt` terisi, role `ANALYST`,
invitation `ACCEPTED` + `acceptedByUserId`, tepat satu baris audit
`member.accept_invite` dengan `tenant_id` non-null, `actor_user_id` +
`actor_member_id` benar, `resource_id` = invitation, `metadata = { email, roleKey }`,
tidak memuat token, dan `ip_hash` = SHA-256 32 byte dari IP.

### [x] 2.3 Readiness probe (menutup TD-7F-R2)

**Implementasi**

- `apps/web/src/app/api/health/ready/route.ts` — `GET /api/health/ready`.
  - `200 { status:"ready", database:"up", permissionCatalog:{expected:27, actual:27,
    missing:[]}, reasons:[] }`
  - `503 { status:"not_ready", … missing:[…], reasons:["permission_catalog_incomplete"] }`
  - `503` juga saat database tidak terjangkau (`reasons:["database_unreachable"]`).
  - Tidak membocorkan URL/kredensial/driver error; hanya key permission yang
    hilang.

**Bukti test** (`readiness.test.ts`, 3 test)

```
✔ katalog lengkap → 200 ready dengan 27 permission
✔ katalog kosong → 503 not_ready yang menyebut katalog tidak lengkap
✔ setelah katalog di-seed ulang → 200 ready kembali
```

Test katalog kosong menghapus `permission` + `role_permission` (SYSTEM: simulasi
database setengah ter-provision), memastikan 503 dan `missing.length === 27`, lalu
menjalankan `seedPermissionCatalog()` dan memastikan 200 kembali.

### [x] 2.4 Rate limit per-user pada mutasi workspace (menutup TD-7F-R5)

**Implementasi**

- `apps/web/src/lib/auth/rate-limit.ts` — `consumeRateLimit()` mengembalikan
  `{ allowed, limit, remaining, retryAfterSeconds }`; `checkRateLimit()` tetap
  sebagai bentuk boolean untuk login/register. Limit non-positif fail-closed.
- `apps/web/src/lib/auth/workspace-rate-limit.ts` — bucket bersama
  `workspace-mutation:<userId>` untuk create workspace, invite, ubah role, dan
  PATCH office. Default 60/menit; override `WORKSPACE_RATE_LIMIT_MAX` dan
  `WORKSPACE_RATE_LIMIT_WINDOW_MS`.
- Route yang memakai: `POST /api/workspaces`, `POST …/members`,
  `PATCH …/members/:memberId/role`, `PATCH …/office`.
- Respons `429 { error:"Too many requests" }` + header `Retry-After` (detik ≥ 1).

**Bukti test**

`workspace-rate-limit.test.ts` (server dijalankan dengan limit 2/60 detik):

```
✔ dua create pertama lolos, create ketiga → 429 + Retry-After
✔ bucket dipakai bersama oleh invite pada user yang sama → 429
✔ user lain memiliki bucket sendiri → 201
```

Test juga memastikan request yang ditolak tidak mem-provision workspace ketiga
dan tidak membuat invitation. `rate-limit.test.ts` menambah:

```
✔ consumeRateLimit melaporkan remaining dan Retry-After
✔ limit non-positif menolak semua permintaan (fail-closed)
```

### [x] 2.5 Semantik `withTenant()` pada `Workspace` (menutup TD-7F-R3)

**Masalah:** `Workspace` adalah tenant itu sendiri, sehingga scope field = row key
(`id`). `withTenant()` menempelkan scope **terakhir** ke `where`, jadi `where.id`
asing **diganti** oleh `ctx.tenantId`, bukan dipersempit.

**Sifat yang dijamin:** tetap fail-closed — baris workspace asing tidak pernah
dikembalikan. Yang berubah hanya bentuk hasilnya: query bisa mengembalikan
workspace milik context (bila ada) atau `null`, bukan `null` secara otomatis untuk
id asing.

**Dokumentasi kode**

- `packages/database/src/tenant-db.ts` — komentar `TenantScopeField` dan
  `scopeQueryArgs` menjelaskan penggantian ini beserta alasannya.
- `packages/database/src/tenancy.ts` — komentar `tenantScope()` memperingatkan agar
  id diotorisasi dulu (`requirePermission`) sebelum `findFirst({ where: { id } })`.
- `apps/web/src/lib/workspaces/data.ts` — pengingat yang sama di header modul.

**Bukti test:** `cross-tenant.test.ts` T7 (`withTenant(ctxA).workspace` hanya
melihat workspace A) dan T11/T12 untuk jalur HTTP. Perilaku tidak diubah; hanya
didokumentasikan, sesuai keputusan bahwa "memperbaiki" urutan spread justru akan
membuka kebocoran lintas tenant.

### [x] 2.6 Schema + migration office settings (terpisah, terdokumentasi)

**Schema** (`packages/database/prisma/schema.prisma`, model `Workspace`):

| Kolom | Tipe | Null | Default |
|---|---|---|---|
| `address` | `VARCHAR(255)` | ya | — |
| `timezone` | `VARCHAR(64)` | tidak | `Asia/Jakarta` |
| `work_start` | `CHAR(5)` | tidak | `09:00` |
| `work_end` | `CHAR(5)` | tidak | `17:00` |

**Migration terpisah:**
`packages/database/prisma/migrations/20261117120000_p2_office_settings/migration.sql`

```sql
ALTER TABLE `workspaces`
    ADD COLUMN `address` VARCHAR(255) NULL,
    ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
    ADD COLUMN `work_start` CHAR(5) NOT NULL DEFAULT '09:00',
    ADD COLUMN `work_end` CHAR(5) NOT NULL DEFAULT '17:00';
```

**Alasan migration terpisah:** hanya empat kolom yang benar-benar dibutuhkan item
2.7. Migration tidak menyentuh 26 model fase lanjut yang sudah dideklarasikan di
schema. Rollback terdokumentasi di header file (DROP keempat kolom).

**Penerapan:** `prisma migrate deploy` dijalankan pada database dev
(`affiliateos`) **dan** database test (`affiliateos_test`). Keduanya melaporkan
"All migrations have been successfully applied." Baris lama menerima default,
tidak perlu backfill.

### [x] 2.7 API + halaman office settings, validasi, audit

**Implementasi**

- `apps/web/src/app/api/workspaces/[workspaceId]/office/route.ts` —
  `GET` (gate `workspace.read`) dan `PATCH` (gate `workspace.manage`),
  keduanya lewat `withTenant()` dan CSRF untuk PATCH.
  - Field: `name`, `address` (≤255, string kosong → `null`), `timezone` (IANA,
    divalidasi `Intl.DateTimeFormat`), `workStart`/`workEnd` (`HH:MM` 24 jam).
  - Body tanpa field yang didukung → 400; validasi gagal → 400 dan baris tidak
    berubah.
  - No-op PATCH → 200 tanpa audit.
  - Perubahan nyata → satu audit `workspace.update_office` dengan
    `metadata { fields, from, to }` dan `tenant_id` workspace.
  - Workspace asing dan workspace tidak ada sama-sama 403 lewat
    `requirePermission` (bukan existence oracle).
- `apps/web/src/app/workspaces/[workspaceId]/office/page.tsx` — tampilan/editor;
  form hanya dirender bila pemegang `workspace.manage`.
- `apps/web/src/components/office-settings-form.tsx` — PATCH dengan CSRF
  double-submit.

**Bukti test** (`office-settings.test.ts`, 6 test)

```
✔ GET mengembalikan nilai default untuk workspace baru
✔ PATCH valid menyimpan ke tenant yang benar dan menulis audit from/to
✔ validasi menolak timezone, jam, nama dan alamat yang tidak sah
✔ PATCH tanpa field yang didukung → 400
✔ PATCH tanpa perubahan → 200 tanpa audit baru
✔ workspace asing dan workspace tidak ada memberi 403 yang identik
```

Test PATCH valid memeriksa baris database berubah tepat di workspace itu, audit
bertambah satu dengan `resources/from/to` lengkap, `actor_user_id` +
`actor_member_id` benar, dan `request_id` dari header. Test validasi mencoba
`Mars/Olympus`, `25:00`, `17:60`, nama kosong, dan alamat 256 karakter — semuanya
400 dan baris tetap pada nilai sebelumnya.

---

## 3. Penutupan TD-7F-R1 s/d R5

| ID | Status Phase 1 | Status Phase 2 | Bukti penutupan |
|---|---|---|---|
| TD-7F-R1 | open | **RESOLVED** | `POST /api/invitations/accept` + `devToken` non-production; `accept-invitation.test.ts` (valid, salah, expired, reused, email mismatch, audit). Catatan: transport produksi = TD-8-R3. |
| TD-7F-R2 | open | **RESOLVED** | `GET /api/health/ready` memeriksa `SELECT 1` + 27 permission; `readiness.test.ts` (200 lengkap / 503 kosong / pulih setelah seed). |
| TD-7F-R3 | open | **RESOLVED (didokumentasikan)** | Komentar eksplisit di `tenant-db.ts`, `tenancy.ts`, `workspaces/data.ts`; perilaku tetap fail-closed dan diuji T7/T11/T12. Tidak ada perubahan perilaku. |
| TD-7F-R4 | open | **RESOLVED** | `GET /api/workspaces` dan `GET …/members`; `cross-tenant.test.ts` T11/T12; halaman `/workspaces` dan `/workspaces/:id/members`. |
| TD-7F-R5 | open | **RESOLVED** | `workspaceMutationRateLimit()` pada empat route mutasi; `workspace-rate-limit.test.ts` (201,201,429 + `Retry-After`, bucket per user, bucket bersama). Catatan: tetap per-process = TD-8-R4. |

Tidak ada TD-7F yang ditutup tanpa test atau hanya dengan komentar, kecuali R3
yang memang keputusannya adalah dokumentasi (perilakunya sudah fail-closed dan
sudah diuji).

---

## 4. Tech debt baru — TD-8-Rn

| ID | Severity | Ringkasan | Alokasi |
|---|---|---|---|
| TD-8-R1 | MEDIUM | `listWorkspacesForUser()` melakukan satu `withTenant` per membership (N+1). Untuk pengguna dengan banyak workspace, daftar menjadi lambat. Tidak ada query lintas-tenant yang bisa menggantikannya tanpa melanggar isolation, jadi perbaikan butuh desain khusus (mis. RPC/read model). | Phase 3 (skala) |
| TD-8-R2 | MEDIUM | Accept-invitation melakukan aktivasi membership dan konsumsi undangan sebagai dua statement, bukan satu transaksi. Urutan dipilih agar crash menyisakan membership ACTIVE + invitation PENDING (pulih dengan accept ulang), bukan invitation ACCEPTED tanpa membership. | Phase 3 (hardening) |
| TD-8-R3 | **HIGH** | `devToken` hanya ada di `NODE_ENV !== "production"`. Belum ada mail transport, jadi undangan tidak dapat diterima pengguna nyata di produksi. Wajib diganti pengiriman email sebelum deploy produksi. | Phase 3 (blocking produksi) |
| TD-8-R4 | MEDIUM | Rate limit workspace tetap in-memory per proses (mewarisi TD-7C-A1). Multi-instance melipatgandakan limit efektif; restart menghapus counter. | P1.3 (Redis) |
| TD-8-R5 | LOW | `workStart`/`workEnd` disimpan sebagai jam dinding tanpa semantik shift, hari libur, toleransi, atau perhitungan terlambat. | Phase 3 (absensi) |
| TD-8-R6 | MEDIUM | Halaman admin (`/workspaces`, `/members`, `/office`) belum punya automated UI/component test. Yang ada: build + test API. | Phase 3 (E2E/UI) |
| TD-8-R7 | LOW | Belum ada UI ubah role; hanya API `PATCH …/role`. Halaman member secara eksplisit tidak menduplikasi mutasi. | Phase 3 (UI) |
| TD-8-R8 | LOW | `GET /api/workspaces` hanya mengembalikan workspace dengan membership ACTIVE, sehingga platform admin tanpa membership melihat daftar kosong. Perlu jalur "platform admin melihat semua" bila dibutuhkan. | Phase 3 (ops) |

Tidak ada TD-7C-A1, TD-7E-R4, atau tech debt Phase 1 lain yang dibuka kembali.

---

## 5. Hasil verifikasi (output nyata)

Semua perintah dijalankan dari `/home/reksa/affiliateos`. Log disimpan sementara di
`/tmp/opencode/phase2/` (tidak di-commit).

### 5.1 `npm test --workspace @affiliateos/web`

```
ℹ tests 270
ℹ suites 12
ℹ pass 270
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53783.379897
```

**EXIT=0.** Suite baru yang berjalan: `GET /api/health/ready`,
`accept invitation`, `office settings`, `rate limit per-user pada route workspace`;
suite lama `cross-tenant E2E`, `audit trail dari route workspace`, auth, RBAC,
session, CSRF, dan security headers tetap lulus.

### 5.2 `npm test` (permissions + database)

```
@affiliateos/permissions: ℹ tests 10  ℹ pass 10  ℹ fail 0
@affiliateos/database:    ℹ tests 46  ℹ suites 4  ℹ pass 46  ℹ fail 0
```

**EXIT=0.**

### 5.3 `npm run typecheck`

`permissions`, `database` (termasuk `prisma generate`), `web`, dan `worker`
selesai tanpa error.

**EXIT=0.**

### 5.4 `npx prisma validate --schema packages/database/prisma/schema.prisma`

```
Prisma schema loaded from packages/database/prisma/schema.prisma.
The schema at packages/database/prisma/schema.prisma is valid 🚀
```

**EXIT=0.**

### 5.5 `npm run build --workspace @affiliateos/web`

```
✓ Compiled successfully in 3.9s
Route (app)
├ ƒ /api/health/ready
├ ƒ /api/invitations/accept
├ ƒ /api/workspaces
├ ƒ /api/workspaces/[workspaceId]/members
├ ƒ /api/workspaces/[workspaceId]/members/[memberId]/role
├ ƒ /api/workspaces/[workspaceId]/office
├ ƒ /workspaces
├ ƒ /workspaces/[workspaceId]/members
└ ƒ /workspaces/[workspaceId]/office
```

### 5.6 Database test

`TEST_DATABASE_URL` menunjuk ke `affiliateos_test` (bukan `affiliateos`). Test
integrasi men-spawn `next dev` nyata pada port 3419 (cross-tenant), 3420
(workspace audit), 3421 (accept), 3422 (readiness), 3423 (rate limit), dan 3424
(office), lalu men-truncate tabel M1 sebelum/sesudah lewat lock database test.

---

## 6. File yang ditambah/diubah

**Baru**

```
apps/web/src/app/api/health/ready/route.ts
apps/web/src/app/api/health/__tests__/readiness.test.ts
apps/web/src/app/api/invitations/accept/route.ts
apps/web/src/app/api/invitations/__tests__/accept-invitation.test.ts
apps/web/src/app/api/workspaces/[workspaceId]/office/route.ts
apps/web/src/app/api/workspaces/__tests__/office-settings.test.ts
apps/web/src/app/api/workspaces/__tests__/workspace-rate-limit.test.ts
apps/web/src/app/workspaces/page.tsx
apps/web/src/app/workspaces/[workspaceId]/members/page.tsx
apps/web/src/app/workspaces/[workspaceId]/office/page.tsx
apps/web/src/components/invite-member-form.tsx
apps/web/src/components/office-settings-form.tsx
apps/web/src/lib/auth/page-auth.ts
apps/web/src/lib/auth/workspace-rate-limit.ts
apps/web/src/lib/workspaces/data.ts
packages/database/prisma/migrations/20261117120000_p2_office_settings/migration.sql
```

**Diubah**

```
apps/web/src/app/api/workspaces/route.ts                              (GET + rate limit)
apps/web/src/app/api/workspaces/[workspaceId]/members/route.ts       (GET + rate limit + dev echo)
apps/web/src/app/api/workspaces/[workspaceId]/members/[memberId]/role/route.ts  (rate limit)
apps/web/src/app/api/workspaces/__tests__/cross-tenant.test.ts        (T11, T12)
apps/web/src/lib/auth/rate-limit.ts                                   (consumeRateLimit)
apps/web/src/lib/auth/rate-limit.test.ts                              (test baru)
apps/web/src/lib/auth/middleware.ts                                   (SessionCookieRequest)
apps/web/src/lib/auth/permission.ts                                   (SessionCookieRequest)
apps/web/src/app/page.tsx                                             (tautan /workspaces)
apps/web/package.json                                                 (registrasi test — juga memuat entri security-headers milik user)
packages/database/prisma/schema.prisma                                (4 kolom office)
packages/database/src/tenant-db.ts                                    (dokumentasi TD-7F-R3)
packages/database/src/tenancy.ts                                      (dokumentasi TD-7F-R3)
```

**Tidak disentuh:** file untracked milik user (`docs/AUDIT-PHASE-1-2026-11-17.md`,
`docs/PHASE-1-CHECKPOINT-8B-BUILDFIX.md`, `apps/web/AGENTS.md`,
`apps/web/src/proxy.ts`, `apps/web/src/lib/security-headers*.ts`) dan perubahan
`package.json` root yang sudah ada sebelum Phase 2. Tidak ada commit/push.

---

## 7. Perintah verifikasi

```bash
cd /home/reksa/affiliateos

npm run test --workspace @affiliateos/web           # 270 pass / 0 fail, exit 0
npm test                                            # permissions 10 + database 46, exit 0
npm run typecheck                                   # exit 0
npx prisma validate --schema packages/database/prisma/schema.prisma  # valid, exit 0
npm run build --workspace @affiliateos/web          # compiled, exit 0
```

Log: `/tmp/opencode/phase2/web-test.log`,
`root-test.log`, `typecheck.log`, `prisma-validate.log`.

---

## 8. Pernyataan penutup

> **Phase 2 untuk checklist 2.1–2.7 selesai dan terverifikasi (DONE WITH NOTES).
> TD-7F-R1 s/d R5 ditutup. Phase 3 belum dimulai.** Blocker produksi yang tersisa
> adalah mail transport untuk undangan (TD-8-R3); tanpa itu alur accept hanya
> dapat dipakai lewat echo non-production.
>
> Phase 3+ (GPS, foto, geofence, revisi kehadiran, dashboard, notifikasi) **tidak**
> dikerjakan di sini dan tidak diklaim.
