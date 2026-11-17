# Phase 1 — Checkpoint 8B: Buildfix + Security Headers (Pre-Phase 2)

**Status: DONE** — untuk dua item yang diminta (HIGH #1 buildfix, MEDIUM #4 headers).
Satu keterbatasan struktural tetap ada dan **tidak** diperbaiki karena dilarang:
tag lama `7c-auth`, `7d-rbac`, `7e-audit`, `7f-cross-tenant` tetap tidak buildable.

**Belum di-commit.** Sesuai aturan keras brief ("JANGAN commit. Tampilkan diff, STOP"),
langkah `git commit` di §1b **tidak dijalankan** — dan memang tidak ada yang perlu
di-commit di sana karena `package-lock.json` sudah lengkap di HEAD (lihat §1b).

Tanggal: 2026-11-17 · HEAD saat pengerjaan: `05cb987` (tidak berubah)

---

## 1. Fix 1 — HIGH #1: Semua Checkpoint Buildable

### 1a. Root `build` sekarang membangun worker juga

Sebelum (`package.json`):

```
"build": "npm run build:permissions && npm run build:database && npm run build --workspace @affiliateos/web"
```

Sesudah:

```
"build": "npm run build:permissions && npm run build:database && npm run build:worker && npm run build --workspace @affiliateos/web"
```

Urutan penting: `permissions` → `database` → `worker` → `web`. `build:permissions`
sudah ada sejak 8A; yang hilang adalah `build:worker`, sehingga `npm run build` tidak
pernah membuktikan worker dapat dikompilasi dari root.

### 1b. `package-lock.json` — sudah lengkap, tidak ada perubahan

Brief meminta `npm install` lalu commit lockfile. Hasil nyata:

```
$ npm install --no-audit --no-fund
up to date in 642ms
$ git status --short package-lock.json
(kosong)
```

Lock di HEAD sudah memuat `@affiliateos/permissions` dan `argon2` (dibuktikan juga
oleh `grep -c` = 2 dan oleh `npm ci` exit 0 pada audit §3). Jadi tidak ada diff
lockfile untuk di-commit. Kegagalan `npm ci` di tag 7C–7F berasal dari **commit lama**
yang menambah dependency tanpa memperbarui lock, bukan dari state HEAD; memperbaikinya
hanya mungkin dengan menulis ulang tag (dilarang).

**Deviasi sadar dari brief:** §1b memerintahkan `git commit`. Aturan keras di bagian
atas dokumen yang sama melarang commit dan meminta STOP setelah diff. Aturan keras
diikuti; tidak ada commit yang dibuat.

### 1c. Build di HEAD

```
$ npm run build
ƒ Proxy (Middleware)          ← proxy.ts terdeteksi
BUILD_EXIT=0
```

### 1d. Build per checkpoint (tag tidak diubah)

Worktree terpisah `/tmp/build-check`, satu tag per iterasi, `.env` disalin, `npm ci`
lalu fallback `npm install` bila lock tidak sinkron, lalu `npm run build`.

| Tag | `npm ci` | `npm run build` | Catatan |
|---|---|---|---|
| `checkpoint-7b-p02-accounts` | 0 | **0** | buildable |
| `checkpoint-7b-p03-m1-tenant` | 0 | **0** | buildable |
| `checkpoint-7c-auth` | 1 | **1** | `Export writeAudit doesn't exist in target module` — route auth mengimpor `writeAudit` yang baru ada di 7E |
| `checkpoint-7d-rbac` | 1 | **1** | `TS2307: Cannot find module '@affiliateos/permissions'` — root `build` di tag itu belum membangun paket permissions |
| `checkpoint-7e-audit` | 1 | **1** | sama seperti 7D |
| `checkpoint-7f-cross-tenant` | 1 | **1** | sama seperti 7D |
| `checkpoint-8a-worker` | 0 | **0** | buildable |

Ini persis ekspektasi jujur di brief: **HEAD buildable, tag lama tetap historis tidak
buildable**. Tidak ada tag yang di-rebase/di-rewrite.

---

## 2. Fix 2 — MEDIUM #4: Security Headers

### 2a. Implementasi

Next.js **16.4.6** mendeprekasi konvensi `middleware.ts` dan menggantinya dengan
`proxy.ts` (terverifikasi di `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`:
"deprecated in Next.js 16 and renamed to `proxy`"). Brief meminta `middleware.ts`;
file itu masih dikenali tetapi sudah konvensi usang. Yang dibuat: **`apps/web/src/proxy.ts`**
yang mengekspor `proxy` — konvensi yang benar untuk versi framework ini.

| File | Baris | Isi |
|---|---|---|
| `apps/web/src/lib/security-headers.ts` | 67 | builder murni (tanpa `next/server`) agar bisa diuji Node test runner |
| `apps/web/src/lib/security-headers.test.ts` | 73 | 6 test: baseline headers, clickjacking, HSTS gate, CSP prod/dev, CSP satu baris |
| `apps/web/src/proxy.ts` | 36 | menerapkan header ke setiap respons; matcher mengecualikan `_next/static`, `_next/image`, `favicon.ico` |
| `apps/web/package.json` | +1 file di script `test` | `src/lib/security-headers.test.ts` |

Header yang dikirim:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'[ 'unsafe-eval' dev];
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self'[ ws: wss: dev]; object-src 'none'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload   (production only)
```

Dev/prod dipisah dengan sengaja: `next dev` membutuhkan `'unsafe-eval'` (React
debugging) dan websocket HMR. HSTS tidak dikirim di dev karena http dan untuk
menghindari "poisoning" origin `localhost` di browser developer.

### 2b. Test

Unit test (masuk suite `apps/web`, jadi ikut `npm test` setiap kali):

```
✔ security headers (3.423613ms)
  ✔ sends the baseline headers
  ✔ keeps the clickjacking directives in both modes
  ✔ emits HSTS only in production
  ✔ production CSP has no eval and no websocket origins
  ✔ development CSP allows the dev server's eval and HMR socket
  ✔ CSP is a single line with the required directives
```

Test HTTP terpisah untuk `proxy.ts` **tidak** ditambahkan sebagai file suite baru:
suite web sudah menjalankan empat `next dev` paralel, dan server kelima pada host
3.2 GiB berisiko OOM sehingga bisa menghasilkan kegagalan palsu. Aplikasi header ke
respons nyata dibuktikan di §2c (dev) dan §2d (production) dengan output curl.

### 2c. Bukti HTTP — `next dev` (:3050)

```
$ curl -si http://127.0.0.1:3050/api/health
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
permissions-policy: camera=(), microphone=(), geolocation=()
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
x-frame-options: DENY
{"status":"ok","database":"up"}

$ curl -si http://127.0.0.1:3050/api/auth/me
HTTP/1.1 401 Unauthorized
(header yang sama, lengkap)
{"error":"Unauthorized"}
```

### 2d. Bukti HTTP — production (`next start` :3051, hasil `npm run build`)

```
$ NODE_ENV=production npx next start -p 3051
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
permissions-policy: camera=(), microphone=(), geolocation=()
referrer-policy: strict-origin-when-cross-origin
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY
```

Perhatikan: CSP production **tanpa** `'unsafe-eval'` dan **tanpa** `ws:`, dan HSTS
muncul — bukti gate production bekerja, bukan sekadar nilai di unit test.

---

## 3. Hasil Test (dijalankan setelah semua perubahan)

| Perintah | Hasil | Exit |
|---|---|---|
| `npm run build` (root, HEAD) | 10 route + `ƒ Proxy (Middleware)` | **0** |
| `npm test` (permissions + database) | database 46 pass / 0 fail | **0** |
| `npm run test --workspace @affiliateos/web` | **249 pass / 0 fail** (243 lama + 6 header) | **0** |
| `npm run typecheck` (4 paket) | bersih | **0** |
| `npm install` | up to date, lock tanpa diff | 0 |

Total: **299 → 305 test** (10 permissions + 46 database + 249 web).

---

## 4. Known Limitations

1. **Tag 7C–7F tetap tidak buildable.** Tidak bisa diperbaiki tanpa menulis ulang
   commit/tag, yang dilarang brief. Sudah didokumentasikan di
   `docs/AUDIT-PHASE-1-2026-11-17.md` §3 dan di sini.
2. **CSP masih memakai `'unsafe-inline'` untuk script.** Nonce butuh dynamic
   rendering di semua halaman + plumbing nonce; itu perubahan arsitektur, bukan
   buildfix. `docs/04` §3.12 lebih suka nonce; dicatat sebagai TD-8B-R1.
3. **HSTS satu tahun**, sedangkan `docs/04` §3.12 menyebut dua tahun
   (`max-age=63072000`). Brief buildfix menetapkan 31536000; masih memenuhi syarat
   preload. TD-8B-R2.
4. **Header diaplikasikan oleh `proxy.ts` (runtime proxy Next), bukan Nginx.**
   Bila produksi nanti memakai reverse proxy yang menimpa header, konfigurasi Nginx
   harus dicek ulang. Belum ada deployment untuk diverifikasi.
5. **Belum ada CI.** Perbaikan ini tidak mencegah regresi "tag tidak buildable" —
   perlu job matrix per tag (TD-8B-R3).
6. `apps/web/AGENTS.md` adalah file yang dibuat otomatis oleh `next dev`
   (`generate-agent-files.js`), bukan bagian dari perubahan ini; tetap untracked.
7. Cleanup server uji memakai `pkill -f`, yang sempat mencocokkan baris perintah
   shell-nya sendiri dan mematikan shell verifikasi. Bukan bug aplikasi; verifikasi
   akhir dilakukan lewat PID dari `ss`.

## 5. Tech Debt Baru

| ID | Severity | Item | Target |
|---|---|---|---|
| TD-8B-R1 | MEDIUM | CSP script memakai `'unsafe-inline'` (belum nonce) | Phase 2 / sebelum produksi |
| TD-8B-R2 | LOW | HSTS 1 tahun vs 2 tahun di docs/04 §3.12 | saat hardening produksi |
| TD-8B-R3 | HIGH | Tidak ada CI yang mem-build setiap tag/commit; regresi build tidak terdeteksi | segera (sebelum Phase 2) |
| TD-8B-R4 | HIGH (diterima) | Tag 7C–7F historis tidak buildable | tidak diperbaiki (rewrite dilarang) |

## 6. Diff (belum di-commit)

```
 M apps/web/package.json        (script test: + security-headers.test.ts)
 M package.json                 (build: + build:worker)
?? apps/web/src/proxy.ts                     (36 baris)
?? apps/web/src/lib/security-headers.ts      (67 baris)
?? apps/web/src/lib/security-headers.test.ts (73 baris)
```

`package-lock.json`: tidak berubah. HEAD: `05cb987`, 8 tag, tidak ada commit baru.
