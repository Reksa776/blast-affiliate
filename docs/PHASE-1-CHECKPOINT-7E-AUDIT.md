# Phase 1 — Checkpoint 7E: Audit Writer + Append-Only (P0.7)

Status: **DONE** (uncommitted — commit ditahan oleh user)

Scope: `writeAudit()` sebagai satu-satunya penulis `audit_logs`, integrasi ke route
auth (login sukses/gagal, logout, register bootstrap), sanitasi metadata, hashing IP,
dan bukti append-only dua lapis (aplikasi + grant database). Tanpa migration baru:
`audit_logs` sudah ada di M1.

---

## 1. File yang dibuat / diubah

| File | Isi |
| --- | --- |
| `packages/database/src/audit.ts` (baru) | `writeAudit()`, `sanitizeMetadata()`, `hashIp()`, `AuditInputError`, `REDACTED`, `AUDIT_ACTION_MAX_LENGTH` |
| `packages/database/src/tenant-db.ts` | `APPEND_ONLY_MODELS`, `APPEND_ONLY_OPERATIONS`, `TenantAppendOnlyError`, guard di `scopeQueryArgs()` |
| `packages/database/src/index.ts` | ekspor `writeAudit`, helper sanitasi, `APPEND_ONLY_MODELS`, `TenantAppendOnlyError` |
| `packages/database/src/audit.test.ts` (baru) | 9 test integrasi `writeAudit()` (T1–T7 + validasi input + sanitasi) |
| `packages/database/src/audit-append-only.test.ts` (baru) | 9 test append-only (4 lapis aplikasi, 5 lapis grant) |
| `apps/web/src/app/api/auth/login/route.ts` | `auth.login`, `auth.login_failed` (3 alasan) |
| `apps/web/src/app/api/auth/logout/route.ts` | `auth.logout` (hanya bila session benar-benar dihancurkan) |
| `apps/web/src/app/api/auth/register/route.ts` | `auth.register_bootstrap` (`actorType: SYSTEM`) |
| `apps/web/src/app/api/auth/__tests__/auth-audit.test.ts` (baru) | 6 test end-to-end lewat HTTP |
| `apps/web/package.json` | suite baru masuk script `test` |
| `packages/database/package.json` | `--test-force-exit` pada runner (lihat TD-7E-R1) |

## 2. Kontrak `writeAudit()`

- `tenantId: string | null` — `null` untuk aksi platform-global (auth); `audit_logs`
  ditulis lewat `systemDb()`, bukan `withTenant()`, karena tabel ini lintas tenant dan
  harus bisa ditulis sebelum tenant dipilih (login gagal).
- `action` wajib berformat `domain.verb` dan ≤ 64 karakter (`AuditInputError` bila
  tidak) — panjang kolom `VarChar(64)` ditegakkan di aplikasi, bukan dibiarkan
  terpotong diam-diam.
- `ip` di-hash SHA-256 dan disimpan sebagai `BINARY(32)`; IP plaintext tidak pernah
  masuk database, log, maupun metadata.
- Metadata disanitasi rekursif: kunci yang memuat fragmen `password`, `passwd`,
  `token`, `secret`, `apikey`, `api_key`, `authorization`, `cookie`, `csrf`,
  `credential` diganti `[REDACTED]`; array dan objek bersarang ikut disanitasi; ada
  batas kedalaman (6), jumlah kunci (100), dan panjang string (2000) agar metadata
  tidak bisa dipakai untuk membengkakkan tabel.
- `metadata: null` disimpan sebagai SQL NULL (`Prisma.DbNull`), bukan JSON `null`.

## 3. Bukti append-only

Dua lapisan, keduanya terhadap database nyata.

### 3.1 Lapisan aplikasi (`withTenant`)

| Operasi | Hasil |
| --- | --- |
| `auditLog.update` / `updateMany` / `upsert` / `delete` / `deleteMany` | `TenantAppendOnlyError` sebelum query dibentuk |
| `auditLog.findMany` | diizinkan |
| `auditLog.create` | diizinkan, `tenantId` wajib sama dengan konteks |

`upsert` sengaja ditolak: separuh operasinya adalah UPDATE.

### 3.2 Lapisan grant (akun runtime `affiliateos_app`)

`SHOW GRANTS` untuk `audit_logs` pada schema `affiliateos`:

```
GRANT SELECT, INSERT ON `affiliateos`.`audit_logs` TO `affiliateos_app`@`localhost`
```

Hasil probe (output nyata):

| Probe | Hasil |
| --- | --- |
| `$executeRawUnsafe("UPDATE audit_logs ...")` | `Code: 1142`, `UPDATE command denied ... for table affiliateos.audit_logs` |
| `auditLog.updateMany()` | `Code: 1142`, `UPDATE command denied` |
| `auditLog.deleteMany()` | `Code: 1142`, `DELETE command denied` |
| `auditLog.update()` pada baris yang ada | `Code: 1142` (di dalam transaksi yang di-rollback) |
| `auditLog.delete()` pada baris yang ada | `Code: 1142` (di dalam transaksi yang di-rollback) |
| `auditLog.findMany()` | sukses |
| `auditLog.create()` | sukses; transaksi di-rollback, baris tidak tersisa |

Catatan penting: `auditLog.update({ where: { id } })` pada id yang **tidak ada**
mengembalikan P2025 ("No record was found for an update"), bukan 1142 — Prisma membaca
baris lebih dulu dan tidak pernah mengirim UPDATE. Karena itu probe memakai baris nyata
di dalam satu transaksi yang di-rollback, sehingga statement UPDATE benar-benar dikirim
dan ditolak 1142, sementara tidak ada baris yang bertahan. Tidak ada baris probe yang
tersisa (diverifikasi dengan `findUnique` setelah transaksi).

### 3.3 Tidak ada route yang memutasi audit

```
$ grep -rn "auditLog\.\(update\|delete\)" apps/web/src/
apps/web/src/app/api/auth/__tests__/auth.test.ts:64:  await db.auditLog.deleteMany();
apps/web/src/app/api/auth/__tests__/auth-audit.test.ts:72:  await db.auditLog.deleteMany();
apps/web/src/lib/auth/test-fixtures.ts:49:  await db.auditLog.deleteMany();
apps/web/src/lib/auth/test-fixtures.ts:71:  await db.auditLog.deleteMany();
```

Tidak ada `update`/`delete` di kode produksi; keempat hasil hanya `deleteMany()` di
helper truncate database test.

## 4. Hasil test

```
$ cd packages/database && npm test
ℹ tests 46   ℹ pass 46   ℹ fail 0   ℹ skipped 0
```
28 test lama + 9 `audit.test.ts` + 9 `audit-append-only.test.ts`.

```
$ cd apps/web && npm test
ℹ tests 227  ℹ pass 227  ℹ fail 0  ℹ skipped 0
```
221 test lama + 6 `auth-audit.test.ts` (T1–T6 sesuai brief).

```
$ npm run typecheck        → exit 0 (database + permissions + web)
$ cd packages/database && npx prisma validate
The schema at prisma/schema.prisma is valid 🚀
```

`npx prisma validate` dijalankan dari `packages/database`; dari root perintah itu gagal
karena root tidak punya `schema.prisma` (bukan masalah schema).

## 5. Smoke test manual (DB dev, `next dev -p 3100`)

```
server_ready=yes
csrf_len=43
register=201
login_wrong=401
login_ok=200
logout=204
```

`audit_logs` (dibaca dengan kredensial runtime, SELECT):

| action | actor_type | request_id | ip_hash | metadata |
| --- | --- | --- | --- | --- |
| `auth.logout` | USER | `smoke-p07` | 32 byte (64 hex) | `null` |
| `auth.login` | USER | `smoke-p07` | 32 byte (64 hex) | `{"email":"smoke@local.test"}` |
| `auth.login_failed` | USER | `smoke-p07` | 32 byte (64 hex) | `{"reason":"invalid_password","email_attempted":"smoke@local.test"}` |
| `auth.register_bootstrap` | SYSTEM | `smoke-p07` | 32 byte (64 hex) | `{"email":"smoke@local.test"}` |

`x-request-id` terbawa ke kolom `request_id`; `ip_hash` 32 byte (SHA-256), bukan IP
plaintext; tidak ada password/token di metadata.

Cleanup setelah smoke — kedua database:

```
DEV  after: {"users":0,"sessions":0,"audit_logs":0}
TEST after: {"users":0,"sessions":0,"audit_logs":0}
```

`audit_logs` dev dibersihkan dengan kredensial migrate, karena akun runtime memang tidak
punya DELETE (itu intinya). Grant tidak dilonggarkan.

## 6. Deviasi dari brief

1. **Append-only di test DB tidak bisa membuktikan penolakan grant.** `affiliateos_test`
   diakses dengan akun DDL (`affiliateos_migrate`), yang punya UPDATE/DELETE; akun itu
   juga tidak punya GRANT OPTION (`GRANT ... TO affiliateos_app` → 1142), jadi grant
   untuk `affiliateos_app` di schema test tidak bisa dibuat dari sini. Solusinya: lapis
   aplikasi diuji di test DB, lapis grant diuji dengan kredensial runtime terhadap schema
   runtime — konfigurasi yang sama dengan produksi — tanpa menulis baris permanen
   (UPDATE/DELETE pada baris di transaksi yang di-rollback; INSERT lalu rollback).
2. **Jumlah test lebih banyak dari target brief** (46 vs 39; 227 vs 227). Suite
   append-only memuat 9 test, bukan 4, karena `updateMany`/`deleteMany`/`upsert` juga
   harus terbukti ditolak, dan `update()` per-id butuh dua varian probe (baris ada vs
   tidak ada) agar hasilnya tidak ambigu seperti di §3.2.
3. **`--test-force-exit` ditambahkan** ke runner database (TD-7E-R1).
4. **Route workspace/business-development belum ada**, jadi `workspace.create`,
   `member.invite`, dan `role.change` belum diaudit (TD-7E-R4).

## 7. Red flag — diperiksa, tidak ada yang terpicu

| Red flag | Status |
| --- | --- |
| `auditLog.update()` tidak throw | Tidak terjadi. `update`/`updateMany`/`delete`/`deleteMany` dengan kredensial runtime semuanya 1142; satu-satunya non-1142 adalah P2025 pada baris yang tidak ada, yang tidak pernah mengirim UPDATE (dibuktikan di §3.2) |
| Metadata berisi password/token/secret | Tidak. T3/T4/T6 + T6 end-to-end memindai semua baris |
| `ipHash` berisi IP plaintext | Tidak. 32 byte; SHA-256 diuji eksak (T5) |
| Test gagal | Tidak ada yang gagal; tiga kegagalan selama pengerjaan diperbaiki di akar masalahnya (race cleanup antar-suite, ambiguitas P2025, helper cookie yang salah prefix) — tidak ada test yang di-skip atau dilemahkan |
| Route mengimpor `auditLog.update/delete` | Tidak ada (§3.3) |

## 8. Tech debt

- **TD-7E-R1** — `$disconnect()` Prisma dengan driver adapter MariaDB tidak menutup pool
  (2 socket tetap hidup; diverifikasi dengan `process._getActiveHandles()`). Runner
  database memakai `--test-force-exit`. Perbaikan: tutup pool lewat handle adapter secara
  eksplisit saat Prisma menyediakannya.
- **TD-7E-R2** — `affiliateos_app` tidak punya grant apa pun di `affiliateos_test`, dan
  akun migrate tidak punya GRANT OPTION. Operator perlu memberi `SELECT, INSERT` pada
  `affiliateos_test.audit_logs` (idealnya akun runtime khusus test) agar probe grant bisa
  berjalan di test DB dan suite tidak lagi menyentuh schema runtime sama sekali.
- **TD-7E-R3** — `update`/`delete` per-id pada baris yang tidak ada mengembalikan P2025
  sebelum statement dikirim. Setiap probe privilege di masa depan harus memakai baris
  nyata di dalam transaksi rollback, atau `updateMany`/`deleteMany`.
- **TD-7E-R4** — `workspace.create`, `member.invite`, `role.change` belum punya route;
  audit untuk ketiganya menyusul saat route-nya dibuat (P0.8).
- **TD-7E-R5** — `systemDb()` tetap mengekspos `auditLog.update/delete` ke kode
  aplikasi; yang menahan adalah grant database. Lapis aplikasi hanya berlaku di jalur
  `withTenant()`. Pertimbangkan tipe `systemDbFor` yang memisahkan operasi baca dari
  penulisan audit.

## 9. Langkah berikutnya

P0.8: route workspace (create, invite member, ubah role) + penulisan audit
`workspace.create` / `member.invite` / `role.change`, lalu probe grant di test DB
setelah operator menambahkan grant (TD-7E-R2).
