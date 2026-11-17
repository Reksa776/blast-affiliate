# AffiliateOS — Phase 1 Checkpoint 6B.1 Report
## Operational Readiness, npm Script Approval & Dev/HMR Verification

**Date:** 2026-11-16
**Status:** **PASS** — allowlist install script aktif tepat dua paket (pinned), Next dev berjalan, HMR terbukti mengganti modul, jumlah koneksi MariaDB tetap **11** (10 pool + 1 koneksi pengukuran) melalui 15 request dan dua siklus HMR, singleton Prisma aman, typecheck + production build exit 0, database tidak berubah.

---

## 1. Executive summary

| Kriteria PASS | Bukti | Hasil |
|---|---|---|
| Allowlist tepat dua paket, aktif | `package.json` → `allowScripts` dua entri pinned; `npm install-scripts ls` → "No packages with unreviewed install scripts." | ✅ |
| Next dev berhasil | `✓ Ready in 268ms`, `next.config.ts` dimuat, `/api/health` → 200 | ✅ |
| HMR berhasil | marker halaman muncul lalu hilang, probe route muncul lalu hilang, `✓ Compiled in 12ms/9ms` | ✅ |
| Tidak ada pertumbuhan instance/koneksi | 11 → 11 → 11 → 11 (15 request + 2 HMR) | ✅ |
| Singleton Prisma aman | satu modul instance + memo `globalThis`; tidak ada `$disconnect` per request | ✅ |
| Root environment loading | dev server memakai `.env` root; simulasi CI tanpa file gagal bernama, dengan env dummy lolos | ✅ |
| CI/build terdokumentasi | script root diperiksa; belum ada workflow; dua cabang loader diuji | ✅ |
| Typecheck + build | exit 0 / exit 0 | ✅ |
| Security audit bersih | 333 file build, 39 file dist, 38 file tree → 0 secret | ✅ |
| Database tidak berubah | 0 tabel, 0 migration, grant tidak berubah | ✅ |

Tiga temuan lama ditutup: **F-6A-3 CLOSED**, **F-6A-4 CLOSED**, **F-6A-6 CLOSED**. Satu temuan baru yang material: **pool MariaDB membuka 10 koneksi idle secara default** (F-6B-3, OPEN) — konstan, bukan kebocoran, tetapi perlu dikonfigurasi eksplisit di 6C.

---

## 2. Kondisi awal repository

| Item | Nilai |
|---|---|
| HEAD | `5b5d061cc74b43a208684776f656212a64d764bd`, 1 commit |
| Branch / remote | `main`, tanpa remote |
| Staged | 0 |
| Tracked modification | tidak ada (sebelum koreksi dokumentasi §12) |
| Untracked | `.env.example`, `apps/`, `packages/`, `package.json`, `package-lock.json`, 5 laporan checkpoint |
| `.env` | mode `600`, owner `reksa`, root repo, 2 variabel |
| `.env` tracked | 0 |
| Process Next.js | **tidak ada** (`ss` bersih, `pgrep` kosong) |
| Node / npm | v26.13.0 / 11.20.0 |
| `packages/database/dist` | ada |
| Dependency | Prisma 7.10.1, adapter 7.10.1, Next 16.4.6, TS 7.0.2, driver 3.5.4 (transitif) |

Laporan 6A/6B tidak diasumsikan benar: seluruh angka di bawah diukur ulang pada checkpoint ini.

---

## 3. Audit npm install scripts

| Pemeriksaan | Hasil |
|---|---|
| `npm -v` | **11.20.0** |
| `npm install-scripts --help` | mendukung `approve`, `deny`, `ls`, `prune`, `--all`, `--allow-scripts-pin`, `--dry-run`, `--json` |
| `npm install-scripts ls` (sebelum) | 2 paket belum ditinjau: `@prisma/engines@7.10.1` (postinstall), `prisma@7.10.1` (preinstall) |
| `npm config get ignore-scripts` | `false` (default global; **tidak diubah**) |
| `npm config get allow-scripts-pin` | `true` |
| `npm config get dangerously-allow-all-scripts` | `false` |
| `npm config get allow-scripts` | kosong sebelum persetujuan |
| Versi di `node_modules` | `prisma@7.10.1`, `@prisma/engines@7.10.1` |
| Versi di `package-lock.json` | `7.10.1`, `7.10.1` — **cocok** |
| Isi script | `prisma`: `node scripts/preinstall-entry.js` (memeriksa lingkungan, `try/catch`); `@prisma/engines`: `node scripts/postinstall.js` (menjalankan `dist/scripts/postinstall.js`, menyiapkan binary engine) |
| Perubahan global yang diperlukan | **tidak ada** |

Isi script identik dengan audit 6B — tidak ada perbedaan yang perlu dicatat.

---

## 4. Daftar allowlist sesudah perubahan

Perintah yang dijalankan (hanya ini):

```
npm install-scripts approve prisma @prisma/engines
```

Keluaran: `Approved prisma: added prisma@7.10.1`, `Approved @prisma/engines: added @prisma/engines@7.10.1`, exit **0**.

| Item | Hasil |
|---|---|
| Field di `package.json` | `"allowScripts": { "prisma@7.10.1": true, "@prisma/engines@7.10.1": true }` |
| Pinned | **ya** — nama@versi, bukan nama polos |
| Wildcard | **tidak ada** |
| Jumlah entri | **2** |
| `package-lock.json` | **tidak berubah** (`diff -q` bersih) |
| `.npmrc` proyek / user | **tidak dibuat** |
| `ignore-scripts` global | tetap `false` (tidak disentuh) |
| `npm install-scripts ls` (sesudah) | `No packages with unreviewed install scripts.` |

**Status F-6A-6: CLOSED.**

Keterbatasan: script tidak dieksekusi ulang pada checkpoint ini (tidak ada reinstall penuh, sesuai aturan resource). Bukti bahwa mekanisme aktif adalah allowlist pinned + `ls` bersih; keberadaan `schema-engine-debian-openssl-3.0.x` sudah diverifikasi di 6B.

---

## 5. Audit Prisma singleton

File yang diaudit: `packages/database/src/client.ts`, `env.ts`, `index.ts`, `package.json`, `apps/web/next.config.ts`, dan seluruh pemakaian `@affiliateos/database`.

| Pertanyaan | Temuan |
|---|---|
| Instance dibuat berulang? | **Tidak** — satu `createPrismaClient()` di module scope, dipanggil sekali per evaluasi modul |
| `globalThis` benar? | Ya — `globalForPrisma.affiliateosPrisma`, hanya di-set saat `NODE_ENV !== "production"` |
| Dev hot reload bisa membuat instance baru? | Modul dapat dievaluasi ulang, tetapi memo `globalThis` mengembalikan instance lama; dibuktikan §7 (koneksi konstan setelah 2 HMR) |
| Production satu instance? | Ya — modul singleton per proses; package di-*externalize* (`serverExternalPackages`), sehingga Node me-*cache* modul dan tidak menggandakannya per route |
| `$disconnect()` per request? | **Tidak** — hanya diekspor sebagai `disconnectPrisma()` untuk script/test; route health tidak memanggilnya |
| Koneksi dibuat saat import? | Ya, pool dibuat saat modul dievaluasi — karena itu env dimuat lebih dulu (dev: `next.config.ts`; script: `loadRepoEnv()` sebelum dynamic import) |
| Env tersedia sebelum adapter? | Terbukti: dev server start tanpa `apps/web/.env`, health 200 |
| Import generated client dari web? | **Tidak** — hanya `import { prisma } from "@affiliateos/database"` |
| Public API terlalu lebar? | Tidak — hanya `prisma` dan `disconnectPrisma`; `exports` menunjuk `dist/src/index.js` |

Tidak ada masalah yang memerlukan perubahan kode. Tidak ada `withTenant`/`systemDb` yang dibuat (di luar scope).

---

## 6. Pengujian Next.js development mode

| Item | Hasil |
|---|---|
| Perintah | `npm run dev --workspace @affiliateos/web -- -p 3126` |
| Port | 3126 (3000/3120–3125 bebas; tidak ada proses user) |
| Startup | `✓ Ready in 268ms`, `✓ Running next.config.ts took 31ms` |
| Module resolution | tidak ada error; route `/` dan `/api/health` terkompilasi |
| Prisma adapter / generated client | tidak ada error |
| Root `.env` | dimuat (health 200; `apps/web/.env` tidak ada) |
| `GET /api/health` | **200** `{"status":"ok","database":"up"}` |
| Credential di log | **0** (`mysql://` 0, nama user 0, password 0) |

---

## 7. Pengujian HMR

Metode: perubahan sementara + marker yang dapat diamati pada output server, lalu pemulihan dengan verifikasi hash. Tanpa browser, sehingga bukti diambil dari respons server (SSR/route), bukan overlay HMR di klien.

| Langkah | Hasil |
|---|---|
| Baseline `/` | 200, `HMRMARK1` **tidak ada** |
| Edit `page.tsx` (tambah `HMRMARK1`) | `/` → 200, marker **ada** → modul dievaluasi ulang |
| Pulihkan `page.tsx` | `/` → 200, marker **hilang**, sha256 **match** |
| Baseline health | `probe` **tidak ada** |
| Edit `route.ts` (tambah `probe: "HMRMARK2"`) | health → `{"status":"ok","database":"up","probe":"HMRMARK2"}` |
| Pulihkan `route.ts` | health 200 tanpa `probe`, sha256 **match** |
| Log dev | `✓ Compiled in 12ms`, `✓ Compiled in 9ms` |
| Koneksi sebelum / sesudah siklus | **11 / 11** |
| Sisa perubahan di tree | **tidak ada** (`HMRMARK`/`hmr-probe` = 0 hit) |

HMR berhasil dan tidak menambah instance/koneksi.

---

## 8. Audit jumlah koneksi MariaDB

Metode: `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='affiliateos_dev'` (read-only). Koneksi pengukuran itu sendiri termasuk dalam hitungan → **offset +1**. User tidak memiliki privilege `PROCESS`, sehingga koneksi milik user lain tidak terlihat; semua baris yang terlihat memakai DB `affiliateos`.

| Titik pengukuran | Jumlah | Keterangan |
|---|---|---|
| Setelah dev server ready, sebelum burst | **11** | 10 pool + 1 pengukuran |
| Setelah 5 request health | **11** | tidak ada penambahan |
| Setelah HMR `page.tsx` | **11** | tidak ada penambahan |
| Setelah HMR `route.ts` + 5 request | **11** | tidak ada penambahan |
| Setelah pemulihan file | **11** | stabil |
| Setelah server dihentikan | **1** | hanya koneksi pengukuran → pool ditutup bersama proses |

Detail pool saat diam: 10 koneksi `Sleep` pada `affiliateos`. Ini adalah **default driver `mariadb` (connectionLimit 10)**, bukan kebocoran: jumlahnya konstan dan tidak bertambah seiring request atau HMR. Namun 10 koneksi idle per proses terlalu besar untuk mesin 7 GiB dengan web + worker, sehingga dicatat sebagai **F-6B-3 (OPEN)** dan direkomendasikan dikonfigurasi eksplisit di 6C.

---

## 9. Root environment loading

| Konteks | Bukti |
|---|---|
| Dev server | start tanpa `apps/web/.env`; health 200 → `.env` root terbaca |
| Build | `✓ Running next.config.ts took 30ms` (6B) / 31ms (6B.1) |
| Precedence | `loadEnvFile` tidak menimpa env proses (diuji 6B: `process_env_wins_over_file: true`) |
| Env proses tanpa file | simulasi §10: exit 0 tanpa output |
| Tanpa env & tanpa file | simulasi §10: exit 1 dengan pesan bernama, bukan stack yang membocorkan nilai |

Tidak ada `NEXT_PUBLIC_DATABASE_URL`; satu-satunya kemunculan `NEXT_PUBLIC` di repo adalah komentar di `next.config.ts`.

---

## 10. CI/build environment audit

### 10.1 Script root

```
generate, validate, verify:db, build:database, typecheck, build
```

Urutan: `typecheck` dan `build` menjalankan `build:database` lebih dulu (generate + `tsc` + `.d.ts`), baru web. Build web **bergantung** pada `packages/database/dist` dan pada `.env` root atau `DATABASE_URL` di environment.

### 10.2 Simulasi CI (kode nyata, bukan salinan)

Dijalankan dari workspace sementara tanpa `.env`, memakai file `apps/web/next.config.ts` yang sebenarnya:

| Skenario | Exit | Hasil |
|---|---|---|
| Tanpa `.env`, tanpa `DATABASE_URL` | **1** | `Error: Next.js requires DATABASE_URL…` (menyebut path file, bukan nilai) |
| Tanpa `.env`, `DATABASE_URL` dummy di env proses | **0** | 0 baris output, tidak ada koneksi database (config hanya membaca env) |

### 10.3 Fakta lain

- `.github/` **tidak ada**; workflow CI = **0**.
- `.env.example` hanya nama + placeholder, 0 baris bernilai.
- Tidak ada credential di file konfigurasi mana pun.

### 10.4 Rekomendasi

1. `DATABASE_URL` **wajib** saat build karena loader fail-fast. Sediakan lewat secret store CI sebagai environment variable (bukan file yang di-commit).
2. Nilai dummy aman untuk job yang hanya build; build tidak melakukan koneksi.
3. Jika kelak build harus berjalan tanpa DB env sama sekali, ubah loader agar melewati pengecekan hanya pada fase build — keputusan arsitektur, jadi **tidak dilakukan** di checkpoint ini.
4. Tambahkan `prisma validate` + `prisma generate` sebagai langkah eksplisit sebelum typecheck saat CI dibuat.

---

## 11. Dependency audit

| Paket | Versi | Catatan |
|---|---|---|
| `next` | 16.4.6 | dev + build berhasil |
| `react` / `react-dom` | 19.3.1 | — |
| `typescript` | 7.0.2 | typecheck 0 |
| `prisma` / `@prisma/client` | 7.10.1 / 7.10.1 | selaras |
| `@prisma/adapter-mariadb` | 7.10.1 | — |
| `mariadb` | **3.5.4** | 1 copy, transitif dari adapter (direct pin dihapus di 6B) |
| `tailwindcss` | 4.3.5 | — |

`npm install-scripts approve` tidak mengubah dependency tree maupun lockfile.

---

## 12. Dokumentasi yang dikoreksi

`docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md` masih menyebut driver **3.5.5** padahal adapter mendeklarasikan **3.5.4**. Koreksi dilakukan hanya pada bagian yang relevan:

| Baris | Sebelum | Sesudah |
|---|---|---|
| 23 | `mariadb 3.5.5 (transitive)` | `mariadb 3.5.4 (transitive) — corrected in Checkpoint 6B.1; see §12` |
| 57 | `Vendor driver (mariadb 3.5.5)` | `... (mariadb 3.5.4)` |
| 193 | `Driver: mariadb 3.5.5` | `Driver: mariadb 3.5.4` |
| 391 | `"mariadb": "3.5.5"` | `"mariadb": "3.5.4"` |
| 410 | bullet direct dependency 3.5.5 | menjelaskan 3.5.4 transitif + alasan direct pin dihapus di 6B |

Diff: `1 file changed, 9 insertions(+), 7 deletions(-)`. Tidak ada keputusan arsitektur Phase 0 yang diubah; tujuh dokumen Phase 0 lainnya **unchanged** (diverifikasi per file). Laporan checkpoint sebelumnya tidak diubah.

---

## 13. Health endpoint audit

| Persyaratan | Status |
|---|---|
| Hanya `SELECT 1 AS health` | ✅ satu-satunya query |
| Tidak menerima SQL dari user | ✅ tidak ada parameter/body/query string |
| Tidak mengembalikan credential | ✅ body hanya `status`/`database` |
| Tidak mengembalikan stack trace | ✅ `catch` menelan detail |
| `Cache-Control: no-store` | ✅ di kedua jalur |
| Error response minimal | ✅ `{"status":"unavailable","database":"down"}` |
| Runtime Node.js | ✅ `export const runtime = "nodejs"` |
| Tidak static-render | ✅ `dynamic = "force-dynamic"`; build 6B.1 menandainya `ƒ` |
| 200/503 sesuai kondisi | ✅ dibuktikan 6B (200 & 503) dan 6B.1 dev (200) |

**Risiko:** endpoint tidak terautentikasi dan tanpa rate limit. Informasi yang bocor hanya status up/down, tetapi sebelum deployment publik perlu kebijakan (batasi ke jaringan internal / tambahkan rate limit). Tidak ditambahkan sekarang karena itu keputusan arsitektur.

---

## 14. Security audit

| Pemeriksaan | Hasil |
|---|---|
| `.env` tracked | 0 |
| `.env` permission | `600` |
| `.env.example` | nama + placeholder, tanpa nilai |
| Secret di build output (`.next`, 333 file) | password 0, full URL 0, pola `mysql://…@` 0 |
| Secret di client bundle (`static`, 10 file) | 0 |
| Secret di `dist` package database (39 file) | 0 |
| Secret di tree (38 file, tanpa build/deps) | hanya `.env` |
| Secret di log dev | 0 (password, `mysql://`, nama user) |
| Generated client di-ignore | ya (`.gitignore:32`) |
| Allowlist tambahan | tidak ada (tepat 2) |
| Perubahan privilege DB | tidak ada |
| Akses database lain | tidak ada |

---

## 15. Database safety verification

| Pemeriksaan | Hasil |
|---|---|
| Tabel di `affiliateos` + `affiliateos_shadow` | **0** |
| Collation | `utf8mb4_unicode_ci` pada keduanya |
| Grant | 3 baris, tanpa `ALL PRIVILEGES`, tanpa `GRANT OPTION` |
| `prisma/migrations` | **ABSENT** |
| `migrate*` / `db push` / `db pull` | tidak dijalankan |
| Shadow database | tidak disentuh |
| Query yang dijalankan | hanya `SELECT 1`, `SELECT COUNT(*) FROM information_schema.PROCESSLIST`, metadata `information_schema` |
| Koneksi setelah pengujian | 1 (hanya pengukuran) |

---

## 16. Typecheck dan build

| # | Perintah | Exit | Hasil |
|---|---|---|---|
| 1 | `npm install-scripts ls` (sebelum) | 0 | 2 paket pending |
| 2 | `npm install-scripts approve prisma @prisma/engines` | 0 | 2 entri pinned |
| 3 | `npm install-scripts ls` (sesudah) | 0 | tidak ada yang unreviewed |
| 4 | `npm run dev -p 3126` | (server) | Ready 268ms |
| 5 | `GET /api/health` (dev) | 200 | `{"status":"ok","database":"up"}` |
| 6 | HMR page + route | — | marker muncul/hilang, 2× `✓ Compiled` |
| 7 | Pengukuran PROCESSLIST (5 titik) | 0 | 11 konstan; 1 setelah stop |
| 8 | Simulasi CI tanpa env | 1 | error bernama (diharapkan) |
| 9 | Simulasi CI dengan env dummy | 0 | tanpa output |
| 10 | `npm run typecheck` | **0** | database + web |
| 11 | `npm run build` | **0** | Next 16.4.6, `/api/health` dynamic |
| 12 | Secret scan .next / static / dist / tree | 0 | 0 hit selain `.env` |
| 13 | DB safety | 0 | lihat §15 |
| 14 | Git | — | HEAD tetap, staged 0 |

RAM tersedia setelah seluruh pengujian: 2.536 MB. Tidak ada build paralel, tidak ada reinstall penuh.

---

## 17. Git status

```
 M docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md
?? .env.example
?? apps/
?? docs/PHASE-1-CHECKPOINT-3-REPORT.md
?? docs/PHASE-1-CHECKPOINT-4-REPORT.md
?? docs/PHASE-1-CHECKPOINT-5-REPORT.md
?? docs/PHASE-1-CHECKPOINT-6A-REPORT.md
?? docs/PHASE-1-CHECKPOINT-6B-REPORT.md
?? docs/PHASE-1-CHECKPOINT-6B1-REPORT.md
?? package-lock.json
?? package.json
?? packages/
```

`HEAD=5b5d061`, staged 0, tanpa commit/push/reset/stash. Satu-satunya tracked modification adalah `docs/06` (koreksi yang diotorisasi §10). `package.json` berubah tetapi masih untracked.

---

## 18. Findings dan limitations

| ID | Severity | Status | Uraian |
|---|---|---|---|
| F-6A-3 | Low | **CLOSED** | Driver 3.5.4 transitif, 1 copy; addendum dikoreksi. |
| F-6A-4 | Medium | **CLOSED** | Root env terbukti dipakai di dev **dan** build; presedensi env proses diuji. |
| F-6A-6 | Medium | **CLOSED** | Allowlist tepat 2 paket, pinned, aktif; lockfile dan konfigurasi global tidak berubah. |
| F-6B-1 | Medium | **OPEN** | `next build` mewajibkan `DATABASE_URL`. Kedua cabang diuji; CI harus menyediakan env (dummy aman untuk build). |
| F-6B-3 | **Medium** | **OPEN** | Pool membuka **10 koneksi idle** (default driver). Konstan, bukan kebocoran, tetapi terlalu besar untuk web+worker. Perlu `connectionLimit` eksplisit di 6C. |
| F-6B-2 | Low | **ACCEPTED WITH REASON** | `/api/health` tanpa auth/rate limit; informasi minimal. Diterima untuk internal, wajib ditinjau sebelum publik. |
| F-6B-5 | Low | **ACCEPTED WITH REASON** | Build web bergantung pada `dist` database; root script mengurutkan dengan benar. |
| F-6B.1-1 | Info | **ACCEPTED WITH REASON** | HMR diuji tanpa browser; bukti diambil dari respons server (marker SSR/route), bukan overlay klien. |
| F-6B.1-2 | Low | **OPEN** | Jumlah koneksi diukur tanpa privilege `PROCESS`, sehingga hanya koneksi user ini yang terlihat; koneksi pengukuran menambah offset +1. |
| F-6B.1-3 | Info | **OPEN** | `docs/06` kini modified (belum di-commit) — perlu disertakan saat commit berikutnya. |

### Limitations

1. Script lifecycle tidak dieksekusi ulang (tanpa reinstall); keberadaan binary engine dari 6B.
2. HMR tidak diuji dengan browser/hot-update klien.
3. Belum ada model, migration, atau typed query; shadow DB belum diuji fungsional.
4. Pool/timezone/timeout belum dikonfigurasi; angka 10 adalah default.
5. Belum ada CI nyata; simulasi hanya menguji loader config.
6. Health endpoint belum terautentikasi.

---

## 19. Rekomendasi Checkpoint 6C

1. **Konfigurasi pool eksplisit** (`connectionLimit` web/worker, `timezone: "Z"`, timeout) dan ukur ulang dengan metode §8.
2. **Model baseline + migration pertama** (butuh otorisasi terpisah; `affiliateos_shadow` kosong dan siap).
3. **`withTenant(ctx)` / `systemDb()`** dan hentikan ekspor client mentah.
4. **Test otomatis** untuk `/api/health` (200/503) dan singleton, menggantikan verifikasi manual.
5. **CI pipeline**: sediakan `DATABASE_URL` (dummy untuk build), jalankan `prisma validate` + generate sebelum typecheck.
6. **Kebijakan health endpoint** sebelum deployment publik (internal-only atau rate limit).

---

## 20. Status akhir

# **PASS**

Semua kriteria PASS di §1 terpenuhi dengan bukti yang dijalankan pada kondisi repository aktual:

- allowlist **tepat dua** paket, pinned, aktif, tanpa wildcard, tanpa perubahan konfigurasi global;
- `next dev` berjalan dan membaca `.env` root;
- HMR terbukti mengganti modul (marker muncul lalu hilang) tanpa menambah koneksi;
- koneksi MariaDB **stabil 11** (10 pool + 1 pengukuran) melalui 15 request dan 2 siklus HMR, dan kembali ke 1 setelah server dihentikan;
- singleton Prisma aman: satu instance, memo `globalThis`, tanpa `$disconnect` per request;
- typecheck dan production build exit 0;
- security scan bersih (0 secret di 333 + 39 + 38 file);
- database tidak berubah: 0 tabel, 0 migration, grant tetap;
- tidak ada commit, push, atau proses yang tertinggal.

Keterbatasan di §18 dicatat sebagai pekerjaan 6C, bukan kegagalan yang disembunyikan.

**STOP.** Checkpoint 6C tidak dimulai. Menunggu persetujuan eksplisit.
