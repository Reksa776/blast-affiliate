# P0.5 — Auth (Session + Argon2id + CSRF + Rate Limit)

## Status: DONE (+ pre-P0.6 fixes)

Session opaque + Argon2id + rate limiting + **enforced CSRF** implemented,
typechecked, and proven end-to-end against the real database and a real
`next dev` server. All three pre-P0.6 fixes are **resolved**: CSRF is enforced,
proxy headers are gated by `TRUST_PROXY`, and the integration suite runs in
parallel against its own `affiliateos_test` database.

Date: 2026-11-17 · Next 16.4.6 · Prisma 7.10.1 · argon2 0.45.2 · Node 26.13.0

## File dibuat

| File | Isi |
|---|---|
| `apps/web/src/lib/auth/password.ts` | Argon2id (m=19456, t=2, p=1), min 12 karakter |
| `apps/web/src/lib/auth/session.ts` | token 32 byte, SHA-256 di DB, TTL 30 hari, cookie attrs |
| `apps/web/src/lib/auth/csrf.ts` | `generateCsrfToken`, `timingSafeEqualString` |
| `apps/web/src/lib/auth/rate-limit.ts` | fixed window in-memory + cleanup |
| `apps/web/src/lib/auth/middleware.ts` | `clientIp`, `AuthError`, `requireAuth` |
| `apps/web/src/lib/auth/index.ts` | barrel export |
| `apps/web/src/lib/auth/test-env.ts` | **test-only** loader `.env` (tidak dipakai aplikasi) |
| `apps/web/src/lib/auth/*.test.ts` | 4 file test (password, csrf, rate-limit, session) |
| `apps/web/src/app/api/auth/register/route.ts` | bootstrap-only registration |
| `apps/web/src/app/api/auth/login/route.ts` | login + session cookie |
| `apps/web/src/app/api/auth/logout/route.ts` | hapus session + clear cookie |
| `apps/web/src/app/api/auth/me/route.ts` | current user (id, email, name) |
| `apps/web/src/app/api/auth/__tests__/auth.test.ts` | 10 test end-to-end |
| `apps/web/package.json` | dependency `argon2`, script `test` |
| `apps/web/tsconfig.json` | `allowImportingTsExtensions` (test mengimpor `./x.ts`) |
| root `package.json` | `allowScripts: argon2@0.45.2` agar install reprodusibel |

Tidak ada migration baru. `model Session` sudah memuat semua field yang dibutuhkan
(`id`, `user_id`, `token_hash`, `ip_hash`, `user_agent`, `expires_at`,
`revoked_at`), jadi schema tidak disentuh.

## Test Result

```
packages/database : tests 28  pass 28  fail 0   exit 0   (regression Task C)
apps/web          : tests 45  pass 45  fail 0   exit 0
  password 6 · csrf 10 · client-ip 6 · rate-limit 4 · session 5 · integration 14
typecheck web     : exit 0
typecheck root    : exit 0   (web + database)
prisma validate   : The schema at prisma/schema.prisma is valid 🚀  exit 0
```

Jumlah 45 (bukan 29) karena pre-P0.6 menambah 16 test: 6 `verifyCsrf`, 6
`getClientIp`, dan 4 skenario CSRF + IP di integration test. Satu assertion lama
tetap dipertahankan: hash harus berformat `$argon2id$v=19$m=19456,t=2,p=1$` —
tanpa itu "pakai Argon2id" hanya klaim, bukan bukti.

## Smoke Test (curl ke `next dev` :3000)

| Step | Expected | Actual | Bukti |
|------|----------|--------|-------|
| Register bootstrap | 201 | **201** | `{"id":"adc432c7-…","email":"admin@test.local","name":"Admin"}` |
| Register kedua | 403 | **403** | `{"error":"Registration is closed"}` |
| Login benar | 200 + cookie | **200 + cookie** | `set-cookie: session=…; Path=/; Expires=…; HttpOnly; SameSite=lax` |
| Me dengan cookie | 200 | **200** | `{"id":…,"email":"admin@test.local","name":"Admin"}` |
| Login salah | 401 | **401** | tanpa body data |
| Me tanpa cookie | 401 | **401** | — |
| Logout | 204 | **204** | `set-cookie: session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax` |
| Me setelah logout | 401 | **401** | — |

DB setelah cleanup: `users=0, sessions=0, roles=0, workspaces=0, audit_logs=0`.

## Keputusan yang menyimpang dari draft prompt (dan alasannya)

1. **`token_hash` adalah `BINARY(32)`, bukan hex.** Draft menyimpan
   `sha256(...).digest('hex')`; kolomnya `Bytes`, jadi digest disimpan sebagai
   `Uint8Array<ArrayBuffer>` (Prisma 7 menolak `Buffer` karena backing
   `ArrayBufferLike`). Hex akan butuh 64 byte dan tidak muat.
2. **`Session.id` wajib diisi** (tidak ada default DB) → `crypto.randomUUID()`.
3. **`User.name` tidak ada; kolomnya `display_name`.** API tetap mengembalikan
   `name` sesuai kontrak prompt, dipetakan dari `displayName`.
4. **zod tidak terpasang di repo ini** (draft mengasumsikan "sudah ada di stack").
   Validasi ditulis manual tanpa dependency baru, sesuai aturan "jangan install
   library tambahan".
5. **Integration test menembak HTTP, bukan memanggil handler langsung.**
   `next/server` tidak bisa di-resolve Node di luar bundler
   (`ERR_MODULE_NOT_FOUND: next/server`), dan handler memakai alias `@/`. Test
   menyalakan `next dev` :3417 di `before`, polling `/api/health`, lalu `kill` di
   `after` — jadi yang diuji benar-benar rantai Next + Prisma + MariaDB.
6. **`--test-concurrency=1`.** Tanpa itu, `node --test` menjalankan file paralel;
   `before()` integration test menghapus **semua** user (wajib untuk bootstrap) dan
   menghapus user fixture milik `session.test.ts` di tengah jalan → FK `user_id`
   violated. Bukan bug kode: `session.test.ts` lulus 5/5 saat dijalankan sendiri.

## Pre-P0.6 fixes

### FIX 1 — CSRF enforcement (TD-7C-A2): RESOLVED

Double-submit cookie, tanpa migration. `GET /api/auth/csrf` menerbitkan token 32
byte, men-set `csrf_token` (HttpOnly **false** karena client harus membacanya,
SameSite=Lax, 24 jam) dan mengembalikannya di body. `verifyCsrf` membandingkan
cookie vs header `X-CSRF-Token` dengan `timingSafeEqualString` dan melempar
`CsrfError`. Di-enforce di **awal** `register`, `login`, dan `logout` — sebelum
rate limit dan sebelum cek bootstrap, sehingga request tanpa token tidak
mengonsumsi kuota dan tidak membocorkan status bootstrap.

Smoke (curl, server nyata):

| Step | Expected | Actual |
|---|---|---|
| `GET /api/auth/csrf` | 200 + cookie + token | **200**, `token_len=43`, `cookie_in_jar=1` |
| login tanpa header | 403 | **403** |
| register bootstrap + header | 201 | **201** `{"id":"16bff115-…","email":"admin@test.local"}` |
| login + header | 200 + cookie | **200** `set-cookie: session=…; HttpOnly; SameSite=lax` |
| logout tanpa header | 403 | **403** |
| logout + header | 204 | **204** `set-cookie: session=; Max-Age=0` |

Batas mekanisme ini (bukan bug): token tidak terikat ke session, jadi penyerang
yang bisa **menulis cookie** di domain yang sama (sub-domain takeover, XSS) tetap
bisa memalsukannya. Session-bound token butuh kolom baru di `sessions` dan
sengaja dihindari sebelum P0.6.

### FIX 2 — `x-forwarded-for` tidak dipercaya (TD-7C-A5): RESOLVED

`getClientIp` pindah ke `apps/web/src/lib/auth/client-ip.ts` (modul tanpa import
database, jadi bisa diuji murni) dan hanya membaca header proxy bila
`TRUST_PROXY=true`. Deviasi dari draft, disengaja: **tidak ada** fallback
`x-real-ip` / `req.ip`. Next.js tidak mengekspos socket address di
`NextRequest`, dan `x-real-ip` juga header yang dikendalikan penyerang — memakai
nya sebagai "fallback yang tidak bisa dipalsukan" hanya memindahkan lubangnya.
Tanpa proxy tepercaya jawabannya `"unknown"`: satu bucket global (aman) alih-alih
bucket yang bisa dirotasi. `TRUST_PROXY=false` didokumentasikan di `.env.example`.

### FIX 3 — isolasi test paralel (TD-7C-A7): RESOLVED

Operator membuat `affiliateos_test` dan memberi grant; agent memverifikasi dan
memigrasi schema ke sana. **`--test-concurrency=1` dihapus** dan suite berjalan
paralel.

```
TEST_DATABASE_URL len: 92          test_db_name=affiliateos_test  test_user=affiliateos_migrate
SELECT 1 (sebagai akun test)  → ok 1

tables_before = 0
dev _prisma_migrations before = 1   (tidak berubah sepanjang proses)

$ MIGRATE_DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
Datasource "db": MySQL database "affiliateos_test" at "127.0.0.1:3306"
Applying migration `20261117000000_m1_foundation_13_tables`
All migrations have been successfully applied.            exit 0

tables_after = 14  → audit_logs background_jobs background_job_attempts member_roles permissions
                     platform_admin_grants roles role_permissions sessions users workspaces
                     workspace_invitations workspace_members _prisma_migrations
dev after: migrations=1 tables=14                          (dev tidak tersentuh)
```

**Catatan penting soal perintah migrate:** `prisma.config.ts` memprioritaskan
`MIGRATE_DATABASE_URL`, jadi `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate
deploy` saja akan tetap menargetkan database **dev** (dan melaporkan “no pending
migrations”, seolah berhasil). Kedua variabel di-set ke URL test pada perintah di
atas; itulah bukti bahwa schema mendarat di `affiliateos_test`.

Hasil suite paralel (tanpa flag serial), dua kali berturut-turut:

```
run 1: tests 45  pass 45  fail 0  exit 0   duration 4.5s
run 2: tests 45  pass 45  fail 0  exit 0   duration 4.5s

dev DB   setelah run: users=0 sessions=0 roles=0 workspaces=0
test DB  setelah run: users=0 sessions=0 roles=0
```

Mekanisme isolasi:

- integration suite memakai `TEST_DATABASE_URL`; `process.env.DATABASE_URL`
  dialihkan **sebelum** `@affiliateos/database` diimpor (client membuka pool saat
  module-evaluation), dan server anak di-spawn dengan `DATABASE_URL` yang dipin;
- `before()`/`after()` mengosongkan 13 tabel M1 di DB test (urutan child-first,
  tidak bergantung pada cascade) dan meng-assert tabel kosong;
- guard keras: `requireTestDatabaseUrl()` melempar bila `TEST_DATABASE_URL` kosong,
  dan test menolak jalan bila nilainya sama dengan `DATABASE_URL`;
- `session.test.ts` tetap memakai DB dev seperti P0.5 (satu user sementara dengan
  email unik, dihapus sendiri) sehingga tidak ada dua file yang berebut tabel
  `users` — itulah yang dulu memaksa mode serial.

**Deviasi yang perlu dicatat:** `affiliateos_app` belum punya grant di
`affiliateos_test`, jadi DB test diakses dengan akun migrate. Karena itu
`DATABASE_URL` dan `MIGRATE_DATABASE_URL` tampak satu akun dan guard
`assertSeparateAccounts` menolak — perilaku yang benar untuk aplikasi. Di proses
test saja, `MIGRATE_DATABASE_URL` dikosongkan (`""`) sehingga guard menganggapnya
“tidak diset”. Dicatat sebagai TD-7C-A8; guard tidak dilonggarkan.

## Known Limitations

- Registrasi publik tidak dibuka (bootstrap only), sesuai PRD.
- Cookie `secure` hanya saat `NODE_ENV=production`; dev lewat http.
- Rate limit in-memory: hilang saat restart, tidak berlaku lintas instance.
- CSRF: ditegakkan (double-submit) di semua route mutasi; token tidak terikat
  session, jadi XSS/sub-domain takeover tetap di luar jangkauan mekanisme ini.
- `failed_login_count` / `locked_until` ada di schema tetapi belum dipakai —
  belum ada account lockout, hanya rate limit per IP.
- `lastSeenAt` tidak diperbarui saat validasi (menghindari satu write per request).
- Tidak ada rotasi session saat privilege berubah; belum ada email verification.
- Bootstrap memakai `COUNT(*)`; dua registrasi bersamaan masih bisa lolos ke
  unique-email constraint (409), bukan dua akun.

## Tech Debt

| ID | Severity | Deskripsi | Target Fix |
|----|----------|-----------|------------|
| TD-7C-A1 | HIGH | Rate limit in-memory, tidak survive restart, tidak multi-instance. | P1.3 (Redis) |
| TD-7C-A2 | ~~MEDIUM~~ **RESOLVED** | Double-submit cookie (`csrf_token` + `X-CSRF-Token`, timing-safe) ditegakkan di register/login/logout; token diterbitkan `GET /api/auth/csrf` | Selesai (pre-P0.6) |
| TD-7C-A3 | LOW | Session cleanup expired belum ada job scheduler (hanya lazy cleanup saat validate) | P1.3 (worker) |
| TD-7C-A4 | MEDIUM | Tidak ada test untuk cookie `secure` di production | Sebelum P7 |
| TD-7C-A5 | ~~MEDIUM~~ **RESOLVED** | `getClientIp` hanya membaca header proxy saat `TRUST_PROXY=true`; default `false` → bucket `"unknown"` yang tidak bisa dipalsukan | Selesai (pre-P0.6) |
| TD-7C-A6 | LOW | `users.failed_login_count` / `locked_until` tidak dipakai; belum ada lockout per akun | P0.6 / sebelum produksi |
| TD-7C-A7 | ~~LOW~~ **RESOLVED** | Suite `apps/web` berjalan paralel (flag serial dihapus); integration test memakai `affiliateos_test`, DB dev tidak disentuh, dua run berturut-turut 45 pass | Selesai (FIX 3) |
| TD-7C-A8 | LOW | `affiliateos_app` belum punya grant di `affiliateos_test`, sehingga DB test diakses dengan akun migrate dan `MIGRATE_DATABASE_URL` dikosongkan (`""`) khusus di proses test agar `assertSeparateAccounts` lolos. Aplikasi tetap memakai guard penuh. | Saat grant test ditambah: `GRANT SELECT, INSERT, UPDATE, DELETE ON affiliateos_test.* TO 'affiliateos_app'@'localhost'`, lalu hapus pengosongan variabel |

## Catatan operasional

- Smoke test mencetak satu session token di output curl. Token itu sudah tidak
  berlaku: `logout` menghapus barisnya, dan cleanup akhir menghapus semua sesi
  (`sessions=0`). Tidak ada password atau hash yang tercetak di mana pun.
- `next dev` dari smoke test dimatikan lewat PID; verifikasi port :3000 tertutup
  dilakukan setelahnya.
