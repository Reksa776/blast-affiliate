# AffiliateOS — Phase 1 Checkpoint 6A Report
## Project Scaffolding & Prisma 7 Connection

**Date:** 2026-11-16
**Status:** **PASS** — fondasi aplikasi berdiri, Prisma 7.10.1 + `@prisma/adapter-mariadb` terhubung ke `affiliateos` sebagai `affiliateos_dev@127.0.0.1` lewat query read-only. Tidak ada migration, tidak ada tabel, tidak ada commit.
**Scope:** Checkpoint 6A saja. Checkpoint 6B tidak dimulai.

---

## 1. Executive summary

Repository yang sebelumnya hanya berisi `docs/` + `.env` sekarang berisi monorepo npm workspaces yang dapat di-install, di-generate, di-typecheck, dan di-build, dengan koneksi database yang dibuktikan oleh query nyata melalui Prisma Client.

Yang terbukti dan dapat diulang:

| # | Klaim | Bukti |
|---|---|---|
| 1 | Dependency terpasang tepat versi | `npm ls` — 9 paket pinned, semua exact, 187 paket total |
| 2 | Prisma Client ter-generate | `✔ Generated Prisma Client (7.10.1) to ./src/generated/prisma in 28ms`, 8 file |
| 3 | Schema valid | `prisma validate` → `The schema at prisma/schema.prisma is valid 🚀` |
| 4 | Client menjalankan query read-only ke MariaDB | `version=11.8.6-MariaDB-0+deb13u1`, `result=OK` |
| 5 | Database benar | `database_name=affiliateos` |
| 6 | User benar | `current_user=affiliateos_dev@127.0.0.1` |
| 7 | Tidak ada migration | direktori `prisma/migrations` tidak ada; tidak ada perintah `migrate*`/`db push`/`db pull` |
| 8 | Tidak ada tabel/data berubah | `information_schema.TABLES` untuk kedua schema: kosong, sebelum dan sesudah |
| 9 | TypeScript 7.0.2 kompatibel | typecheck kedua workspace exit 0 |
| 10 | Next 16.4.6 build | `✓ Compiled successfully in 2.7s`, BUILD_ID dihasilkan, exit 0 |
| 11 | Tidak ada secret masuk Git | scan 35 file: password hanya ada di `.env` (ignored, untracked) |

Dua kegagalan nyata terjadi selama pengerjaan dan keduanya diperbaiki, bukan dihindari — dicatat di §11 (F-6A-1, F-6A-2).

**Yang belum dibuktikan (dan tidak diklaim):** migration, shadow database dipakai oleh `migrate`, model/typed query, pooling, timezone session, serta Prisma di dalam runtime Next.js.

---

## 2. File yang dibuat / diubah

### 2.1 Dibuat — root

| File | Isi |
|---|---|
| `package.json` | workspaces `apps/*`, `packages/*`; script `generate`, `validate`, `verify:db`, `typecheck`, `build` |
| `package-lock.json` | lockfile npm (92 KB), semua versi exact |
| `.env.example` | hanya nama variabel + komentar, **tanpa nilai** |

### 2.2 Dibuat — `packages/database`

| File | Isi |
|---|---|
| `package.json` | deps Prisma 7.10.1 + adapter + `mariadb` 3.5.4; script generate/validate/build/typecheck/verify |
| `tsconfig.json` | NodeNext, strict, `noUncheckedIndexedAccess`, output `dist/` |
| `prisma.config.ts` | pemuatan `.env` eksplisit + `url`/`shadowDatabaseUrl` wajib |
| `prisma/schema.prisma` | generator `prisma-client` + output; datasource `mysql` **tanpa URL**; tanpa model |
| `src/env.ts` | loader `.env` eksplisit (berhenti di workspace root) + `requireEnv()` |
| `src/client.ts` | singleton `PrismaClient` + `PrismaMariaDb`, memo `globalThis` |
| `src/index.ts` | public surface: `prisma`, `disconnectPrisma` |
| `src/scripts/verify-connection.ts` | bukti koneksi read-only (2 SELECT) |

### 2.3 Dibuat — `apps/web`

| File | Isi |
|---|---|
| `package.json` | Next 16.4.6, React 19.3.1, Tailwind 4.3.5, TS 7.0.2 |
| `next.config.ts` | `reactStrictMode`, `poweredByHeader: false` |
| `tsconfig.json` | **dimodifikasi otomatis oleh `next build`** (lihat §11 F-6A-5) |
| `postcss.config.mjs` | plugin `@tailwindcss/postcss` |
| `src/app/layout.tsx`, `page.tsx`, `globals.css` | shell App Router + `@import "tailwindcss"` |

### 2.4 Build output (git-ignored, tidak di-commit)

`packages/database/src/generated/prisma/**` (8 file), `packages/database/dist/**`, `apps/web/.next/**`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`.

### 2.5 Tidak diubah

`.gitignore` (aturan yang ada sudah mencakup `node_modules/`, `.next/`, `dist/`, `**/generated/prisma/`, `next-env.d.ts`, `.env`) — **nol perubahan**, diverifikasi lewat `git check-ignore`. `.env` tidak disentuh (tetap mode `600`). Delapan dokumen Phase 0 tetap utuh (`git diff HEAD -- docs/0*.md docs/PHASE-0-REPORT.md` = 0 baris).

---

## 3. Dependency dan versinya

Terpasang dan terverifikasi lewat `npm ls --depth=0 --workspaces`:

| Paket | Diminta | Terpasang | Catatan |
|---|---|---|---|
| `next` | 16.4.6 | **16.4.6** | Turbopack build |
| `react` | 19.3.1 | **19.3.1** | memenuhi peer Next |
| `react-dom` | 19.3.1 | **19.3.1** | — |
| `typescript` | 7.0.2 | **7.0.2** | dipakai kedua workspace (deduped) |
| `prisma` | 7.10.1 | **7.10.1** | CLI |
| `@prisma/client` | 7.10.1 | **7.10.1** | sama dengan CLI ✔ |
| `@prisma/adapter-mariadb` | 7.10.1 | **7.10.1** | Query Compiler enabled |
| `tailwindcss` | 4.3.5 | **4.3.5** | CSS-first |
| `@tailwindcss/postcss` | 4.3.5 | **4.3.5** | — |
| `mariadb` | — | **3.5.4** | lihat F-6A-3 |
| `postcss` | 8.5.6 | 8.5.6 | — |
| `@types/node` / `@types/react` / `@types/react-dom` | 24.10.1 / 19.2.7 / 19.2.3 | sama | — |

Install: **187 paket, 18 detik, exit 0**, `node_modules` 721 MB. Tidak ada versi yang diturunkan atau dinaikkan dari daftar yang disepakati. Tidak ada dependency tambahan di luar daftar (khususnya **tanpa `dotenv`** — lihat §4).

`prisma -v` melaporkan: Node `v26.13.0`, TypeScript `7.0.2`, **Query Compiler: enabled**.

---

## 4. Strategi environment loading (eksplisit)

Prisma 7 tidak memuat `.env` sendiri. Keputusan: **menggunakan parser bawaan Node (`process.loadEnvFile`)**, bukan `dotenv`, sehingga tidak ada dependency tambahan dan perilakunya terlihat di kode.

| Entrypoint | Mekanisme | Alasan |
|---|---|---|
| Prisma CLI (`prisma validate/generate`) | `prisma.config.ts` memanggil `findRepoRoot()` lalu `process.loadEnvFile(<root>/.env)` | config dievaluasi eager; pencarian berhenti hanya di `package.json` yang punya `"workspaces"`, jadi `.env` nyasar di sub-paket tidak terpakai |
| Script Node (`verify:db`, nanti worker/test) | `src/env.ts` → `loadRepoEnv()`, dipanggil **sebelum** `import("../client.js")` | client membuat pool saat module dievaluasi (F-6A-1) |
| Next.js (`apps/web`) | **belum diwire** — Next memuat `.env` dari direktori app (`apps/web`), sedangkan `.env` kita di root repo | lihat F-6A-4 dan rekomendasi 6B |

Kegagalan bersifat *fail-fast dan bernama*:

```
prisma.config.ts: DATABASE_URL is not set. Prisma 7 does not load .env by itself;
expected it in /home/reksa/affiliateos/.env or in the process environment.
```

Tidak ada jalur yang diam-diam memakai default atau jatuh ke database lain. `NODE_ENV` tidak dipakai untuk berpindah target database.

---

## 5. Konfigurasi Prisma 7

### 5.1 `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client"        // bukan prisma-client-js
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "mysql"                // tanpa url / directUrl / shadowDatabaseUrl
}
```

Tanpa model, sesuai larangan membuat tabel pada checkpoint ini. `prisma generate` tetap menghasilkan client yang mendukung `$queryRaw`, yang persis dibutuhkan 6A.

### 5.2 `prisma.config.ts`

```ts
const repoRoot = findRepoRoot(import.meta.dirname);
process.loadEnvFile(join(repoRoot, ".env"));

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: required("DATABASE_URL"),                    // satu akun: runtime = migration
    shadowDatabaseUrl: required("SHADOW_DATABASE_URL"), // schema sudah ada; akun tak boleh CREATE DATABASE
  },
});
```

Satu akun `affiliateos_dev` dipakai untuk kedua URL, sesuai keputusan sebelumnya. `shadowDatabaseUrl` wajib karena akun tidak punya hak `CREATE DATABASE`; ini konsisten dengan desain least-privilege, bukan workaround.

### 5.3 Runtime singleton

```ts
const adapter = new PrismaMariaDb(url);          // URL string, bukan PoolConfig
export const prisma = globalForPrisma.affiliateosPrisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalForPrisma.affiliateosPrisma = prisma;
```

Memo di `globalThis` mencegah Next dev hot-reload membuka pool baru setiap reload (docs/06 §3.3). `DATABASE_URL` hilang → error bernama, tanpa mencetak URL.

---

## 6. Bukti koneksi MariaDB

`npm run verify:db` (compile + eksekusi nyata, exit 0):

```
env_loaded_from=~/affiliateos/.env
version=11.8.6-MariaDB-0+deb13u1 from Debian
database_name=affiliateos
current_user=affiliateos_dev@127.0.0.1
session_user=affiliateos_dev@127.0.0.1
result=OK
```

Query yang dieksekusi, persis seperti yang diminta:

```sql
SELECT VERSION() AS version, DATABASE() AS database_name
SELECT CURRENT_USER() AS cu, SESSION_USER() AS su
```

Keduanya read-only. Jalur eksekusi: TypeScript → `tsc` → `node dist/src/scripts/verify-connection.js` → `PrismaClient` → `PrismaMariaDb` → `mariadb` 3.5.4 → TCP `127.0.0.1:3306`. Jadi ini bukan bukti "CLI bisa connect", melainkan **client hasil generate + adapter** yang connect.

`DATABASE()` mengembalikan `affiliateos` (bukan `NULL`), yang membuktikan adapter memilih schema dari URL dan bukan hanya mengautentikasi.

---

## 7. Hasil Prisma generate

```
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma/schema.prisma.
✔ Generated Prisma Client (7.10.1) to ./src/generated/prisma in 28ms
```

Output di `packages/database/src/generated/prisma`: `client.ts`, `browser.ts`, `commonInputTypes.ts`, `enums.ts`, `models.ts`, `models/`, `internal/` — **8 file**. Semuanya git-ignored (`.gitignore:32:**/generated/prisma/`). `prisma validate` juga exit 0 dan melaporkan `Loaded Prisma config from prisma.config.ts`, artinya config benar-benar dibaca, bukan diabaikan.

Catatan: `prisma generate` berhasil meski npm 11 memblokir install script (`allowScripts`), dan `node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x` ada (7 entri di direktori engines) — jadi risiko di addendum §9 tidak terwujud di mesin ini, tetapi tetap belum diputuskan secara eksplisit (F-6A-6).

---

## 8. Hasil typecheck dan build

| Perintah | Exit | Keluaran |
|---|---|---|
| `npm run typecheck -w @affiliateos/database` | **0** | `tsc -p tsconfig.json --noEmit` (TS 7.0.2, termasuk generated client + `prisma.config.ts`) |
| `npm run build -w @affiliateos/web` | **0** | `▲ Next.js 16.4.6 (Turbopack)` · `✓ Compiled successfully in 2.7s` · `Finished TypeScript in 422ms` · 3/3 static pages |
| `npm run typecheck` (semua workspace) | **0** | web + database |
| `npm run verify:db` | **0** | `result=OK` |

Build: **5 detik**, `BUILD_ID=g8qodo_XC4WTxPxWHueMt`, route `/` dan `/_not-found` keduanya static. RAM tersedia setelah build 2.859 MB dari 7.174 MB — **tidak ada kegagalan karena resource**.

Tailwind v4 terbukti memproses CSS, bukan sekadar terpasang: chunk CSS 7.109 byte dan berisi utilitas yang dipakai (`bg-slate-950`, `text-slate-100`).

Catatan jujur: build ini **tidak** meng-import `@affiliateos/database`. Yang dibuktikan adalah Next 16.4.6 + TS 7.0.2 + Tailwind 4.3.5 membangun aplikasi; integrasi Prisma ke runtime web belum ada dan bukan lingkup 6A.

---

## 9. Pemeriksaan keamanan

| Aturan | Status | Bukti |
|---|---|---|
| Tidak menampilkan password / URL lengkap | **PASS** | Output semua perintah hanya berisi `env_loaded_from=~/affiliateos/.env`, versi, nama DB, nama user |
| Secret tidak masuk Git | **PASS** | Scan 35 file (tanpa `.git`, `node_modules`, `.next`, `dist`, `generated`): nilai password hanya ditemukan di `.env` |
| `.env` ignored + untracked | **PASS** | `.gitignore:40:.env`; `TRACKED_ENV=0`; mode tetap `600` |
| `node_modules` / build output tidak masuk Git | **PASS** | `TRACKED_NODE_MODULES=0`, `TRACKED_GENERATED=0`, `.next/`, `dist/`, `next-env.d.ts`, `*.tsbuildinfo` ignored |
| `.env.example` tanpa nilai | **PASS** | 0 baris bernilai; hanya `DATABASE_URL` dan `SHADOW_DATABASE_URL` + placeholder `<url-encoded-password>` |
| Tidak ada perubahan password / user / privilege | **PASS** | Tidak ada `ALTER USER`, `CREATE USER`, `GRANT`, `REVOKE` dijalankan; `SHOW GRANTS` masih 3 baris, tanpa `ALL PRIVILEGES`, tanpa `GRANT OPTION` |
| Tidak mengakses database lain | **PASS** | Hanya `affiliateos` dan `affiliateos_shadow`; query `information_schema` dibatasi `WHERE TABLE_SCHEMA IN (...)` |
| Tidak ada DDL/DML | **PASS** | Tidak ada `CREATE`/`ALTER`/`DROP`/`TRUNCATE`/`INSERT`/`UPDATE`/`DELETE`; hanya 2 SELECT verifikasi + SELECT metadata |
| Tidak ada migration | **PASS** | `packages/database/prisma/migrations` tidak ada; tidak ada `migrate dev/deploy/reset`, `db push`, `db pull` |
| Tanpa commit / push / ubah history | **PASS** | `HEAD=5b5d061`, 1 commit, staged 0, tidak ada remote |

Catatan: dua dokumen lama (`PHASE-1-CHECKPOINT-3-REPORT.md`, `-4-REPORT.md`) memuat contoh URL dengan placeholder kredensial; itu bukan secret dan sudah ada sebelum checkpoint ini.

---

## 10. Git status dan database safety

### 10.1 Git

```
## main
?? .env.example
?? apps/
?? docs/PHASE-1-CHECKPOINT-3-REPORT.md
?? docs/PHASE-1-CHECKPOINT-4-REPORT.md
?? docs/PHASE-1-CHECKPOINT-5-REPORT.md
?? package-lock.json
?? package.json
?? packages/
```

Ignored (ringkas): `.env`, `node_modules/`, `apps/web/.next/`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`, `packages/database/dist/`, `packages/database/src/generated/`.

`HEAD` tetap `5b5d061cc74b43a208684776f656212a64d764bd`, total commit 1, tidak ada perubahan pada dokumen Phase 0.

### 10.2 Database safety verification

| Pemeriksaan | Hasil |
|---|---|
| Tabel di `affiliateos` dan `affiliateos_shadow` | **tidak ada** (0 baris pada `information_schema.TABLES`) |
| View | 0 |
| Collation kedua schema | `affiliateos` = `utf8mb4_unicode_ci`, `affiliateos_shadow` = `utf8mb4_unicode_ci` — **F7 dari Checkpoint 5 sudah tertutup** |
| Privilege | tidak berubah (3 baris grant, tanpa `ALL PRIVILEGES`, tanpa `GRANT OPTION`) |
| Sesi | `DATABASE()=affiliateos` |
| Migration | tidak ada direktori, tidak ada perintah dijalankan |
| Shadow database | hanya dipakai sebagai nilai konfigurasi; **belum pernah disentuh** oleh `migrate` |

---

## 11. Findings dan limitations

### 11.1 Findings — kegagalan yang terjadi dan diperbaiki

| ID | Severity | Uraian |
|---|---|---|
| **F-6A-1** | Medium (fixed) | `verify-connection.ts` versi pertama meng-`import` `../client.js` secara statis, sehingga ESM mengevaluasi client **sebelum** `loadRepoEnv()` berjalan → `Error: DATABASE_URL is not set`. Ini justru bug implicit-loading yang dilarang checkpoint. Diperbaiki dengan `src/env.ts` + `await import("../client.js")` setelah env dimuat. |
| **F-6A-2** | Low (fixed) | Alias `SELECT CURRENT_USER() AS current_user` ditolak MariaDB: `You have an error in your SQL syntax ... near 'current_user, SESSION_USER()'` (`ERROR 1064`) — `current_user` adalah reserved word. Diganti `AS cu` / `AS su`. Bukti bahwa koneksi memang terjadi: error datang dari server, bukan dari driver. |
| **F-6A-3** | Low (open, documented) | `@prisma/adapter-mariadb@7.10.1` mendeklarasikan **`mariadb@3.5.4`** sebagai dependency exact, bukan 3.5.5 seperti tertulis di addendum §1/§12. Saya mem-pin `mariadb@3.5.4` langsung agar hanya ada **satu** copy driver (tanpa duplikasi 3.5.4 di dalam 3.5.5). Penyimpangan dari addendum dicatat di sini, bukan disembunyikan. |
| **F-6A-4** | Medium (open) | Next.js memuat `.env` dari direktori app (`apps/web`), bukan root repo. Saat ini web belum memakai database sehingga tidak terlihat; begitu 6B menyambungkan Prisma ke route handler, `DATABASE_URL` tidak akan ada kecuali diwire eksplisit (mis. `process.loadEnvFile` di `next.config.ts` atau env dari proses induk). **Jangan** mengandalkan perilaku implisit. |
| **F-6A-5** | Info (accepted) | `next build` mengubah `apps/web/tsconfig.json`: `jsx` → `react-jsx` (wajib) dan `include` ditambah `.next/dev/types/**/*.ts`. Perubahan berasal dari tool, bukan dari saya; diterima karena memang konfigurasi yang diminta Next 16. |
| **F-6A-6** | Low (open) | npm 11.20.0 masih memperingatkan install script `prisma` dan `@prisma/engines` belum masuk `allowScripts`. `generate` tetap berhasil dan `schema-engine` ada, tetapi keputusan allowlist (addendum §9) belum dieksekusi. |
| **F-6A-7** | Info | Schema tanpa model berarti client hanya bisa `$queryRaw`; API model (create/findMany) belum ada tipenya. Ini konsekuensi yang disengaja dari larangan membuat tabel. |

### 11.2 Limitations (tidak diklaim PASS)

1. **Tidak ada migration** — sesuai larangan. `migrate dev`, `migrate deploy`, `migrate status`, `migrate diff`, `db push`, `db pull` tidak pernah dijalankan.
2. **Shadow database belum diuji fungsional** — hanya dipakai sebagai nilai `shadowDatabaseUrl`. Perilaku Prisma saat membuat/menerapkan shadow belum terbukti.
3. **Tidak ada model, tidak ada typed query** — hanya raw SQL read-only.
4. **Pooling, timeout, reconnect, timezone `Z`** belum diukur/diverifikasi.
5. **Prisma belum terintegrasi ke Next.js** — build web tidak meng-import database package.
6. **Tidak ada test otomatis** — verifikasi 6A berupa script manual; belum ada Vitest/Playwright (di luar scope).
7. **CI belum ada** — tidak ada pipeline (B6 tetap terbuka).
8. **`prisma.config.ts` tidak punya unit test** — hanya dibuktikan lewat eksekusi CLI.

---

## 12. Rekomendasi Checkpoint 6B

1. **Wire environment untuk web secara eksplisit** (F-6A-4) sebelum route handler pertama menyentuh database; pilihan: `process.loadEnvFile` di `next.config.ts` atau injeksi env oleh proses induk. Catat mana yang dipakai.
2. **Model baseline + migration pertama.** Karena akun tidak boleh `CREATE DATABASE`, pastikan `affiliateos_shadow` benar-benar kosong dan collation-nya tetap `utf8mb4_unicode_ci` sebelum `migrate dev`.
3. **Bangun `withTenant(ctx)` / `systemDb()`** di `packages/database`, karena `src/index.ts` saat ini mengekspor client mentah — bertentangan dengan aturan arsitektur §5 kalau dibiarkan sampai modul mulai memakainya.
4. **Putuskan `allowScripts`** (`npm install-scripts approve prisma @prisma/engines`) dan tambahkan pengecekan keberadaan `schema-engine-*` sebagai gate CI (addendum §9).
5. **Verifikasi perilaku adapter yang belum diukur**: `connectionLimit`, `timezone: "Z"`, perilaku `DECIMAL(18,2)` / `CHAR(36)` / `JSON` / composite FK setelah tabel ada.
6. **Uji migration-from-zero** (`migrate deploy` ke database bersih) sebelum exit criterion Phase 1 diklaim.
7. **Pertimbangkan `mariadb` 3.5.4 vs 3.5.5** (F-6A-3): kalau addendum dipertahankan pada 3.5.5, terima dua copy driver atau revisi addendum secara tertulis.

---

## 13. Status akhir

# **PASS**

Seluruh validasi Checkpoint 6A terpenuhi dengan bukti yang dapat diulang:

- dependency exact sesuai daftar, tanpa tambahan di luar daftar;
- Prisma Client 7.10.1 ter-generate ke `packages/database/src/generated/prisma` dan git-ignored;
- client tersebut **benar-benar** menjalankan query read-only ke MariaDB 11.8.6, database `affiliateos`, user `affiliateos_dev@127.0.0.1`;
- typecheck (TS 7.0.2) dan build (Next 16.4.6) exit 0 tanpa kegagalan resource;
- tidak ada migration, tidak ada tabel, tidak ada perubahan data, tidak ada perubahan privilege;
- tidak ada secret di Git, tidak ada commit.

Keterbatasan yang tercantum di §11.2 adalah **lingkup yang memang ditunda ke 6B**, bukan kegagalan yang disembunyikan.

**STOP.** Checkpoint 6B belum dimulai. Tidak ada commit. Menunggu persetujuan eksplisit.
