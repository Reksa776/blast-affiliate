# Phase 1 — Checkpoint 7D: RBAC (P0.6)

Status: **DONE** (uncommitted — commit ditahan oleh user)

Scope: katalog permission, 6 role default, `requirePermission()`, route enforcement,
matriks test role × permission, seed katalog, smoke HTTP. Tanpa migration baru.

---

## 1. Katalog permission — 27, bukan 26

Sumber otoritatif: `docs/08-TENANT-ISOLATION-DESIGN.md` §5.1. Brief P0.6 menurunkan
daftar dari breakdown PRD dan berhenti di 26 (`member.read` hilang). Schema M1 dan
docs/08 §5.1 sama-sama memuat `member.read`, dan `member.read` dibutuhkan role VIEWER
agar daftar member bisa dibaca tanpa hak ubah — jadi katalog mengikuti docs/08.

| Domain | Permission | Jumlah |
| --- | --- | --- |
| Workspace | `workspace.read`, `workspace.update`, `workspace.manage` | 3 |
| Member | `member.read`, `member.invite`, `member.manage`, `role.manage` | 4 |
| Creator | `creator.read`, `creator.write`, `creator.delete`, `creator.assign`, `creator.blacklist`, `creator.export` | 6 |
| Campaign | `campaign.read`, `campaign.write`, `campaign.publish`, `campaign.delete` | 4 |
| Shop | `shop.read`, `shop.connect`, `shop.disconnect`, `shop.sync` | 4 |
| Outreach | `outreach.read`, `outreach.send` | 2 |
| Analytics | `analytics.read`, `analytics.export` | 2 |
| Platform | `audit.read`, `job.read`, `job.retry` | 3 |
| **Total** | | **27** |

Catatan perbedaan nama vs brief: brief memakai `workspace.delete` (tidak ada di katalog;
padanan sebenarnya `workspace.manage`), `member.remove`/`member.role.update` (padanan
`member.manage`), `creator.create`/`creator.update` (padanan `creator.write`),
`campaign.create`/`campaign.update` (padanan `campaign.write`), `admin.platform` (tidak
ada; akses platform bukan permission workspace — lihat §3). Test dan kode memakai nama
katalog, bukan nama di brief.

Katalog hidup di paket baru `packages/permissions` (code-owned), dipakai bersama oleh
seed database dan `apps/web`:

- `src/catalog.ts` — `PERMISSIONS`, `ALL_PERMISSIONS`, `isPermission`, `permissionDescription`
- `src/roles.ts` — `ROLES`, `ALL_ROLES`, `ROLE_LABELS`, `ROLE_PERMISSIONS`, `roleHasPermission`
- `src/catalog.test.ts` — 10 test katalog + matriks

## 2. Enam role default

`super_admin` **tidak** ditambahkan. `RoleKey` di schema M1 hanya punya enam nilai
workspace, dan docs/08 §5.3 menjelaskan alasannya: super admin adalah peran platform, dan
memasukkannya sebagai role workspace akan membuat tenant owner bisa mencetak user
platform. Menambahkannya butuh migration enum, yang tidak diizinkan pada checkpoint ini.
Akses lintas tenant diimplementasikan lewat tabel `platform_admin_grants` (§3).

| Role (`RoleKey`) | Permission | Jumlah |
| --- | --- | --- |
| `WORKSPACE_OWNER` | seluruh katalog | 27 |
| `WORKSPACE_ADMIN` | seluruh katalog kecuali `workspace.manage` | 26 |
| `AFFILIATE_MANAGER` | creator.* (6), campaign.* (4), outreach.* (2), shop.* (4), analytics.read | 17 |
| `BUSINESS_DEVELOPMENT` | creator.read, creator.write, creator.assign, campaign.read, outreach.read, outreach.send, creator.read… (lihat `ROLE_PERMISSIONS`) | 8 |
| `ANALYST` | analytics.read, analytics.export, creator.read, campaign.read, shop.read, outreach.read, workspace.read, member.read, audit.read | 9 |
| `VIEWER` | workspace.read, member.read, creator.read, campaign.read, shop.read, analytics.read | 6 |

Angka di atas diverifikasi test (`packages/permissions/src/catalog.test.ts`) dan oleh 162
kombinasi matriks di database (§5).

## 3. Provisioning database

`packages/database/src/rbac.ts`:

- `permissionIdFor(key)` — id deterministik (SHA-256 atas `affiliateos:permission:<key>`,
  diformat UUID). Schema tidak memberi default pada `permissions.id`, jadi id harus
  dihitung; menurunkannya dari key membuat seed idempoten bahkan bila upsert diubah nanti.
- `seedPermissionCatalog()` — upsert 27 baris, me-refresh deskripsi.
- `createDefaultRolesForWorkspace(tenantId)` — upsert 6 role per workspace
  (`@@unique([tenantId, key])`) + `createMany({ skipDuplicates: true })` untuk
  `role_permissions`. Melempar error bila katalog belum di-seed, bukan diam-diam membuat
  role dengan permission kurang.

Script: `packages/database/src/scripts/seed-rbac.ts` (`loadRepoEnv()` sebelum import client,
karena pool dibuka saat evaluasi modul). Role tidak di-seed di script ini — role adalah
milik workspace dan dibuat saat workspace diprovisikan, jadi `roles = 0` setelah seed
adalah hasil yang benar, bukan kegagalan.

Hasil seed ke dev DB:

```
env_loaded_from=~/affiliateos/.env
permissions=27
roles=0
role_permissions=0
result=OK
```

## 4. `requirePermission()`

`apps/web/src/lib/auth/permission.ts`:

```ts
requirePermission(req, tenantId, permission) → { session, member, permissions, platformAdmin }
```

Alur: `requireAuth` (401) → satu query `workspaceMember.findUnique({ where: { tenantId_userId } })`
dengan nested select `roleAssignments → role.permissions → permission.key` → cek
`status === "ACTIVE"` dan `held.has(permission)`.

Kenapa tidak N+1: seluruh penelusuran member → role → permission ada dalam **satu** query
Prisma (satu round trip). Member dengan tiga role berbiaya sama dengan member dengan satu
role, dan tidak ada loop query per role seperti draft di brief.

Jalur platform: bila jalur membership menolak, baru ada satu query tambahan ke
`platform_admin_grants` (`revokedAt: null`). Grant aktif memberi seluruh 27 permission dan
`platformAdmin: true`. Urutan ini penting — request normal tidak membayar query platform,
dan membership tetap syarat untuk data workspace biasa.

Semua kegagalan otorisasi = `PermissionError` status 403 dengan pesan tetap; route tidak
pernah menggemakan nama permission atau alasan penolakan ke klien. Permission di luar
katalog ditolak eksplisit (`Unknown permission`), supaya typo tidak menjadi deny senyap.

### Route enforcement

`GET /api/workspaces/:workspaceId/probe` (`apps/web/src/app/api/workspaces/[workspaceId]/probe/route.ts`).

**Deviasi yang diperlukan:** brief meminta `_probe`, tetapi Next memperlakukan setiap folder
berawalan `_` sebagai *private folder* dan mengeluarkannya dari routing — `next build` tidak
mendaftarkan route itu sama sekali (terbukti pada build pertama: route tidak ada di daftar).
Route dipindah ke `probe`; perilakunya sama, dan sekarang terdaftar di output build.

Gate default `creator.read`; `?permission=` memilih permission lain dari katalog (mis.
`creator.write`). Ini perlu karena **semua** enam role memegang `creator.read`, sehingga
penolakan di level member tidak bisa dibuktikan dengan gate tunggal.

## 5. Test

### Unit — `packages/permissions`

```
tests 10 / pass 10 / fail 0
```

Mencakup: 27 permission unik, format `domain.action`, deskripsi ≤ VARCHAR(255),
`isPermission` ketat, 6 role sesuai `RoleKey`, setiap role ≥1 permission tanpa duplikat,
OWNER = katalog penuh, ADMIN = katalog minus `workspace.manage`, matriks docs/08 §5.2 untuk
VIEWER/ANALYST/BUSINESS_DEVELOPMENT, dan VIEWER tidak bisa menulis apa pun.

### Integration — `apps/web/src/lib/auth/permission.test.ts` (T1–T6 + 2 tambahan)

| Test | Skenario | Hasil |
| --- | --- | --- |
| T1 | OWNER di workspace A, `creator.read` | pass, 27 permission |
| T2 | BUSINESS_DEVELOPMENT, `creator.write` | pass, tanpa `creator.delete` |
| T3 | ANALYST, `creator.write` | `PermissionError` 403 |
| T4 | user bukan member | `PermissionError` "Not a member" |
| T5 | platform admin grant, seluruh 27 permission | pass tanpa membership |
| T6 | permission di luar katalog | `PermissionError` "Unknown permission" |
| +1 | member `INVITED` | ditolak |
| +2 | tanpa cookie session | `AuthError` 401, bukan 403 |

T5 menyimpang dari brief (`super_admin` di workspace A) karena role itu tidak ada; yang
diuji adalah jalur platform yang sebenarnya, dan hasilnya sama: seluruh katalog lolos.

### Matriks RBAC — `apps/web/src/lib/auth/rbac-matrix.test.ts`

6 role × 27 permission = **162 kombinasi**, masing-masing satu subtest bernama. Nilai
harapan dari `roleHasPermission` (matriks kode), nilai aktual dari `requirePermission` yang
membaca `role_permissions` di database — jadi test ini membuktikan seed menghasilkan apa
yang dideklarasikan matriks, bukan sekadar mengulang fungsi yang sama.

```
✔ RBAC matrix (6 roles × 27 permissions) (2812ms)
ℹ tests 176 / pass 176 / fail 0
```

Sesi dibuat sekali per role (6), bukan per kombinasi.

### Suite web lengkap (regresi + RBAC, paralel)

```
ℹ tests 221 / suites 4 / pass 221 / fail 0
```

Naik dari 45 → 221 (45 regresi + 8 permission + 168 matriks incl. parent). File test
berjalan paralel; yang diserialisasi hanya fase database (lihat TD-7D-R1).

### Build & typecheck

- `packages/permissions` `tsc` → 0; `packages/database` `tsc` → 0
- `apps/web` `tsc --noEmit` → 0
- `next build` → sukses, route `/api/workspaces/[workspaceId]/probe` terdaftar
- `packages/database` test → 28 pass (regresi `withTenant`/`systemDb`)
- `prisma validate` → valid

## 6. Smoke manual (HTTP, `next dev`)

Fixture: satu workspace, owner + analyst + outsider, session nyata.

| Kasus | HTTP | Body |
| --- | --- | --- |
| tanpa session | 401 | `{"error":"Unauthorized"}` |
| owner, `creator.read` (default) | 200 | `held: 27`, `platformAdmin: false` |
| owner, `?permission=workspace.manage` | 200 | `held: 27` |
| analyst, `creator.read` | 200 | `held: 9` |
| analyst, `?permission=creator.write` | 403 | `{"error":"Forbidden"}` |
| outsider (bukan member) | 403 | `{"error":"Forbidden"}` |

Brief mengharapkan analyst → 403 pada probe default; itu tidak mungkin dengan gate
`creator.read` karena ANALYST memegang `creator.read` (memang seharusnya). Penolakan
analyst dibuktikan pada `creator.write`.

## 7. Perubahan pada kode P0.5

- `apps/web/src/lib/auth/middleware.ts`: import relatif diberi ekstensi `.ts`
  (`./session.ts`, `./client-ip.ts`). Alasannya konkret: harness test menjalankan modul
  lewat type-stripping Node, yang tidak me-resolve specifier tanpa ekstensi, sehingga
  `permission.test.ts` gagal `ERR_MODULE_NOT_FOUND`. `tsconfig` sudah
  `allowImportingTsExtensions`, dan `next build` membuktikan Turbopack menerimanya.
  Tidak ada perubahan perilaku.
- `auth.test.ts`: menambah akuisisi lock test DB (lihat TD-7D-R1). Assertion tidak
  dilonggarkan; `assertSeparateAccounts` tidak disentuh, `MIGRATE_DATABASE_URL` tetap
  dikosongkan hanya di proses test (pola TD-7C-A8).

## 8. Tech debt

- **TD-7D-R1 — isolasi test DB berbasis lock file.** Tiga suite berbagi
  `affiliateos_test` dan men-truncate 13 tabel; `auth.test.ts` bahkan butuh `users` kosong
  global. Solusi sekarang: `test-lock.ts` (satu file di temp dir OS, stale 5 menit).
  Ini membuat file test tetap paralel dan hanya fase database yang bergiliran, tetapi lock
  bersifat per-host dan tidak melindungi dua mesin/dua CI job yang berbagi DB. Solusi
  sebenarnya: satu schema/database per suite.
- **TD-7D-R2 — `affiliateos_app` belum punya grant di `affiliateos_test`.** Suite integrasi
  masih memakai akun migrate di test DB; `MIGRATE_DATABASE_URL` dikosongkan di proses test
  agar guard `assertSeparateAccounts` tetap utuh. Grant DML untuk akun app di schema test
  akan menghapus kebutuhan pengecualian ini.
- **TD-7D-R3 — `requirePermission` memakai `systemDb()`.** Lookup membership memang harus
  terjadi sebelum tenant context ada, jadi tidak bisa memakai `withTenant()`; satu-satunya
  query yang menyentuh data tenant di jalur ini adalah `workspaceMember.findUnique` dengan
  `tenantId` eksplisit. Bila nanti ada route yang butuh data tenant setelah otorisasi,
  route itu harus masuk `withTenant()` dengan `member.tenantId` dari hasil ini.
- **TD-7D-R4 — belum ada provisioning workspace di level aplikasi.** `createDefaultRolesForWorkspace()`
  siap dipakai, tetapi belum ada route/service pembuat workspace yang memanggilnya, jadi
  sampai saat itu `roles = 0` di dev DB. Route create-workspace harus memanggilnya dalam
  transaksi yang sama dengan insert workspace.
- **TD-7D-R5 — probe route adalah alat diagnostik.** `/probe` mengembalikan daftar
  permission pemanggil. Tidak berbahaya (hanya milik sendiri), tetapi harus dihapus atau
  di-gate di balik flag dev sebelum produksi.
- **TD-7D-R6 — `_probe` tidak bisa dipakai.** Aturan private folder Next (`_` prefix)
  membuat nama itu tidak pernah ter-route; setiap route diagnostik berikutnya harus ingat
  hal ini.
