# Phase 1–2 Closure — HIGH #2, MEDIUM #5, MEDIUM #6, Phase 2 notes

Status: **DONE WITH NOTES**
Tanggal: 2026-11-17
HEAD saat pekerjaan: `25bdd26 docs: explain combined commit 4f3979c (8B + 8C + Phase 2)`
Commit: **tidak ada** (sesuai instruksi: tampilkan diff lalu STOP)

## Ringkasan

| Item | Status | Hasil |
|---|---|---|
| Fix 1 — HIGH #2 rate limit per-user/tenant | DONE | limiter umum + 429 `Retry-After` di route API |
| Fix 2 — MEDIUM #5 redaction logger | DONE | logger JSON-line + redaksi key/teks, dipakai di jalur error |
| Fix 3 — MEDIUM #6 UI Phase 1 | DONE | sign-in, switcher, dashboard, role dropdown, audit viewer |
| Fix 4 — TD-8-R7 UI ubah role | RESOLVED | dropdown inline di halaman Members |
| Fix 4 — TD-8-R3 mail transport | TETAP TECH DEBT | belum ada transport email |
| Fix 4 — TD-8-R6 automated UI test | TETAP TECH DEBT | belum ada Playwright/UI test |

Tidak ada migration baru. `last_seen_at` sudah ada sejak M1 dan tidak disentuh.
Tidak ada library baru.

---

## Fix 1 — HIGH #2: rate limit per-user dan per-tenant

### Yang ditambahkan

- `apps/web/src/lib/rate-limit/general.ts`
  - `user`: **300 request/menit per user per route**
  - `tenant`: **100 request/menit per tenant per operasi berat**
  - `ip`: 300/menit untuk route yang belum punya identitas user (logout)
  - key: `api-${scope}:${id}:${route}`; `route` adalah label milik kode
    (`workspaces.list`, `office.update`, …), bukan URL mentah, supaya suffix acak
    tidak bisa membuat bucket baru.
  - limit dibaca per panggilan dari env (`API_RATE_LIMIT_USER_MAX`,
    `API_RATE_LIMIT_USER_WINDOW_MS`, `API_RATE_LIMIT_TENANT_MAX`,
    `API_RATE_LIMIT_TENANT_WINDOW_MS`, `API_RATE_LIMIT_IP_*`); nilai tidak sah
    kembali ke default, bukan melempar error.
- `apps/web/src/lib/rate-limit/middleware.ts`
  - `checkRateLimit(req, { limit, windowMs, key, scope, route })` — bentuk async
    sesuai brief, siap dipindah ke Redis tanpa mengubah call site.
  - `enforceApiRateLimit(...)` — mengembalikan `NextResponse | null`; 429 berisi
    `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
    `X-RateLimit-Scope`, dan `Cache-Control: no-store`.

### Route yang dipasangi

| Route | Scope / route key |
|---|---|
| `GET /api/workspaces` | user — `workspaces.list` |
| `POST /api/workspaces` | user — `workspaces.create` |
| `GET /api/workspaces/:id/members` | user — `members.list` |
| `POST /api/workspaces/:id/members` | user — `members.invite` |
| `PATCH /api/workspaces/:id/members/:memberId/role` | user — `members.role` |
| `GET /api/workspaces/:id/office` | user — `office.read` |
| `PATCH /api/workspaces/:id/office` | user + tenant — `office.update` |
| `POST /api/invitations/accept` | user — `invitations.accept` |
| `GET /api/auth/me` | user — `auth.me` |
| `POST /api/auth/logout` | ip — `auth.logout` |
| `POST /api/auth/login` | existing 10/15 menit per IP, kini + `Retry-After` |
| `POST /api/auth/register` | existing 5/menit per IP, kini + `Retry-After` |

`/api/health` dan `/api/auth/csrf` sengaja dikecualikan (probe dan token issuer).
Urutan pada route mutasi: **auth → CSRF → rate limit → validasi → mutasi**, sehingga
429 tidak membocorkan hasil validasi body.

### Test

- `apps/web/src/lib/rate-limit/general.test.ts` — 5 test:
  allowed, blocked pada request ke-301, reset window, isolasi user/tenant/user lain,
  cleanup bucket kedaluwarsa.
- `apps/web/src/app/api/workspaces/__tests__/api-rate-limit.test.ts` — integrasi
  nyata: **300 request GET `/api/workspaces` lolos, request ke-301 → 429** dengan
  `Retry-After` bilangan bulat 1–60 detik dan header `X-RateLimit-*`.

---

## Fix 2 — MEDIUM #5: redaction logger

- `apps/web/src/lib/logger.ts`
  - `log(level, event, data)` menulis **satu JSON per baris**:
    `{ ts, level, event, ...data }`; field reserved ditulis terakhir agar data tidak
    bisa memalsukan `level`/`event`.
  - Redaksi dua lapis:
    1. **key** yang mengandung `password`, `passwd`, `token`, `secret`, `apikey`,
       `api_key`, `authorization`, `cookie`, `csrf`, `credential` → `[REDACTED]`
       pada semua kedalaman, termasuk di dalam array;
    2. **teks** `password=…`, `token: …`, `Bearer …`, cookie header → `[REDACTED]`,
       karena pesan error dapat membawa secret sebagai string, bukan field.
  - Tidak pernah melempar: kegagalan serialisasi menjadi satu baris envelope.
- `handleRouteError` (`lib/auth/route-support.ts`) mencatat
  `route.unhandled` dengan `{ error: { name, message } }` sebelum melempar ulang.
  Ini satu-satunya jalur error tak terduga yang sebelumnya tidak meninggalkan log.

Catatan: `grep -rn "console\.\(log\|error\|warn\)" apps/web/src` pada kode aplikasi
menghasilkan **nol match** (semua sudah bersih / memakai `console.log` hanya di
logger itu sendiri). Jadi tidak ada penggantian massal yang bisa dilakukan; logger
dihubungkan ke jalur error yang nyata.

### Test

`apps/web/src/lib/logger.test.ts` — 5 test: password, token bersarang, secret dalam
array, JSON-line + field aman utuh, dan secret di teks bebas (pesan error).

Bukti tambahan dari smoke: `POST /api/workspaces` yang gagal (katalog permission
kosong) menghasilkan baris
`{"level":"error","event":"route.unhandled","error":{"name":"Error","message":…}}`
tanpa kredensial.

---

## Fix 3 — MEDIUM #6: UI Phase 1

| Halaman / komponen | File | Isi |
|---|---|---|
| Sign-in | `app/(auth)/sign-in/page.tsx` | email + password, CSRF dulu, 401 → “Email atau password salah”, 429 → “Terlalu banyak percobaan”, sukses → `/workspaces` |
| Workspace switcher | `components/workspace-switcher.tsx` | dropdown dari `GET /api/workspaces`, pindah workspace, modal “Create workspace” (POST + navigasi) |
| Workspace shell | `app/workspaces/[workspaceId]/layout.tsx` | header (switcher, email, sign out) + sidebar Overview/Members/Office/Audit; redirect `/sign-in` bila tanpa session, `/workspaces` bila bukan member |
| Dashboard | `app/workspaces/[workspaceId]/page.tsx` | ringkasan member, audit, jam kerja, tautan modul |
| Member list | `app/workspaces/[workspaceId]/members/page.tsx` + `components/member-role-select.tsx` | tabel name/email/role/status/joined, invite, **dropdown role inline** (PATCH + CSRF) |
| Audit viewer | `app/workspaces/[workspaceId]/audit/page.tsx` + `listAuditLogs` di `lib/workspaces/data.ts` | tabel waktu/actor/action/resource/IP hash terpotong/metadata, filter action+actor+rentang tanggal, pagination 25/halaman |
| Office settings | `app/workspaces/[workspaceId]/office/page.tsx` | sudah ada dari Phase 2; diverifikasi tetap berfungsi (form + read-only untuk role tanpa `workspace.manage`) |

Detail keamanan UI:

- Semua halaman memakai `requirePagePermission` yang sama dengan API; layout dan
  page sama-sama memanggilnya, sehingga tidak ada model izin kedua.
- Audit dibaca lewat `withTenant`; filter actor di-resolve ke `users` (platform-global)
  lebih dulu, lalu id itu dipakai di query tenant-scoped.
- `ip_hash` ditampilkan 12 karakter hex pertama + `…`, bukan nilai penuh.

Tidak ada test browser/Playwright (sesuai instruksi). Verifikasi: `next build` +
smoke curl.

---

## Fix 4 — Phase 2 notes

- **TD-8-R7 (UI ubah role): RESOLVED.** Dropdown inline ada di halaman Members,
  memanggil `PATCH /api/workspaces/:id/members/:memberId/role`, menolak perubahan
  role diri sendiri (route), dan me-refresh halaman setelah sukses. Route tetap
  merevoke seluruh sesi user yang diubah.
- **TD-8-R3 (mail transport): TETAP TECH DEBT.** Undangan masih mengandalkan
  `devToken` di response non-production. Belum ada SMTP/Resend/SendGrid/template.
  Keputusan produk diperlukan sebelum production.
- **TD-8-R6 (automated UI test): TETAP TECH DEBT.** Belum ada Playwright; smoke
  manual + `next build` dipakai untuk closure ini.

---

## Test result (output nyata)

```
permissions : 10 pass, 0 fail   (PERM_EXIT=0)
database    : 46 pass, 0 fail   (DB_EXIT=0)
web         : 294 pass, 0 fail  (WEB_EXIT=0)   ← 283 + 11 test baru
typecheck   : exit 0            (web, worker, database, permissions)
build       : exit 0            (permissions → database → worker → web)
```

Test web baru: 5 general rate limit + 5 logger + 1 integrasi 301 request.
Tidak ada test yang di-skip. Semua suite integrasi memakai `affiliateos_test`
(`TEST_DATABASE_URL`), bukan DB development.

## Smoke result (next dev :3070, DATABASE_URL=TEST_DATABASE_URL)

```
GET  /sign-in                         200  (form email tampil)
POST /api/auth/register               201
POST /api/auth/login                  200  (cookie aos_session)
GET  /workspaces                      200
POST /api/workspaces                  201  (workspace baru + rotasi sesi)
GET  /workspaces/:id                  200  (“Phase 2 scope”)
GET  /workspaces/:id/members          200  (“Invite a member”)
GET  /workspaces/:id/office           200
GET  /workspaces/:id/audit            200  (workspace.create)
POST /api/workspaces/:id/members      200  (invite VIEWER, devToken)
POST /api/invitations/accept          200  (status active)
PATCH .../members/:memberId/role      200  { roleKey: "ANALYST" }
GET  /workspaces/:id/members          200  opsi ANALYST terpilih
PATCH .../office                      200  address/timezone/jam tersimpan
GET  /workspaces/:id/office           200  “Jl. Smoke No. 1”, “Asia/Makassar”
GET  /workspaces/:id/audit            200  member.invite, member.accept_invite,
                                            role.change, workspace.update_office
```

Setelah smoke, seluruh baris test DB dibersihkan (`users=0`, `workspaces=0`,
`sessions=0`). Server dihentikan.

Catatan smoke (transparan): percobaan pertama gagal karena test DB baru di-truncate
tanpa reseed `permissions` (500 dari `createDefaultRolesForWorkspace`), dan dua
PATCH sempat 405 karena `curl -d` default POST. Keduanya bukan bug kode; setelah
`seedPermissionCatalog()` dan `-X PATCH`, semua langkah 200.

## Tech debt baru / yang masih terbuka

1. **Limiter masih per proses** (TD-7C-A1). 300/menit per user **per route**, bukan
   kuota global lintas route; N instance mengalikan batas. Redis tetap target P1.3.
2. **Audit viewer memakai offset pagination** dan filter `action contains` tanpa
   index khusus; volume besar akan perlu cursor + index.
3. **Actor email di audit viewer** di-resolve dengan `systemDb()` (display-only)
   karena `users` platform-global; perlu query gabungan bila volume actor besar.
4. **Multi-role per member** belum direpresentasikan di dropdown; UI memakai role
   pertama dan PATCH mengganti seluruh role (perilaku route yang sudah ada).
5. **TD-8-R3** dan **TD-8-R6** tetap terbuka seperti di atas.

## File yang berubah/tambah

Baru:

- `apps/web/src/lib/rate-limit/general.ts`
- `apps/web/src/lib/rate-limit/middleware.ts`
- `apps/web/src/lib/rate-limit/general.test.ts`
- `apps/web/src/lib/logger.ts`
- `apps/web/src/lib/logger.test.ts`
- `apps/web/src/app/(auth)/sign-in/page.tsx`
- `apps/web/src/components/workspace-switcher.tsx`
- `apps/web/src/components/sign-out-button.tsx`
- `apps/web/src/components/member-role-select.tsx`
- `apps/web/src/app/workspaces/[workspaceId]/layout.tsx`
- `apps/web/src/app/workspaces/[workspaceId]/page.tsx`
- `apps/web/src/app/workspaces/[workspaceId]/audit/page.tsx`
- `apps/web/src/app/api/workspaces/__tests__/api-rate-limit.test.ts`
- `docs/PHASE-1-2-CLOSURE.md`

Diubah:

- `apps/web/src/lib/auth/route-support.ts` (logger pada error tak terduga)
- `apps/web/src/lib/workspaces/data.ts` (`listAuditLogs`)
- route: `api/workspaces/route.ts`, `members/route.ts`, `role/route.ts`,
  `office/route.ts`, `invitations/accept/route.ts`, `auth/me/route.ts`,
  `auth/logout/route.ts`, `auth/login/route.ts`, `auth/register/route.ts`
- `apps/web/src/app/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/src/app/workspaces/page.tsx`, `apps/web/src/app/page.tsx`
- `apps/web/package.json` (3 file test baru di script `test`)
