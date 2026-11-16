# PHASE 1 — CHECKPOINT 1 REPORT

## Version Compatibility Spike

- **Tanggal:** 2026-11-16
- **Lingkup:** verifikasi kompatibilitas stack saja (Next 16, Prisma 7, TypeScript 7, Tailwind 4, Node 26)
- **Status keseluruhan:** **PASS WITH LIMITATIONS**
- **Tidak ada** fitur AffiliateOS, schema aplikasi, migration, Redis, Docker, sudo, `git init`, atau commit yang dibuat.

---

## 1. Environment Aktual

| Properti | Perintah | Hasil |
|---|---|---|
| OS | `uname -a` | Debian GNU/Linux 13 (trixie), kernel 6.12.116+deb13-amd64, x86_64 |
| Node.js | `node -v` | **v26.13.0** |
| npm | `npm -v` | **11.20.0** |
| RAM | `free -m` | 7174 MiB total, ±3227 MiB available |
| Disk (spike) | `df -h /tmp` | tmpfs 3.6 G, 3.5 G tersedia |
| MariaDB | `mysql --version` (Phase 0) | 11.8.6-MariaDB (server aktif, tetap tanpa kredensial aplikasi) |
| Redis | `which redis-server` | tidak ada |
| Docker | `which docker` | tidak ada |
| sudo | — | tetap tidak tersedia non-interaktif (tidak dipakai) |
| Git | `git status` | tetap bukan repository |
| Direktori spike | `mktemp -d /tmp/affiliateos-spike.XXXXXX` | `/tmp/affiliateos-spike.L6q6Lx` (di luar project, sudah dihapus) |

Project utama tidak disentuh selama spike. Checksum 7 dokumen Phase 0 diambil sebelum
spike dan diverifikasi ulang setelah spike — **tidak berubah** dan tidak diedit.

---

## 2. Versi Dependency Aktual

Semua versi di-pin eksak (tanpa `^`/`~`), sesuai ADR-002 (npm) dan catatan Phase 0 §5.

| Package | Versi terpasang | Engines yang dipublikasikan |
|---|---|---|
| next | **16.4.6** | node `>=20.9.0` |
| react | **19.3.1** | — |
| react-dom | **19.3.1** | — |
| typescript | **7.0.2** | node `>=16.20.0` |
| prisma (CLI) | **7.10.1** | node `^20.19 \|\| ^22.12 \|\| >=24.0` |
| @prisma/client | **7.10.1** | node `^20.19 \|\| ^22.12 \|\| >=24.0` |
| @prisma/adapter-mariadb | **7.10.1** | — |
| tailwindcss | **4.3.5** | — |
| @tailwindcss/postcss | **4.3.5** | — |
| postcss | **8.5.6** | — |
| @types/node | **24.10.1** | — |
| @types/react | **19.2.7** | — |
| @types/react-dom | **19.2.3** | — |

Detail Prisma (dari `prisma -v`):

```
prisma               : 7.10.1
@prisma/client       : 7.10.1
Operating System     : linux
Architecture         : x64
Node.js              : v26.13.0
TypeScript           : 7.0.2
Query Compiler       : enabled
Schema Engine        : schema-engine-cli d1b3f377... (schema-engine-debian-openssl-3.0.x)
Studio               : 0.33.0
```

Catatan: `prisma@8.0.0-rc.33` hanya muncul sebagai notifikasi update. **Tidak dipakai**
(masih prerelease) dan tetap sesuai keputusan Phase 0.

---

## 3. Perintah yang Dijalankan

Ringkasan berurutan (semua di `/tmp/affiliateos-spike.L6q6Lx`):

```
1. mktemp -d /tmp/affiliateos-spike.XXXXXX
2. npm install --no-audit --no-fund
3. npm ls --depth=0 ; npm ls --all
4. (tulis tsconfig.json, next.config.ts, postcss.config.mjs,
    app/layout.tsx, app/page.tsx, app/globals.css, prisma/schema.prisma)
5. npx --no-install tsc --version ; npx --no-install tsc --noEmit
6. npx --no-install prisma -v
7. DATABASE_URL=... npx --no-install prisma validate      [GAGAL → diperbaiki]
8. DATABASE_URL=... npx --no-install prisma generate      [GAGAL → diperbaiki]
9. (tulis prisma.config.ts, hapus url dari schema)
10. DATABASE_URL=... npx prisma validate                  [OK]
11. DATABASE_URL=... npx prisma generate                  [OK]
12. npm install @prisma/adapter-mariadb@7.10.1
13. (tulis check-client.ts: PrismaClient + PrismaMariaDb, compile-only)
14. npx --no-install tsc --noEmit                         [OK]
15. NEXT_TELEMETRY_DISABLED=1 npx --no-install next build [OK]
16. find .next -name '*.css' ; grep utility Tailwind      [OK]
17. node -e "postcss([tailwind()]).process(...)"          [OK]
18. npx --no-install tsc --noEmit (setelah Next menulis ulang tsconfig) [OK]
19. npm ls --depth=0
20. rm -rf /tmp/affiliateos-spike.L6q6Lx  (hanya direktori spike sendiri)
```

---

## 4. Hasil Instalasi

```
INSTALL_EXIT=0 DURATION=24s
added 180 packages in 23s
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   prisma@7.10.1 (preinstall: node scripts/preinstall-entry.js)
npm warn install-scripts   @prisma/engines@7.10.1 (postinstall: node scripts/postinstall.js)
```

```
NPM_LS_ALL_EXIT=0
```

- Dependency tree **valid** (exit 0), tidak ada `invalid` atau `UNMET` untuk dependency
  wajib.
- `UNMET OPTIONAL DEPENDENCY lightningcss-*` dan `@tailwindcss/oxide-*` adalah binary
  platform lain (android/darwin/win32/arm) — **normal**, bukan masalah.
- `@emnapi/runtime@1.11.3 extraneous` muncul di `npm ls --depth=0`; kosmetik, tidak
  mempengaruhi build, tetapi perlu diawasi saat menaikkan versi.
- **Temuan penting:** npm 11 menahan install script Prisma (`allowScripts` policy).
  Semua fungsi yang diuji tetap berhasil, dan `prisma -v` menunjukkan schema engine
  tersedia di `node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x`.
  Namun keputusan policy ini harus diambil eksplisit di Phase 1 (lihat §9).

---

## 5. Hasil Build dan Typecheck

### 5.1 TypeScript 7

```
$ tsc --version
Version 7.0.2
TSC_VERSION_EXIT=0

$ tsc --noEmit        # app + next-env + .next/types + generated Prisma client + adapter
TSC_EXIT=0
```

Typecheck diulang **setelah** Next menulis ulang `tsconfig.json`, tetap `TSC_EXIT=0`.
Ini mencakup import `PrismaClient` dari client hasil generate dan `PrismaMariaDb` dari
adapter — jadi type surface Prisma 7 nyata dan kompatibel dengan TS 7.

### 5.2 Next.js 16 production build

```
BUILD_EXIT=0 DURATION=4s          (build pertama, termasuk optimisasi)
BUILD2_EXIT=0 DURATION_MS=2376    (build kedua, cache hangat)

▲ Next.js 16.4.6 (Turbopack)
✓ Compiled successfully in 2.5s
  Running TypeScript ...
  Finished TypeScript in 385ms
✓ Generating static pages using 4 workers (3/3) in 356ms

Route (app)
┌ ○ /
└ ○ /_not-found
```

- Build berjalan di Node 26.13.0 tanpa error.
- Next menulis ulang `tsconfig.json` secara otomatis: `jsx` → `react-jsx`,
  `allowJs` → `true`, `include` ditambah `.next/dev/types/**/*.ts`. Ini perilaku
  normal Next 16, tetapi harus di-commit secara sadar (bukan kejutan di diff).
- `/usr/bin/time` tidak tersedia, sehingga **peak RSS build tidak terukur**. Yang
  tercatat hanya durasi. Tidak ada OOM; RAM tersisa ±3.2 GiB sebelum build.

### 5.3 Tailwind CSS 4

Tailwind menghasilkan CSS di dua jalur independen:

**(a) Lewat Next build (Turbopack)** — bukan di `.next/static/css`, melainkan:

```
.next/static/chunks/33odnj__ur3no.css   7579 bytes
<link rel="stylesheet" href="/_next/static/chunks/33odnj__ur3no.css" data-precedence="next"/>
```

Utility yang ditemukan di CSS hasil build: `bg-slate-900`, `text-3xl`, `max-w-xl`,
`gap-4`, `antialiased`, `min-h-screen` (masing-masing 1 hit).

`@apply` juga terkompilasi benar:

```css
.spike-badge{padding-inline:calc(var(--spacing) * 2);padding-block:var(--spacing);
font-size:var(--text-xs);line-height:var(--tw-leading,var(--text-xs--line-height));
border-radius:.25rem;align-items:center;display:inline-flex}
```

**(b) Standalone PostCSS** — `postcss([tailwind()]).process()`:

```
POSTCSS_OK bytes=8277
bg-slate-900 1 | text-3xl 5 | max-w-xl 1 | gap-4 1 | antialiased 2
preflight (box-sizing) ditemukan
```

Kesimpulan: Tailwind 4.3.5 memproses utility **dan** `@apply` dengan benar, baik di
dalam Next/Turbopack maupun berdiri sendiri.

### 5.4 Prisma 7

```
PRISMA_VALIDATE_EXIT=0   → "The schema at prisma/schema.prisma is valid 🚀"
PRISMA_GENERATE_EXIT=0   → "✔ Generated Prisma Client (7.10.1) to ./src/generated/prisma in 22ms"
FILE_COUNT=9             → models.ts, commonInputTypes.ts, enums.ts, client.ts, browser.ts, ...
```

Yang diuji hanya `validate` + `generate` + typecheck pemakaian client. **Tidak ada
koneksi database, tidak ada migration, tidak ada query** (dilarang pada checkpoint ini).

---

## 6. Error dan Penyebabnya

### E1 — Prisma P1012: `datasource.url` tidak lagi didukung di schema (BLOCKING, diperbaiki)

```
Error code: P1012
error: The datasource property `url` is no longer supported in schema files.
Move connection URLs for Migrate to `prisma.config.ts` and pass either `adapter` for a
direct database connection or `accelerateUrl` for Accelerate to the `PrismaClient`
constructor.
```

**Penyebab:** Prisma 7 memindahkan konfigurasi koneksi keluar dari `schema.prisma`.
Ini perubahan breaking yang tidak tercatat di desain Phase 0 (`02-DATABASE-DESIGN.md`
masih mengasumsikan `datasource db { url = env("DATABASE_URL") }`).

**Perbaikan yang terbukti:**

```prisma
datasource db {
  provider = "mysql"
}
```

```ts
// prisma.config.ts
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Dan client runtime wajib memakai driver adapter:

```ts
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./src/generated/prisma/client";

const adapter = new PrismaMariaDb({ host, port, user, password, database });
export const prisma = new PrismaClient({ adapter });
```

### E2 — `prisma -v` gagal jika `DATABASE_URL` tidak ada (bukan bug, tapi jebakan CI)

```
Failed to load config file "/tmp/affiliateos-spike.L6q6Lx" as a TypeScript/JavaScript module.
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
```

**Penyebab:** `prisma.config.ts` dievaluasi eager oleh CLI, bahkan untuk `prisma -v`.
**Implikasi Phase 1:** setiap perintah Prisma (termasuk `generate` di CI/build) harus
punya `DATABASE_URL` tersedia, atau config harus memakai fallback eksplisit. Ini harus
masuk dokumentasi setup dan pipeline, bukan ditemukan belakangan.

### E3 — npm 11 menahan install script Prisma (peringatan, tidak memblokir)

```
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
  prisma@7.10.1 (preinstall), @prisma/engines@7.10.1 (postinstall)
```

**Dampak terukur:** tidak ada. `validate`, `generate`, `-v`, dan typecheck semuanya
berhasil; binary schema engine tersedia. **Risiko:** di mesin/CI lain, engine bisa
belum terunduh. Perlu keputusan eksplisit: `npm install-scripts approve prisma
@prisma/engines` (tercatat di repo) atau biarkan dan andalkan engine yang sudah ada.

### E4 — Pencarian CSS di direktori yang salah (observasi, bukan kegagalan)

Build sukses tetapi `.next/static/css/` kosong. CSS sebenarnya berada di
`.next/static/chunks/*.css` (perilaku Turbopack Next 16). Verifikasi awal saya
menghasilkan false negative; dikoreksi dengan `find .next -name '*.css'`.

### E5 — Next menulis ulang `tsconfig.json` (perilaku normal, perlu disadari)

`jsx: preserve` → `react-jsx`, `allowJs: true`, tambah `.next/dev/types/**/*.ts`.
Bukan error; tetapi diff konfigurasi ini harus di-review, bukan diterima buta.

---

## 7. Kompatibilitas per Teknologi

| Teknologi | Verdict | Bukti nyata | Catatan |
|---|---|---|---|
| **Node.js 26.13.0** | **PASS** | Next build exit 0; Prisma CLI/validate/generate exit 0; tsc exit 0 | Next engines `>=20.9.0`; Prisma engines `>=24.0` — Node 26 memenuhi keduanya. Dev server jangka panjang belum diuji |
| **Next.js 16.4.6** | **PASS** | `next build` exit 0, 3 halaman statis, Turbopack, TypeScript 385 ms | Belum diuji `next dev`, middleware, Route Handler, atau server runtime |
| **TypeScript 7.0.2** | **PASS** | `tsc --noEmit` exit 0 pada app, Next types, generated Prisma client, adapter | Native compiler tidak menunjukkan masalah dengan tipe Next/Prisma |
| **Prisma 7.10.1** | **PASS WITH LIMITATIONS** | `validate` OK, `generate` OK (9 file), typecheck client+adapter OK | Koneksi/query/migration **tidak diuji** (dilarang & tanpa kredensial). Membutuhkan `prisma.config.ts` + adapter |
| **@prisma/adapter-mariadb 7.10.1** | **PASS (compile-only)** | Typecheck `new PrismaMariaDb({...})` + `new PrismaClient({ adapter })` | Tidak ada koneksi ke MariaDB |
| **Tailwind CSS 4.3.5** | **PASS** | Utility + `@apply` ada di CSS hasil `next build`; standalone PostCSS 8.277 KB | Konfigurasi CSS-first terbukti; shadcn/ui belum diuji (di luar checkpoint) |
| **React 19.3.1** | **PASS** | Build + prerender 3 halaman | Hanya komponen server sederhana |
| **npm 11.20.0** | **PASS WITH LIMITATIONS** | Install 180 paket 24 s, `npm ls --all` exit 0 | Policy `allowScripts` menahan install script Prisma |
| **MariaDB 11.8.6** | **NOT TESTED** | — | Server aktif, tetapi tanpa akun aplikasi; koneksi/migration dilarang di checkpoint ini |

---

## 8. Rekomendasi Stack Final

**Disetujui untuk Phase 1 (pin eksak, tanpa range):**

```json
{
  "dependencies": {
    "next": "16.4.6",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "@prisma/client": "7.10.1",
    "@prisma/adapter-mariadb": "7.10.1"
  },
  "devDependencies": {
    "prisma": "7.10.1",
    "typescript": "7.0.2",
    "tailwindcss": "4.3.5",
    "@tailwindcss/postcss": "4.3.5",
    "postcss": "8.5.6",
    "@types/node": "24.10.1",
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.3"
  }
}
```

**Perubahan wajib terhadap asumsi Phase 0** (dokumen Phase 0 tidak diubah sesuai
larangan; dicatat di sini untuk diperbarui pada Phase 1):

1. `packages/database` harus memakai **`prisma.config.ts`** dengan `datasource.url`
   dan `migrations.path`; `schema.prisma` **tanpa** `url`.
2. Generator memakai `provider = "prisma-client"` + `output` eksplisit
   (default baru Prisma 7), bukan `prisma-client-js`.
3. `PrismaClient` **wajib** diberi `adapter: new PrismaMariaDb(...)`; tidak ada lagi
   koneksi implisit dari env di client.
4. `DATABASE_URL` harus tersedia untuk **setiap** invokasi CLI Prisma (termasuk
   `generate` saat build/CI).
5. Putuskan kebijakan `allowScripts` npm untuk `prisma` dan `@prisma/engines`, dan
   catat di README/CI.
6. `tsconfig.json` final mengikuti hasil rewrite Next 16 (`jsx: react-jsx`,
   `allowJs: true`, include `.next/dev/types`), di-commit sebagai baseline.
7. Tailwind 4 diverifikasi lewat `@tailwindcss/postcss` di `postcss.config.mjs`;
   tidak perlu `tailwind.config.js`.

**Yang belum boleh dianggap final:** `@types/node` 24.10.1 dipakai karena versi 26.x
belum dipastikan ada; naikkan hanya jika tipe Node 26 dibutuhkan. shadcn/ui, Argon2,
BullMQ, Zod, dan Vitest berada di luar checkpoint ini dan belum diuji.

---

## 9. Blocker yang Masih Tersisa

| # | Blocker | Status setelah checkpoint | Dampak |
|---|---|---|---|
| B1 | Tidak ada akun/database MariaDB | **Masih terbuka** | Migration, integration test, verifikasi koneksi Prisma 7 ke MariaDB 11.8 belum bisa dilakukan |
| B2 | Redis belum terpasang | **Masih terbuka** | BullMQ belum bisa diuji |
| B3 | Docker belum terpasang | **Masih terbuka** | Compose belum bisa dieksekusi |
| B4 | Tidak ada Partner Center app/credentials | **Masih terbuka** | Semua kapabilitas affiliate tetap BLOCKED |
| B5 | Ketersediaan affiliate di Indonesia & rollout kuota 2026-10 belum dikonfirmasi | **Masih terbuka** | Risiko desain Phase 5 |
| B6 | Bukan Git repository | **Masih terbuka** | `git init` belum dijalankan (dilarang di checkpoint ini) |
| B7 | Tidak ada sudo non-interaktif | **Masih terbuka** | Provisioning sistem adalah tindakan operator |
| **B8 (baru)** | Prisma 7 = breaking config change vs desain Phase 0 | **Tercatat, solusi terbukti** | Dokumen Phase 0 perlu pembaruan di Phase 1 sebelum schema ditulis |
| **B9 (baru)** | Policy `allowScripts` npm 11 untuk Prisma | **Perlu keputusan** | Risiko engine tidak terunduh di CI/mesin lain |
| **B10 (baru)** | `DATABASE_URL` wajib ada saat CLI Prisma dijalankan | **Perlu dimasukkan ke setup/CI** | `prisma generate` gagal di pipeline tanpa env |

Tidak ada blocker baru yang menghalangi penulisan kode Phase 1; B1–B3 menghalangi
*verifikasi* Phase 1.

---

## 10. Kepatuhan terhadap Larangan

| Larangan | Status |
|---|---|
| Implementasi fitur AffiliateOS | **Tidak dilakukan** — hanya hello-world + model `SpikeRecord` |
| Membuat database schema aplikasi | **Tidak dilakukan** — schema Prisma hanya 1 model dummy di /tmp, bukan schema AffiliateOS |
| Menjalankan migration | **Tidak dilakukan** — `migrate`/`db push` tidak pernah dipanggil |
| Mengubah/menghapus database MariaDB | **Tidak dilakukan** — tidak ada koneksi DB sama sekali |
| Memasang Redis/Docker | **Tidak dilakukan** |
| Menjalankan sudo | **Tidak dilakukan** |
| `git init` / initial commit | **Tidak dilakukan** |
| Mengubah dokumen Phase 0 | **Tidak dilakukan** — checksum 7 dokumen identik sebelum & sesudah spike |
| Perintah destruktif | Hanya `rm -rf` pada direktori spike milik sendiri (`/tmp/affiliateos-spike.L6q6Lx`) sesuai instruksi cleanup |
| Build bersamaan | **Tidak** — instalasi, typecheck, dan build dijalankan berurutan |

---

## 11. Status Keseluruhan

**PASS WITH LIMITATIONS**

Alasan PASS:

- Instalasi berhasil (180 paket, exit 0) dan dependency tree valid (`npm ls --all` exit 0).
- `tsc --noEmit` exit 0, termasuk tipe Prisma Client hasil generate dan adapter.
- `next build` exit 0 pada Node 26.13.0, 3 halaman statis, tanpa OOM.
- `prisma validate` dan `prisma generate` exit 0 setelah migrasi konfigurasi ke Prisma 7.
- Tailwind 4 terbukti memproses utility dan `@apply` di dua jalur independen.
- Semua versi aktual tercatat.

Alasan belum PASS penuh (limitations):

1. Tidak ada verifikasi koneksi/query/migration Prisma 7 ke MariaDB 11.8 (B1 + larangan checkpoint).
2. Tidak ada uji `next dev`, Route Handler, middleware, atau runtime server.
3. Peak RSS build tidak terukur (`/usr/bin/time` tidak tersedia).
4. shadcn/ui, Argon2id, BullMQ, Zod, Vitest, Playwright belum diuji — di luar lingkup checkpoint.
5. Empat temuan konfigurasi baru (Prisma config, adapter, `DATABASE_URL`, `allowScripts`) belum tercermin di dokumen Phase 0, karena dokumen tersebut dilarang diubah pada checkpoint ini.

---

## 12. Berhenti di Sini

Checkpoint 1 selesai. **Checkpoint 2 tidak dimulai.** Tidak ada implementasi aplikasi,
schema, migration, inisialisasi Git, atau commit. Menunggu persetujuan manusia.
