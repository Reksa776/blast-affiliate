# AffiliateOS — Phase 1 Checkpoint 6B Report
## Next.js Runtime Integration & Security Audit

**Date:** 2026-11-16
**Status:** **PASS WITH LIMITATIONS** — Next.js 16.4.6 membaca `.env` root secara eksplisit, memakai Prisma Client lewat public API `@affiliateos/database`, dan endpoint health server-side terbukti mengembalikan **200** saat DB hidup dan **503** saat DB mati, tanpa membocorkan credential. Dev-mode (HMR) belum diuji, dan allowlist install script masih menunggu persetujuan.

---

## 1. Executive summary

Integrasi runtime Next.js ↔ Prisma 7 selesai dan dibuktikan dengan server produksi sungguhan:

| Bukti | Hasil |
|---|---|
| `GET /api/health` (DB hidup) | **HTTP 200**, `{"status":"ok","database":"up"}` |
| `GET /api/health` (DB tidak terjangkau) | **HTTP 503**, `{"status":"unavailable","database":"down"}` |
| Secret di build output (191 file `.next`) | **0** password, **0** URL, **0** pola kredensial |
| Secret di client bundle (`static/`, 10 file) | **0** |
| Secret di seluruh tree (8.648 file) | hanya `.env` (ignored) |
| Dependency driver | **1 copy**, `mariadb@3.5.4` (transitif dari adapter) |
| Typecheck | exit 0 (database + web) |
| Next production build | exit 0, 5 detik |
| Database | tabel 0, collation tetap, grant tidak berubah |
| Git | HEAD `5b5d061`, staged 0, tanpa commit |

Tiga audit wajib (F-6A-3, F-6A-4, F-6A-6) ditutup dengan status: **CLOSED**, **CLOSED**, dan **NEEDS APPROVAL**.

---

## 2. Kondisi awal repository

| Item | Nilai |
|---|---|
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd`, 1 commit |
| Branch | `main`, tanpa remote |
| Staged | 0 |
| Untracked | `.env.example`, `apps/`, `packages/`, `package.json`, `package-lock.json`, 4 laporan checkpoint |
| Dependency | 187 paket terpasang, `node_modules` 721 MB |
| Scaffold 6A | `apps/web` (Next 16.4.6 + Tailwind 4), `packages/database` (Prisma 7.10.1 + adapter), schema model-less |
| Prisma build output | `packages/database/dist` (tanpa `.d.ts`), `src/generated/prisma` (8 file, ignored) |
| `.env` | mode `600`, root, 2 variabel |
| `.env` di `apps/web` | **tidak ada** |
| Tracked env / generated | 0 / 0 |

Tidak ada perubahan yang dihapus, di-reset, atau di-stash selama checkpoint ini.

---

## 3. Hasil audit F-6A-3 — MariaDB driver

### 3.1 Fakta yang diperiksa

| Pemeriksaan | Hasil |
|---|---|
| Deklarasi dependency adapter | `@prisma/adapter-mariadb@7.10.1` → `{"mariadb":"3.5.4","@prisma/driver-adapter-utils":"7.10.1"}` |
| `peerDependencies` adapter | `{}` (tidak ada) |
| Versi driver terpasang | `mariadb@3.5.4` |
| Jumlah copy driver di disk | **1** (`node_modules/mariadb`) |
| Entri lockfile | **1** (`node_modules/mariadb`, 3.5.4, integrity sha512) |
| Deklarasi di adapter di lockfile | `"mariadb": "3.5.4"` (exact, bukan range) |
| `gypfile` | `false` — driver murni JavaScript, tidak ada native build |
| Lifecycle script driver | tidak ada `install`/`postinstall` |
| Import langsung `mariadb` di kode kita | **0** |
| Versi Prisma CLI / Client / adapter | 7.10.1 / 7.10.1 / 7.10.1 — selaras |

### 3.2 Kesimpulan

Direct pin `mariadb@3.5.4` di `packages/database/package.json` **redundan**: adapter sudah mendeklarasikan versi exact yang sama, npm melakukan dedupe menjadi satu copy, dan kode kita tidak pernah meng-import driver tersebut (koneksi dibuat dari URL string di `new PrismaMariaDb(url)`).

**Dampak jika dihapus (dinilai sebelum perubahan):** tidak ada perubahan versi efektif; npm tetap memasang 3.5.4 sebagai dependency transitif; jumlah copy tetap 1; tidak ada tipe yang hilang karena tidak ada import `mariadb`; risk supply-chain tidak berubah.

**Tindakan:** dependency langsung dihapus. `npm install` melaporkan `removed 1 package in 520ms`. Setelah itu: `npm ls mariadb --all` → hanya `@prisma/adapter-mariadb → mariadb@3.5.4`; copy di disk = 1; entri lockfile = 1; build/typecheck/verify tetap exit 0.

**Status: CLOSED.**

Catatan: addendum `docs/06` §1 dan §12 menyebut 3.5.5. Itu keliru terhadap isi paket yang sebenarnya dan **tidak saya edit**, karena dokumen Phase 0 tidak boleh diubah pada checkpoint ini. Rekomendasi revisi tertulis ada di §16.

---

## 4. Hasil audit F-6A-4 — root environment Next.js

### 4.1 Mekanisme yang ada sebelum perbaikan

| Konsumen | Cara env didapat | Masalah |
|---|---|---|
| Prisma CLI | `prisma.config.ts` → `process.loadEnvFile(<root>/.env)` | benar (6A) |
| Script Node (`verify:db`) | `src/env.ts` → `loadRepoEnv()` sebelum import client | benar (6A) |
| **Next.js** | implicit: Next memuat `.env` dari direktori app (`apps/web`) | **salah** — `.env` ada di root, `apps/web/.env` tidak ada |

### 4.2 Solusi yang dipilih

`apps/web/next.config.ts` memuat `.env` root **secara eksplisit** sebelum config diekspor:

- menelusuri ke atas dari `process.cwd()` dan berhenti hanya di `package.json` yang memiliki `"workspaces"`;
- memakai `process.loadEnvFile()` bawaan Node 26 (tanpa `dotenv`, tanpa dependency baru);
- **fail-fast** bila `DATABASE_URL` tidak ada, dengan pesan yang menyebut nama file, bukan nilainya;
- tidak memakai `NEXT_PUBLIC_*`, tidak memakai `env` di `next.config`, tidak menyalin `.env`, tidak membuat symlink.

Karena `next.config.ts` dievaluasi pada `next dev`, `next build`, dan `next start`, satu mekanisme melayani ketiga mode. Bukti evaluasi muncul di log: `✓ Running next.config.ts took 30ms` (build) dan `✓ Running next.config.ts took 39ms` / `45ms` (start).

### 4.3 Presedensi (diuji, bukan diasumsikan)

`process.loadEnvFile()` **tidak menimpa** variabel yang sudah ada di environment proses. Diuji dengan variabel dummy:

```
process_env_wins_over_file: true
file_loaded_when_absent: true
```

Konsekuensi: CI/production dapat menyuntik `DATABASE_URL` tanpa file `.env`, dan file root tidak pernah menimpa keputusan deployment.

### 4.4 Batasan yang diakui

Karena loader berjalan saat config dievaluasi, `next build` kini **membutuhkan** `DATABASE_URL` meskipun build tidak melakukan koneksi. Ini disengaja (gagal di awal, bukan saat request pertama), tetapi harus disediakan di CI (§16, F-6B-1).

**Status: CLOSED.**

---

## 5. Hasil audit F-6A-6 — npm install scripts

### 5.1 Fakta

| Pemeriksaan | Hasil |
|---|---|
| npm | 11.20.0 |
| `ignore-scripts` | `false` (default global; **tidak** diubah) |
| `allow-scripts` | `[""]` (kosong — belum ada yang disetujui) |
| `allow-scripts-pin` | `true` |
| Perintah yang didukung | `npm install-scripts approve/deny/ls/prune`, opsi `--all`, `--allow-scripts-pin`, `--dry-run`, `--json` |
| Paket yang ditandai | `prisma@7.10.1` (preinstall), `@prisma/engines@7.10.1` (postinstall) |
| Paket lain dengan `prepare` | `deepmerge-ts`, `enhanced-resolve`, `foreground-child`, `lightningcss`, `lru-cache`, `postgres`, `ret`, `signal-exit` — **tidak dijalankan** untuk install dari registry dan tidak ditandai npm |
| Binary engine | `schema-engine-debian-openssl-3.0.x` (23,5 MB) **ada** |
| `prisma generate` | exit 0 sebelum maupun sesudah audit |

### 5.2 Isi script dan risikonya

| Paket | Script | Isi (ringkas) | Risiko |
|---|---|---|---|
| `prisma` | `preinstall` | `require('../preinstall/index.js')` lalu `preinstall.main()`, dibungkus `try/catch` | Rendah — memeriksa lingkungan/versi Node, tidak menulis ke disk proyek |
| `@prisma/engines` | `postinstall` | menjalankan `dist/scripts/postinstall.js`; pada versi dev juga build lokal | **Tertinggi dari keduanya** — mengunduh/menautkan binary engine dari infrastruktur Prisma dan menulis ke `node_modules` |

### 5.3 Keputusan

Kondisi sekarang **berfungsi tetapi tidak eksplisit**: generate berhasil dan engine ada, namun keberhasilannya bergantung pada binary yang sudah terpasang, bukan pada persetujuan yang tercatat. Ini belum aman untuk dipertahankan jangka panjang karena mesin/CI lain bisa mendapat hasil berbeda tanpa peringatan yang jelas.

**Rekomendasi minimal (belum dijalankan, menunggu persetujuan):**

```
npm install-scripts approve prisma @prisma/engines
```

Dua entri saja, ditulis pinned (`allow-scripts-pin=true` default), bukan wildcard, bukan `--all`, bukan `dangerously-allow-all-scripts`. Alternatif tanpa approve: pertahankan blokir dan jadikan keberadaan `schema-engine-*` sebagai gate wajib sebelum `generate`.

Tidak ada `npm config set`, tidak ada `--ignore-scripts=false`, tidak ada allowlist global.

**Status: NEEDS APPROVAL.**

---

## 6. Perubahan file

| File | Perubahan | Alasan |
|---|---|---|
| `apps/web/next.config.ts` | **ditulis ulang** — loader `.env` root, fail-fast `DATABASE_URL`, `serverExternalPackages` | F-6A-4 + driver MariaDB harus tetap Node module |
| `apps/web/src/app/api/health/route.ts` | **baru** — endpoint read-only 200/503 | bukti runtime §8 |
| `apps/web/package.json` | tambah dependency `@affiliateos/database: 0.0.0` | deklarasi workspace yang jujur |
| `packages/database/package.json` | hapus `mariadb`; tambah `main`, `types`, `exports` | F-6A-3 + public API untuk web |
| `packages/database/tsconfig.json` | `declaration: true` | konsumen butuh `.d.ts` |
| `package.json` (root) | tambah `build:database`; `typecheck`/`build` menjalankan build database lebih dulu | web butuh `dist` + `.d.ts` |
| `docs/PHASE-1-CHECKPOINT-6B-REPORT.md` | **baru** | laporan ini |

Tidak diubah: `.gitignore`, `.env`, `.env.example`, `prisma/schema.prisma`, `prisma.config.ts`, `src/client.ts`, `src/env.ts`, `src/index.ts`, seluruh dokumen Phase 0.

---

## 7. Arsitektur Prisma runtime

```
apps/web (Next.js, server only)
   │  import { prisma } from "@affiliateos/database"      ← public API
   ▼
packages/database/dist/src/index.js                        ← build output (git-ignored)
   │  singleton: globalThis.affiliateosPrisma
   ▼
PrismaClient  +  PrismaMariaDb(process.env.DATABASE_URL)
   ▼
mariadb@3.5.4  →  TCP 127.0.0.1:3306  →  affiliateos
```

Aturan yang diterapkan:

| Persyaratan | Implementasi |
|---|---|
| Pakai client hasil generate yang ada | `src/client.ts` meng-import `./generated/prisma/client.js` |
| Tidak membuat client per request | satu instance modul, dimemo di `globalThis` |
| Aman untuk dev & production | memo hanya di non-production; production memakai instance modul |
| Tidak membuka koneksi sebelum env siap | web: `next.config.ts` memuat env lebih dulu; script: `loadRepoEnv()` sebelum dynamic import |
| Tidak ada static import yang mendahului env | entrypoint script memakai `await import("../client.js")` |
| Public API jelas | `exports"." → dist/src/index.js` + `index.d.ts`; hanya `prisma` & `disconnectPrisma` |
| Tidak import internal generated dari web | web hanya menyentuh `@affiliateos/database` |
| Tidak dipakai di Client Component | hanya Route Handler (`runtime = "nodejs"`); tidak ada `"use client"` yang meng-import database |
| Akses DB hanya server | route handler + `serverExternalPackages`; tidak ada `NEXT_PUBLIC_` |
| Credential tidak masuk bundle | diverifikasi §11 |

Module resolution: npm workspaces + `exports` → `dist` (ESM, NodeNext). Build web **wajib** didahului build database; root script sudah mengurutkan (`build:database` → `next build`), dan ini didokumentasikan sebagai F-6B-6.

---

## 8. Strategi environment loading

| Konteks | Mekanisme | File | Eksplisit? |
|---|---|---|---|
| `next build` / `next start` / `next dev` | `next.config.ts` → `process.loadEnvFile(<root>/.env)` | root `.env` | ya |
| Prisma CLI (`validate`, `generate`) | `prisma.config.ts` → `findRepoRoot` + `loadEnvFile` | root `.env` | ya |
| Script Node (`verify:db`) | `src/env.ts` → `loadRepoEnv()` sebelum import client | root `.env` | ya |
| Production/CI tanpa file | environment proses (menang atas file) | — | ya |

Tidak ada: `dotenv`, `.env` di `apps/web`, symlink, `NEXT_PUBLIC_DATABASE_URL`, `env` di `next.config`, duplikasi credential.

---

## 9. Runtime integration Next.js

- Route: `GET /api/health`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- Build mengklasifikasikannya sebagai **ƒ Dynamic** (server-rendered on demand), bukan static — tidak ada query DB yang dijalankan saat build.
- `serverExternalPackages: ["@prisma/client", "@prisma/adapter-mariadb", "mariadb"]` menjaga driver (yang memakai dynamic require) tetap sebagai Node module.
- Halaman `/` dan `/_not-found` tetap static; bundle client tidak bertambah dengan kode database.

---

## 10. Runtime database verification

### 10.1 Skenario A — konfigurasi root normal (port 3123)

```
GET /api/health
HTTP/1.1 200 OK
cache-control: no-store
content-type: application/json

{"status":"ok","database":"up"}
```

### 10.2 Skenario B — `DATABASE_URL` diarahkan ke port mati 3999 (port 3125)

```
GET /api/health
HTTP/1.1 503 Service Unavailable
cache-control: no-store
content-type: application/json

{"status":"unavailable","database":"down"}
```

Tidak ada pesan driver, host, user, stack trace, atau detail koneksi di body maupun header.

Catatan kejujuran: percobaan pertama pada skenario B mengembalikan `000` karena server belum selesai listen saat curl dijalankan — itu **bukan** bukti 503 dan tidak diklaim sebagai bukti. Pengujian diulang dengan menunggu kesiapan server dan menghasilkan 503 di atas.

### 10.3 Lifecycle

Kedua server dijalankan oleh agent (`next start`) dan **dihentikan oleh agent**: `remaining listeners: 0` setelah `kill`. Tidak ada proses milik user yang disentuh.

---

## 11. Security audit

### 11.1 Environment

| Pemeriksaan | Hasil |
|---|---|
| `.env` ignored | `.gitignore:40` |
| `.env` tracked | 0 |
| `.env.example` | hanya nama + placeholder, 0 baris bernilai |
| Credential tercetak di output/log | 0 (semua log server: 0 match untuk `mysql://`, `affiliateos_dev`, `healthprobe`) |

### 11.2 Bundle & client exposure (dipindai aktual)

| Target | File | Hasil |
|---|---|---|
| `apps/web/.next` (server + client) | 191 | password 0, full URL 0, pola `mysql://…@` 0 |
| `apps/web/.next/static` (client bundle) | 10 | username/password/`mysql://` 0 |
| Seluruh tree (tanpa `node_modules`, `.next`, `dist`, `generated`) | 8.648 | password hanya di `.env` |

### 11.3 Database

| Aturan | Status |
|---|---|
| Hanya `affiliateos` dipakai runtime | PASS (`DATABASE_URL` menunjuk schema itu; health hanya `SELECT 1`) |
| Tidak mengubah privilege | PASS — `SHOW GRANTS` tetap 3 baris, tanpa `ALL PRIVILEGES`, tanpa `GRANT OPTION` |
| Tidak membuat database/user | PASS |
| Tidak mengakses schema aplikasi lain | PASS |
| Tidak ada DDL/DML | PASS — hanya `SELECT 1` dan query metadata `information_schema` |
| Shadow database tidak disentuh | PASS |

### 11.4 Next.js

| Aturan | Status |
|---|---|
| Prisma hanya server | PASS — hanya Route Handler, `runtime = "nodejs"`, tanpa Client Component |
| Secret tidak di client bundle | PASS — 0 hit |
| Error tidak membocorkan credential | PASS — body 503 hanya dua field status |
| Tidak ada endpoint SQL bebas | PASS — route tanpa parameter/body; query hard-coded `SELECT 1` |

### 11.5 Git

| Aturan | Status |
|---|---|
| Tanpa commit/push | PASS — HEAD `5b5d061`, 1 commit, tanpa remote |
| Tanpa reset/clean/stash/force checkout | PASS |
| Generated client ignored | PASS — `.gitignore:32` |
| Tracked generated / env | 0 / 0 |

---

## 12. Dependency audit

```
affiliateos@0.0.0
└─┬ @affiliateos/database@0.0.0 -> ./packages/database
  ├── @prisma/adapter-mariadb@7.10.1
  ├─┬ @prisma/client@7.10.1
  │ └── prisma@7.10.1 deduped
  └── prisma@7.10.1
```

| Paket | Versi | Catatan |
|---|---|---|
| `next` | 16.4.6 | Turbopack, build 5 detik |
| `react` / `react-dom` | 19.3.1 / 19.3.1 | memenuhi peer |
| `typescript` | 7.0.2 | typecheck + build Next |
| `prisma` / `@prisma/client` | 7.10.1 / 7.10.1 | selaras |
| `@prisma/adapter-mariadb` | 7.10.1 | Query Compiler |
| `mariadb` | 3.5.4 | **1 copy**, transitif (direct pin dihapus) |
| `tailwindcss` / `@tailwindcss/postcss` | 4.3.5 / 4.3.5 | — |

`npm install` setelah perubahan manifest: exit 0, `removed 1 package in 520ms`, tanpa dependency baru.

---

## 13. Database safety verification

| Pemeriksaan | Hasil |
|---|---|
| Tabel di `affiliateos` + `affiliateos_shadow` | **tidak ada** |
| Collation | `utf8mb4_unicode_ci` pada keduanya |
| Grant | 3 baris, tanpa `ALL PRIVILEGES`, tanpa `GRANT OPTION` |
| Direktori `prisma/migrations` | **ABSENT** |
| Perintah `migrate*` / `db push` / `db pull` | tidak pernah dijalankan |
| Shadow database | tidak disentuh |
| Query yang dieksekusi | `SELECT 1`, `VERSION()`, `DATABASE()`, `CURRENT_USER()` (6A), metadata `information_schema` |

---

## 14. Typecheck dan build

| # | Perintah | Exit | Hasil |
|---|---|---|---|
| 1 | `npm install --no-audit --no-fund` | 0 | `removed 1 package in 520ms` |
| 2 | `npm ls mariadb --all` | 0 | 1 jalur, 1 copy |
| 3 | `npm run validate` | 0 | `The schema at prisma/schema.prisma is valid 🚀` |
| 4 | `npm run generate` | 0 | Generated Prisma Client 7.10.1, 18 ms |
| 5 | `npm run build:database` | 0 | generate + `tsc`, **13 `.d.ts`** termasuk `dist/src/index.d.ts` |
| 6 | `npm run typecheck` | 0 | web `tsc --noEmit` + database `tsc --noEmit` |
| 7 | `npm run build` | 0 | Next 16.4.6: compile 1,18 s, total 5 s; `/` static, `/_not-found` static, `/api/health` dynamic |
| 8 | `GET /api/health` (DB hidup) | 200 | `{"status":"ok","database":"up"}` |
| 9 | `GET /api/health` (DB mati) | 503 | `{"status":"unavailable","database":"down"}` |
| 10 | Secret scan bundle/tree | — | 0 hit di `.next`, hanya `.env` di tree |
| 11 | DB safety | — | tabel 0, collation sama, grant tetap |
| 12 | Git | — | HEAD tetap, staged 0 |

RAM tersedia setelah build: **2.817 MB** (dari 7.174 MB). Tidak ada kegagalan resource; tidak ada build paralel; tidak ada install ulang total.

---

## 15. Git status

```
## main
?? .env.example
?? apps/
?? docs/PHASE-1-CHECKPOINT-3-REPORT.md
?? docs/PHASE-1-CHECKPOINT-4-REPORT.md
?? docs/PHASE-1-CHECKPOINT-5-REPORT.md
?? docs/PHASE-1-CHECKPOINT-6A-REPORT.md
?? docs/PHASE-1-CHECKPOINT-6B-REPORT.md
?? package-lock.json
?? package.json
?? packages/
```

`HEAD=5b5d061`, total commit 1, staged 0, `git diff HEAD` kosong, diff dokumen Phase 0 = 0 baris. Ignored: `.env`, `node_modules/`, `.next/`, `dist/`, `generated/prisma/`, `next-env.d.ts`, `*.tsbuildinfo`.

---

## 16. Findings dan limitations

### 16.1 Temuan

| ID | Severity | Status | Uraian |
|---|---|---|---|
| F-6A-3 | Low | **CLOSED** | Direct pin `mariadb` redundan; dihapus, tetap 1 copy 3.5.4 transitif. Addendum §1/§12 menyebut 3.5.5 — keliru, perlu revisi tertulis (dokumen tidak diubah di sini). |
| F-6A-4 | Medium | **CLOSED** | `next.config.ts` memuat `.env` root eksplisit; presedensi lingkungan proses diuji; build & start membuktikan config dievaluasi. |
| F-6A-6 | Medium | **NEEDS APPROVAL** | Hanya `prisma` (preinstall) dan `@prisma/engines` (postinstall) perlu izin. Rekomendasi: `npm install-scripts approve prisma @prisma/engines` (pinned). Belum dijalankan. |
| **F-6B-1** | Medium | OPEN | `next build` kini mewajibkan `DATABASE_URL` di environment (fail-fast). CI harus menyediakannya walau build tidak connect. |
| **F-6B-2** | Low | OPEN | Health endpoint tanpa autentikasi/rate limit; informasi yang bocor hanya status up/down. Dapat diterima untuk internal, tetapi jangan dijadikan endpoint publik tanpa pembatasan. |
| **F-6B-3** | Low | OPEN | Opsi pool (`connectionLimit`), timeout, dan `timezone: "Z"` masih default adapter dan belum diukur. |
| **F-6B-4** | Low | OPEN | Client masih model-less; health memakai `$queryRaw`. API model baru bisa diuji setelah schema + migration. |
| **F-6B-5** | Low | OPEN | Build web bergantung pada `dist` package database. Root script sudah benar; menjalankan `build -w @affiliateos/web` sendirian akan gagal. |
| **F-6B-6** | Info | ACCEPTED | `next build` menulis `next-env.d.ts`/`.next` (ignored). `tsconfig.json` web tidak berubah lagi di 6B. |

### 16.2 Limitations (tidak diklaim selesai)

1. **Dev mode (`next dev`) belum dijalankan** — hanya `next build` + `next start`. Perilaku HMR dan reuse singleton di dev belum dibuktikan.
2. **Belum ada model/migration** — sesuai larangan; `migrate`, `db push`, `db pull` tidak dijalankan.
3. **Shadow database belum diuji fungsional.**
4. **Tidak ada test otomatis** (unit/integration/e2e) — verifikasi masih manual dan berbasis bukti perintah.
5. **Belum ada CI**, sehingga gate seperti pemeriksaan `schema-engine` belum ada.
6. **Belum ada authentication/otorisasi** (di luar scope) — health endpoint sengaja minimal.
7. **Connection lifecycle di bawah beban** (pool exhaustion, reconnect) belum diukur.

---

## 17. Rekomendasi Checkpoint 6C

1. **Setujui allowlist install script** (F-6A-6) sebelum menyentuh migration, lalu tambahkan gate keberadaan `schema-engine-*`.
2. **Verifikasi dev mode** (`next dev`) dan pastikan hot-reload tidak membuka pool baru; ukur jumlah koneksi.
3. **Model baseline + migration pertama** (butuh persetujuan terpisah; `affiliateos_shadow` sudah siap dan kosong).
4. **Bangun `withTenant(ctx)` / `systemDb()`** dan hentikan ekspor client mentah dari `packages/database`.
5. **Konfigurasi pool eksplisit** (`connectionLimit`, `timezone: "Z"`) dan uji perilaku `DECIMAL(18,2)`/`CHAR(36)`/`JSON`/composite FK setelah tabel ada.
6. **Tambahkan test otomatis** untuk health endpoint (200/503) agar tidak bergantung pada verifikasi manual.
7. **Sediakan `DATABASE_URL` di pipeline build** (F-6B-1) dan jalankan `prisma validate` + generate sebelum typecheck.

---

## 18. Status akhir

# **PASS WITH LIMITATIONS**

Yang terbukti: Next.js membaca `.env` root secara eksplisit (bukan kebetulan), memakai Prisma lewat public API, dan health endpoint mengembalikan **200** saat DB hidup serta **503** saat DB tidak terjangkau, tanpa credential di body, log, client bundle, maupun Git. Database tidak berubah, tidak ada migration, tidak ada commit.

Yang membatasi: **dev mode belum diuji**, allowlist install script masih **NEEDS APPROVAL**, dan client masih model-less sehingga API model belum terbukti.

**STOP.** Checkpoint 6C tidak dimulai. Tidak ada commit atau push. Menunggu persetujuan eksplisit.
