# Phase 1 — Checkpoint 8A: Worker Placeholder + Dev Stack (tanpa Docker)

**Status: DONE** — no commit, no Docker files, no schema/migration change.

Docker dibatalkan oleh user sebelum implementasi dimulai: host sudah menjalankan
MariaDB native (`127.0.0.1:3306`, DB `affiliateos`, user `affiliateos_app`), dan tidak
ada container runtime sama sekali (`docker`, `docker-compose`, `podman`, `nerdctl`,
`buildah` semuanya tidak ada, `/var/run/docker.sock` tidak ada). Memindahkan database
yang sudah berisi data uji ke container hanya akan menambah risiko tanpa manfaat.
Karena itu P1.1 dikerjakan ulang sebagai proses native + skrip npm.

---

## 1. File

| File | Isi |
|---|---|
| `apps/worker/package.json` | workspace `@affiliateos/worker`, script build/start/dev/typecheck |
| `apps/worker/tsconfig.json` | target ES2022, NodeNext, strict — disalin dari `packages/database` karena repo tidak punya `tsconfig.base.json` |
| `apps/worker/src/index.ts` | worker placeholder: bootstrap env, health probe, structured log, graceful shutdown |
| `package.json` (root) | script `dev`, `dev:web`, `dev:worker`, `dev:stack`, `build:worker`, `start:worker` + devDependency `concurrently ^10.0.7` |
| `.env.example` | blok komentar cara menjalankan dev stack (nama variabel saja, tanpa nilai) |

Tidak dibuat: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docker/`. Diverifikasi
dengan `ls` → `none (as required)`.

---

## 2. Keputusan desain

**Worker memuat `.env` sendiri, lalu meng-import paket database secara dinamis.**

Ini bukan gaya penulisan, melainkan keharusan: `packages/database/src/client.ts`
membuat pool pada saat modul dievaluasi dan langsung melempar error bila
`DATABASE_URL` kosong. Snippet di brief memakai `import { systemDb } from
'@affiliateos/database'` di baris teratas, sehingga `node dist/index.js` akan gagal
kecuali pemanggil sudah mengekspor env lebih dulu. Worker sekarang menelusuri ke atas
sampai menemukan `package.json` ber-`workspaces`, memanggil `process.loadEnvFile`,
**baru** `await import("@affiliateos/database")`. Hasilnya: `node dist/index.js` jalan
sendiri, tanpa wrapper `source .env`, dan variabel yang sudah ada di proses tetap
menang (deployment bisa inject `DATABASE_URL` tanpa file).

**Semua langkah yang bisa menggantung diberi batas waktu.**

Pool memakai `connectTimeout`/`acquireTimeout` 10 detik. Tanpa batas sendiri, probe
akan diam >10 detik dan shutdown bisa menunggu probe selamanya. Batas yang dipakai:
probe 5s, menunggu probe saat shutdown 1.5s, disconnect 3s, dan force-exit 6s sebagai
jaring terakhir.

**Log satu objek JSON per baris** (`{ts, level, event, ...}`), siap dikonsumsi kolektor
log. Tidak pernah mencetak `DATABASE_URL` atau isi kredensial.

**Health probe = `SELECT 1`** lewat `systemDb()` (ditandai `// SYSTEM:`). Worker adalah
infrastruktur lintas-tenant; probe tidak boleh membaca baris tenant. Nanti di P1.3,
job handler wajib memakai `withTenant()`, bukan `systemDb()`.

**Kode keluar:** 0 untuk shutdown normal (termasuk saat DB sedang mati), 1 untuk
`uncaughtException` atau bila shutdown benar-benar melewati semua batas waktu.
Supervisor tidak boleh melihat "crash" hanya karena database sedang tidak tersedia.

---

## 3. Hasil test (output nyata)

Semua test dijalankan dari `apps/worker` **tanpa** `source .env` — pembuktian bahwa
worker memuat environment sendiri.

### 3.1 Build

```
npm run build:worker → BUILD_EXIT=0
dist/index.js 5.9 KB
```

### 3.2 Start + SIGTERM

```
{"event":"worker_started","note":"placeholder, BullMQ di P1.3","pid":47537}
{"event":"health_ok","db":"ok"}
{"event":"shutdown_start","signal":"SIGTERM"}
{"event":"shutdown_db_disconnected","signal":"SIGTERM"}
{"event":"shutdown_complete","signal":"SIGTERM"}
alive_before_signal=yes exit_code=0
```

### 3.3 Start + SIGINT

```
{"event":"worker_started",...}
{"event":"health_ok","db":"ok"}
{"event":"shutdown_start","signal":"SIGINT"}
{"event":"shutdown_db_disconnected","signal":"SIGINT"}
{"event":"shutdown_complete","signal":"SIGINT"}
alive_before_signal=yes exit_code=0
```

### 3.4 Interval alive 30 detik (33s run)

```
health_ok_count=2
06:57:57.589 health_ok
06:58:27.473 health_ok      (+29.9s)
exit_code=0
```

### 3.5 Database tidak tersedia

Brief meminta `sudo systemctl stop mariadb`. Itu tidak dilakukan: menghentikan MariaDB
lokal akan memutus database dev dan butuh sudo. Code path yang sama diuji dengan
mengarahkan worker ke port kosong (3307) — worker tetap hidup, tidak crash:

```
{"event":"worker_started",...}
{"event":"health_fail","reason":"timeout","error":"health probe timed out after 5000ms"}
{"event":"shutdown_start","signal":"SIGTERM"}
{"event":"shutdown_db_disconnected","signal":"SIGTERM"}
{"event":"shutdown_complete","signal":"SIGTERM"}
alive_before_signal=yes exit_code=0
```

### 3.6 `npm run dev:stack`

```
stack_pid=47596 web_ready=yes worker_health_ok=yes
web_health_http=200 body={"status":"ok","database":"up"}
[worker] {"event":"worker_started",...}
[worker] {"event":"health_ok","db":"ok"}
[web]    - Local:         http://localhost:3000
[web]    ✓ Ready in 499ms
[worker] {"event":"shutdown_start","signal":"SIGINT"}
[worker] {"event":"shutdown_db_disconnected","signal":"SIGINT"}
[worker] {"event":"shutdown_complete","signal":"SIGINT"}
npm_run_still_running=no
port3000=free
```

SIGINT dikirim ke seluruh process group (setara Ctrl+C); `concurrently` meneruskan
sinyal, worker shutdown bersih, port 3000 dilepas.

### 3.7 Typecheck

```
npm run typecheck   → permissions + database + worker + web, TYPECHECK_EXIT=0
```

---

## 4. Bug yang ditemukan saat test dan diperbaiki

Versi pertama **gagal** pada kasus database mati: tidak ada `health_fail` sama sekali,
lalu `shutdown_start` diikuti `shutdown_forced` dan **exit 1**. Penyebabnya dua:
probe awal menggantung di connect (10s) tanpa batas sendiri, dan shutdown menunggu
`probeInFlight` tanpa batas sehingga menabrak jaring force-exit 6s. Perbaikan:
`withTimeout()` untuk probe, grace 1.5s untuk probe saat shutdown, dan 3s untuk
disconnect. Setelah perbaikan: `health_fail` muncul pada detik ke-5 dan shutdown tetap
exit 0 (lihat §3.5). Test tidak dilewati — bug-nya yang diperbaiki.

---

## 5. Deviasi dari brief

| Topik | Brief | Implementasi | Alasan |
|---|---|---|---|
| Import database | `import { systemDb }` statis | dynamic import setelah env dimuat | pool dibuat saat modul dievaluasi; import statis crash tanpa `source .env` |
| Versi dependency | `"@affiliateos/database": "*"` | `"0.0.0"` | sama dengan `apps/web`; tetap me-resolve ke workspace lokal |
| `@types/node` | tidak disebut | `24.10.1` di devDependencies worker | `NodeJS.Timeout`, `process` tidak compile tanpa itu |
| `tsconfig.base.json` | diasumsikan ada | tsconfig mandiri | file itu tidak ada di repo |
| Test DB mati | `systemctl stop mariadb` | URL ke port kosong 3307 | code path identik, tanpa sudo, tanpa memutus DB dev |
| `next dev -p 3000` | minta ditambahkan | tidak diubah | `next dev` sudah default 3000; mengubahnya tidak perlu |

---

## 6. Tech debt

| Id | Item |
|---|---|
| TD-8A-R1 | Worker belum punya job handler — BullMQ di P1.3 |
| TD-8A-R2 | Redis belum terpasang di host; P1.3 membutuhkannya |
| TD-8A-R3 | Tidak ada container image; deployment production akan native (systemd) |
| TD-8A-R4 | Structured log masih `console.log(JSON.stringify(...))`; bisa naik ke pino/winston |
| TD-8A-R5 | `npm audit --omit=dev` = 0, tapi devDeps membawa advisory `postcss <=8.5.22` (high, GHSA-qx2v-qp2m-jg93 dkk). Pre-existing dari Next/Tailwind, bukan dari `concurrently`; fix butuh postcss 8.5.33 di luar range saat ini |
| TD-8A-R6 | Belum ada supervisor/restart policy untuk worker di dev (proses manual); production perlu unit systemd |
| TD-8A-R7 | `dev:stack` tidak menjalankan migrasi otomatis; `prisma migrate deploy` tetap langkah manual |

---

## 7. Yang sengaja tidak dikerjakan

- Tidak commit, tidak push.
- Tidak ada Dockerfile/compose (dibatalkan user).
- Tidak install Redis (P1.3).
- Tidak menyentuh `schema.prisma`, migration, atau kode auth/RBAC/audit/cross-tenant.
- `apps/worker/dist/` adalah build output dan sudah di-ignore (`.gitignore:23`).
