# AUDIT INDEPENDEN — PHASE 1 AFFILIATEOS

**Tanggal:** 2026-11-17
**Auditor:** agent (audit independen, tanpa mempercayai laporan checkpoint)
**HEAD diaudit:** `05cb987` (`feat(worker): placeholder worker + dev stack (P1.1)`), branch `main`
**Base:** `65bdcfd` (`checkpoint-6d-pre-migration`)
**Metode:** `git log/show/diff`, `information_schema`, `SHOW GRANTS`, probe DML/DDL langsung sebagai akun runtime, pembacaan kode, dan build ulang setiap tag di worktree terpisah (`/tmp/audit-wt`). Tidak ada file repo yang diubah selain dokumen ini.

---

## 1. Executive Summary

- **Phase 1 selesai? TIDAK — PARTIAL.** Fondasi backend (DB, tenant isolation, auth, RBAC, audit, worker placeholder) ada dan sebagian terbukti di database nyata; **UI Phase 1 dan beberapa kontrol keamanan yang dijanjikan dokumen belum ada**.
- **Progres kasar: ~70%** dari scope Phase 1 di `docs/05-ROADMAP.md` §2 (backend ~90%, UI 0%, Redis/BullMQ 0%).
- **Blocker utama:** (1) **4 dari 7 tag tidak bisa di-build** dari checkout bersih; (2) tidak ada security headers, rate limit per-user/tenant, session idle timeout, dan redaction logger yang diwajibkan `docs/04`; (3) tidak ada UI (sign-in, workspace switcher, member list, audit viewer).
- Test suite di HEAD nyata: **299 pass / 0 fail** (10 permissions + 46 database + 243 web), exit 0.
- Database nyata: 13 tabel, 16 FK, `audit_logs` menolak UPDATE/DELETE/DDL dengan **1142**. Klaim inti DB **terverifikasi**.

---

## 2. Git History

### 2.1 Commit (65bdcfd..HEAD)

| # | Commit | Checkpoint | File | Verdict |
|---|---|---|---|---|
| 1 | `4adc4b5` chore(db): separate app and migrate accounts (P0.2) | `checkpoint-7b-p02-accounts` | 3 | PASS |
| 2 | `7bb761d` feat(db): M1 migration, per-table grants, withTenant()/systemDb() (P0.3) | `checkpoint-7b-p03-m1-tenant` | 9 | PASS |
| 3 | `ce49a55` feat(auth): session + Argon2id + CSRF enforced + rate limit (P0.5) | `checkpoint-7c-auth` | 23 | **FAIL (tidak build)** |
| 4 | `04f83fb` feat(rbac): 27 permissions, 6 roles, requirePermission() (P0.6) | `checkpoint-7d-rbac` | 17 | **FAIL (tidak build)** |
| 5 | `dc163d3` feat(audit): writeAudit() + append-only 2 layers (P0.7) | `checkpoint-7e-audit` | 8 | **FAIL (tidak build)** |
| 6 | `f0dee41` feat(workspaces): create + invite + role change … (P0.8) | `checkpoint-7f-cross-tenant` | 8 | **FAIL (tidak build)** |
| 7 | `05cb987` feat(worker): placeholder worker + dev stack (P1.1) | `checkpoint-8a-worker` | 7 | PASS |

| Kriteria | Hasil | Bukti |
|---|---|---|
| 7 commit + 7 tag | ✅ | `git log --oneline 65bdcfd..HEAD`, `git tag -l` (8 tag termasuk `checkpoint-6d-pre-migration`) |
| Urutan P0.2 → P0.3 → P0.5 → P0.6 → P0.7 → P0.8 → P1.1 | ✅ | urutan topologis di atas |
| Footer `🤖 Generated with Codebuff` + `Co-Authored-By` | ✅ 7/7 | `git log --format=full -7` |
| Tidak ada commit > 100 file | ✅ (maks 23) | `git diff-tree --name-only` per commit |
| `.env` tidak ada di history | ✅ | `git log --all --full-history -- .env` → kosong |
| Remote / push | tidak ada remote | `git branch -vv`, `git remote -v` |

Catatan: pesan commit memuat angka test per checkpoint (mis. "46 + 227 tests pass" pada 7E) yang **tidak dapat direproduksi pada tree tag tersebut**, karena suite dan lockfile baru lengkap di commit terakhir (lihat §3 dan §6).

---

## 3. Per-Checkpoint Build (Tech Debt #2 dan #3)

Dijalankan di worktree terpisah `git worktree add --detach /tmp/audit-wt`, satu tag per iterasi, `.env` disalin ke worktree, `npm ci` → fallback `npm install` bila lock tidak sinkron → `npm run build`. Working tree `main` tidak disentuh.

| Tag | `npm ci` | `npm run build` | Akar masalah |
|---|---|---|---|
| `checkpoint-7b-p02-accounts` | **0** | **0** | — |
| `checkpoint-7b-p03-m1-tenant` | **0** | **0** | — |
| `checkpoint-7c-auth` | **1** | **1** | Lock tidak memuat `argon2` (+5 deps transitif); build: `Export writeAudit doesn't exist in target module` — route auth sudah mengimpor `writeAudit` padahal `audit.ts` baru lahir di 7E |
| `checkpoint-7d-rbac` | **1** | **1** | Lock tidak memuat `@affiliateos/permissions` + `argon2`; build: `src/rbac.ts(23,8): TS2307 Cannot find module '@affiliateos/permissions'` (root `build` belum menjalankan `build:permissions`) |
| `checkpoint-7e-audit` | **1** | **1** | Sama seperti 7D (paket permissions belum dibangun) |
| `checkpoint-7f-cross-tenant` | **1** | **1** | Sama seperti 7D |
| `checkpoint-8a-worker` | **0** | **0** | `build:permissions` ditambahkan; lock lengkap; 10 route terdaftar di output build |

**Kesimpulan:** klaim "setiap checkpoint dapat di-checkout dan dibangun" **tidak benar**. Hanya 3 dari 7 tag (P0.2, P0.3, 8A) yang `npm ci` + `npm run build` hijau; 7C gagal karena isi commit tidak konsisten, 7D–7F gagal karena urutan build script. HEAD sendiri hijau (`npm ci` 0, build 0) — jadi ini murni tech debt historis, bukan kerusakan HEAD.

Batasan metode: pada 7C–7F `npm ci` gagal, sehingga build dijalankan di atas `npm install` (resolusi dari `package.json`). Untuk 7D–7F itu tidak mengubah verdict: errornya `TS2307` pada kode first-party, bukan ketiadaan dependency. Skrip install `argon2` juga tidak disetujui di worktree (npm menolak install-script yang tidak ada di `allowScripts`), jadi bila build 7C lolos pun runtime Argon2 belum tentu berfungsi di tree itu.

---

## 4. Klaim vs Verifikasi

| Klaim (laporan/commit) | Bukti yang diperiksa | Status |
|---|---|---|
| "13 tabel M1" | `information_schema.TABLES` = **13** tabel aplikasi (14 termasuk `_prisma_migrations`), semuanya InnoDB + `utf8mb4_unicode_ci` | ✅ TERVERIFIKASI |
| "16 FK" | `COUNT(DISTINCT CONSTRAINT_NAME)` = **16**; termasuk composite `(tenant_id, id)` pada `member_roles`, `role_permissions`, `roles` | ✅ TERVERIFIKASI |
| "12 tabel DML + audit SELECT/INSERT" | `SHOW GRANTS` sebagai `affiliateos_app`: 12 baris `SELECT, INSERT, UPDATE, DELETE`, 1 baris `SELECT, INSERT ON audit_logs`, tanpa `ON affiliateos.*` | ✅ TERVERIFIKASI |
| "append-only audit_logs" | `UPDATE audit_logs` → **1142**, `DELETE` → **1142**, `CREATE TABLE` → **1142**; ditambah guard `TenantAppendOnlyError` di `tenant-db.ts` | ✅ TERVERIFIKASI (dua lapis) |
| "cross-tenant isolation A vs B" | `cross-tenant.test.ts` memakai dua user UUID berbeda, dua workspace berbeda, server `next dev` nyata + DB test; T2/T3/T5 = 403 dan hitungan baris 0 di workspace korban; T6/T7 menguji `withTenant` langsung | ✅ TERVERIFIKASI (nyata, bukan mock) |
| "162 RBAC matrix" | 6 role × 27 permission, tiap kombinasi subtest bernama; ekspektasi dari `roleHasPermission`, aktual dari `requirePermission` → `role_permissions` DB | ✅ TERVERIFIKASI |
| "Argon2id m=19456,t=2,p=1" | `password.ts` `ARGON2_OPTIONS`; test mengunci prefix `$argon2id$v=19$m=19456,t=2,p=1$` | ✅ TERVERIFIKASI |
| "299 test pass" | Dijalankan ulang di HEAD: permissions 10, database 46, web 243 = **299 pass, 0 fail**, exit 0 | ✅ TERVERIFIKASI |
| "6 role seeded per workspace" | `roles.ts` + `createDefaultRolesForWorkspace`; **DB dev saat ini `roles=0`, `permissions=0`** karena cleanup test men-truncate | ⚠️ TERVERIFIKASI DI KODE/TEST, **tidak** di state DB |
| "README/laporan: setiap checkpoint buildable" | Lihat §3 | ❌ TIDAK TERVERIFIKASI / SALAH |
| "Laporan checkpoint berstatus DONE (uncommitted)" | Semua perubahan sudah ter-commit; dokumen tidak diperbarui | ⚠️ USANG |

**Catatan state DB:** `permissions=0`, `roles=0`, `users=0` di schema dev. Jadi bukti "27 permission ada di database" hanya berasal dari test (DB test) dan seed script — bukan dari database dev saat audit. Ini bukan pelanggaran, tetapi berarti audit ulang wajib menjalankan seed dulu.

---

## 5. Kesesuaian dengan PRD

> **Temuan proses:** `docs/01-PRD.md` **tidak ada** di repo (brief audit menyebutnya). Acuan produk yang tersedia: `docs/00-PROJECT-BASELINE.md`, `docs/01-ARCHITECTURE.md`, `docs/02-DATABASE-DESIGN.md`, `docs/05-ROADMAP.md`, `docs/08-TENANT-ISOLATION-DESIGN.md`. Perbandingan di bawah memakai dokumen-dokumen itu.

| Item | Status | Catatan |
|---|---|---|
| 6 role (super_admin, owner, admin, affiliate_manager, BD, analyst) | ⚠️ BERBEDA, terdocumentasi | Implementasi: `WORKSPACE_OWNER, WORKSPACE_ADMIN, AFFILIATE_MANAGER, BUSINESS_DEVELOPMENT, ANALYST, VIEWER`. `SUPER_ADMIN` bukan role workspace — akses lintas tenant lewat `platform_admin_grants` (docs/07 D-6C-2, docs/08 §5.3). `VIEWER` menggantikan slot `super_admin` di daftar 6. |
| 27 permission | ✅ SESUAI docs/08 §5.1 | Katalog kode = 27 persis; docs/08 §5.1 juga 27 (workspace 2, member 4, creator 6, campaign 4, shop 4, analytics 2, outreach 2, audit 1, job 2). `workspace.update` yang disebut laporan 7D **tidak ada** di katalog. |
| Pipeline creator `NEW→CONTACTED→INVITED→ACCEPTED→COLLABORATING→COMPLETED` | ⚠️ HANYA SCHEMA | Enum `CreatorStatus` memuat 6 tahap itu + `REJECTED/UNRESPONSIVE/BLACKLISTED`; tabel `creators` **belum dimigrasikan** (Phase 3). |
| MVP: Auth | ✅ (backend) | register bootstrap, login, logout, me, session, CSRF, Argon2id. **Tidak ada UI login.** |
| MVP: Workspace | ✅ (backend) | create, invite by email, change role; tanpa accept-invitation dan tanpa UI. |
| MVP: RBAC | ✅ | katalog + matrix + `requirePermission`. |
| MVP: Tenant | ✅ | `withTenant()` + composite FK + grant per tabel. |
| MVP: TikTok Shop connection | ❌ | Phase 2; tidak ada klien/OAuth/token. Tabel `shop_connections`/`shops`/`oauth_states` ada di schema, **tidak** di M1. |
| MVP: Creator CRM | ❌ | Phase 3. |
| MVP: Campaign | ❌ | Phase 4. |
| MVP: Dashboard | ❌ | `apps/web/src/app/page.tsx` masih halaman boilerplate "Checkpoint 6A … belum ada tabel, belum ada migration" — teks usang. |
| MVP: Audit log | ✅ (writer) / ❌ (viewer) | `writeAudit` + append-only; **tidak ada** viewer read-only yang diminta roadmap §2. |
| MVP: Background sync | ❌ | Worker placeholder `SELECT 1`, tanpa BullMQ/Redis/job handler. |
| OWASP / headers | ❌ | Tidak ada CSP/HSTS/nosniff/frame-ancestors di `next.config.ts` maupun middleware. |
| Tenant isolation | ✅ | Bukti DB + test. |
| RBAC server-side | ✅ | Tidak ada gating client-side sebagai kontrol. |
| Token TikTok terenkripsi | ❌ (N/A Phase 2) | Kolom ciphertext ada di schema, belum dimigrasikan. |
| Audit trail | ✅ | Append-only dua lapis. |
| Timezone Asia/Jakarta | ⚠️ | Penyimpanan UTC dipaksa (`timezone: "Z"` di pool); **tidak ada** konversi tampilan WIB (belum ada UI). |
| Availability 99.5% | UNVERIFIED | Tidak ada deployment, monitoring, atau pengukuran. |
| Backup & restore | ❌ | Phase 7; tidak ada skrip/verifikasi restore. |
| Observability | ⚠️ | Worker JSON log 1 baris + `/api/health`; tidak ada metrik, tracing, atau alert. |

**Roadmap Phase 1 §2 juga mewajibkan UI:** sign-in, sign-out, workspace switcher, member list, role assignment, audit log viewer. Yang ada hanya route API + halaman boilerplate. Ini celah scope terbesar.

---

## 6. Security Checklist (`docs/04` §3/§4)

| Kontrol | Status | Bukti |
|---|---|---|
| Tenant ID dari session server, bukan body/URL | ✅ | `route-support.ts` `tenantContextFor()` memakai `grant.member.tenantId`; `:workspaceId` hanya klaim; test T2/T3/T4/T5 403 + 0 baris tertulis |
| Token TikTok AES-256-GCM | N/A (Phase 2) | Tidak ada kode/tabel; tidak diklaim selesai |
| App secret tidak ke browser | ✅ (vakum) | Tidak ada kode TikTok; `next.config.ts` tidak memakai `env`, tidak ada `NEXT_PUBLIC_*` rahasia |
| Idempotency key untuk job/outreach | ⚠️ | `background_jobs.idempotency_key VARCHAR(128) NOT NULL UNIQUE` ada; **belum ada kode enqueue** yang memakainya |
| Webhook signature | N/A (Phase 2) | — |
| Rate limiting per user/tenant/shop | ❌ | Hanya login: 10/15 menit **per IP**, in-memory, per proses (`rate-limit.ts`, TD-7C-A1). Tidak ada limit API umum 300/menit/user seperti `docs/04` §3.11 |
| Audit log append-only | ✅ | 1142 live + guard aplikasi + tidak ada `auditLog.update/delete` di kode produksi |
| OAuth state random/one-time/expiry | N/A (Phase 2) | — |
| CSRF enforced | ✅ | `verifyCsrf` di login, logout, register, create workspace, invite, change role; test T9 (tanpa token → 403). Token double-submit **tidak terikat session** (didokumentasikan) |
| Cookie httpOnly + secure (prod) + sameSite | ⚠️ | `session.ts`: `httpOnly: true`, `secure: NODE_ENV==="production"`, `sameSite: "lax"`. **Menyimpang dari rencana:** nama `session` (bukan `__Host-aos_session`), TTL **30 hari** (rencana 7 hari), **tidak ada idle timeout 24 jam**, `last_seen_at` tidak pernah diperbarui, tidak ada rotasi saat privilege berubah |
| Security headers (§3.12) | ❌ | `grep -rniE "content-security-policy|strict-transport|x-frame-options|permissions-policy|referrer-policy" apps/web` → **nol hasil**. Hanya `poweredByHeader: false` |
| Redaction logger + test (§3.16) | ❌ | Tidak ada modul logger/redaksi; yang ada hanya sanitasi metadata audit (`audit.ts`) dan redaksi pesan koneksi di `verify-connection.ts`. Test "secret tidak muncul di log" tidak ada |
| Test "setiap route `/api` mendeklarasikan permission" (§3.3) | ❌ | Tidak ditemukan test semacam itu |

---

## 7. Red Flag

### CRITICAL
Tidak ada. Tidak ditemukan kebocoran secret, `.env` ter-commit, atau bypass tenant pada jalur yang diuji.

### HIGH
1. **Empat checkpoint tidak dapat di-build (`7c-auth`, `7d-rbac`, `7e-audit`, `7f-cross-tenant`).** Tech debt #2/#3 terkonfirmasi, bahkan lebih buruk dari yang dilaporkan: 7C bukan hanya soal lock, melainkan kode yang mengimpor modul yang belum ada (`writeAudit`). Artefak "checkpoint" karena itu tidak dapat direproduksi/di-audit ulang secara mandiri.
2. **Rate limit hanya per-IP dan in-memory.** Berlaku untuk login saja; restart/multi-instance menghapusnya; tidak ada batas per user/tenant maupun fail-closed Redis seperti `docs/04` §3.11 (TD-7C-A1 sudah mencatat, tetapi tetap HIGH untuk produksi).
3. **Kebijakan session lebih lemah daripada dokumen keamanan:** 30 hari vs 7 hari, tanpa idle timeout, tanpa rotasi saat privilege berubah, cookie bukan `__Host-`. Semua ini mengurangi nilai kontrol "stolen cookie" di threat model §2.

### MEDIUM
4. **Security headers tidak ada** padahal `docs/04` §3.12 menetapkan verifikasinya di Phase 1 (CSP, HSTS, nosniff, frame-ancestors, no-store).
5. **Tidak ada lapisan redaction/logging hygiene** dan tidak ada test yang membuktikan secret tidak muncul di log (`docs/04` §3.16, §4).
6. **UI Phase 1 tidak ada.** Roadmap §2 mencantumkan sign-in, workspace switcher, member list, role assignment, audit viewer; exit criteria "fresh DB → migrate deploy → app boots" hanya terpenuhi di level API/health. `page.tsx` bahkan masih teks Checkpoint 6A yang menyatakan "belum ada tabel".
7. **`docs/01-PRD.md` yang dirujuk brief audit tidak ada.** Traceability requirement produk mengandalkan `00/01/02/05`, dan brief audit sendiri salah menunjuk file — risiko proses.
8. **Dokumentasi checkpoint usang:** tujuh laporan berstatus "DONE (uncommitted — commit ditahan oleh user)" padahal sudah di-commit, dan angka test di pesan commit tidak dapat direproduksi di tag tersebut.
9. **`permissions` dan `roles` kosong di DB dev** saat audit; siapa pun yang mengaudit via SQL tanpa seed akan menyimpulkan katalog tidak ada.

### LOW
10. `@@unique([tenantId, id])` tidak ada pada `audit_logs` dan `background_jobs` (desain §2.2 menyebut "setiap tabel tenant-scoped"); keduanya bukan target composite FK, jadi dampaknya kosmetik.
11. `audit_logs.tenant_id` nullable tanpa FK — typo tenant id akan diterima tanpa protes.
12. Guard `systemDb()` hanya komentar (`// SYSTEM:`), tidak ditegakkan lint/tipe. Saat ini semua call site produksi mematuhinya (diverifikasi via grep).
13. `apps/web/src/app/page.tsx` memuat teks status lama yang menyesatkan.
14. `docs/sql` hanya mengaktifkan blok grant `@localhost`; risiko "GRANT ke host tak dikenal membuat akun tanpa password" sudah didokumentasikan, tetapi keberadaan akun liar seperti `affiliateos_app@127.0.0.1` **UNVERIFIED** (butuh akses admin).

### Positif yang perlu dicatat
- Tidak ada `TODO/FIXME/HACK` di kode, tidak ada `.skip/.only/.todo` di test.
- Tidak ada hardcoded secret; `npm audit --omit=dev` = 0 vulnerability.
- `catch` yang menelan error hanya pada jalur yang didokumentasikan (verify password → false, body JSON invalid → 400, compensating delete) — tidak menyembunyikan kegagalan DB di route.
- Semua route mutasi memanggil `verifyCsrf`; semua akses tenant memakai `withTenant` atau `systemDb` bertanda `SYSTEM:`.

---

## 8. Verdict

**Phase 1 selesai? TIDAK — PARTIAL (~70%).**
Backend foundation dapat dipercaya (DB, isolasi, RBAC, audit terbukti di DB nyata; 299 test hijau), tetapi produk belum memenuhi exit criteria roadmap karena UI, kontrol keamanan perimeter, dan queue belum ada, serta separuh riwayat git tidak dapat di-build.

### 3 hal yang harus dibereskan sebelum Phase 2/3
1. **Buat setiap tag dapat di-build:** tambahkan `build:permissions` ke root `build` untuk 7D–7F, commit `package-lock.json` di setiap checkpoint (atau hentikan pemecahan commit yang memisahkan lock), dan hilangkan impor `writeAudit` dari tree 7C. Praktisnya: perbaiki **forward** di `main` + tag baru, jangan menulis ulang 7 tag yang sudah jadi; tambahkan job CI "build setiap tag".
2. **Lengkapi kontrol keamanan yang sudah dijanjikan dokumen:** security headers, rate limit per user/tenant dengan Redis (fail-closed), idle timeout 24 jam + TTL 7 hari + cookie `__Host-` + rotasi session, modul redaction + test-nya, dan test "setiap route mendeklarasikan permission".
3. **Kirim UI Phase 1:** sign-in/out, workspace switcher, member list, role assignment, audit viewer read-only — atau revisi roadmap secara eksplisit bila UI ditunda.

### 3 hal yang TIDAK boleh diklaim selesai sampai ada bukti
1. **"Isolasi lintas tenant mencakup semua entitas P1"** — baru terbukti untuk workspace, member, invitation, role. `audit_logs` dan `background_jobs` tidak punya test cross-tenant, dan nested write pada `withTenant` tidak diuji (diakui di TD-7B-C1/C2).
2. **"Rate limiting selesai"** — yang ada hanya login per-IP in-memory; tidak ada limit API umum, per-user, per-tenant, atau perilaku fail-closed.
3. **"Semua kontrol `docs/04` §4 Phase 1 terverifikasi"** — headers, redaction, idle timeout, dan route-permission check tidak punya bukti.

---

## 9. Rekomendasi

| Pertanyaan | Rekomendasi |
|---|---|
| Commit/rebasing tech debt #2/#3? | **Jangan rebase/rewrite 7 tag.** Perbaiki forward: satu commit "build(ci): make every checkpoint buildable" (build script + lockfile + hapus impor audit di tree 7C tidak mungkin forward — cukup dokumentasikan 7C sebagai historis), lalu tag `checkpoint-8b-buildfix`. Tambahkan CI matrix per tag. |
| Push ke GitHub? | **Ya, segera setelah buildfix**, sebagai arsip audit (tag lokal mudah hilang). Belum ada remote; perlu dibuat dulu dan itu keputusan user. Push tidak memerlukan rewrite apa pun. |
| Lanjut Phase 2/3? | **Belum.** Phase 2 butuh Redis + app Partner Center + token encryption; Phase 3 (Creator CRM) justru bisa mulai setelah UI/auth inti stabil. Urutan yang disarankan: buildfix → UI Phase 1 + headers/rate-limit/session → Phase 2. |
| Ajukan approval TikTok? | **Ya, ajukan sekarang** (tidak ada dependensi kode; menghilangkan R1 dari jalur kritis). Jangan menulis kode Phase 2 yang mengasumsikan scope tertentu sebelum approval; capability matrix sudah siap sebagai dasar pengajuan. |

---

## 10. Lampiran — Perintah Bukti Utama

```bash
# riwayat
git log --oneline 65bdcfd..HEAD ; git tag -l ; git log --format=full -7
git log --all --full-history -- .env          # kosong

# database (akun runtime affiliateos_app)
SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE();      # 13
SELECT COUNT(DISTINCT CONSTRAINT_NAME) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL;             # 16
SHOW GRANTS;                                                                       # 12 DML + audit SELECT,INSERT
UPDATE audit_logs SET action='tampered' LIMIT 1;                                   # ERROR 1142
DELETE FROM audit_logs LIMIT 1;                                                    # ERROR 1142
CREATE TABLE audit_probe_x (id INT);                                               # ERROR 1142

# build per checkpoint (worktree terpisah, main tidak disentuh)
for t in checkpoint-7b-p02-accounts ... checkpoint-8a-worker; do
  git -C /tmp/audit-wt checkout -f "$t"; (cd /tmp/audit-wt && npm ci && npm run build)
done

# test di HEAD
npm test                                              # permissions 10 + database 46
npm run test --workspace @affiliateos/web             # 243
```

**Ketidakmampuan verifikasi yang jujur dicatat:**
- `SHOW GRANTS FOR 'affiliateos_app'@...` sebagai admin tidak dapat dijalankan (tanpa root); grant diverifikasi dari sisi akun itu sendiri (`SHOW GRANTS`) dan dari penolakan 1142.
- Keberadaan akun MariaDB liar (`affiliateos_app@127.0.0.1`) tidak dapat diperiksa tanpa akses `mysql.user`.
- Build 7C–7F dijalankan di atas `npm install` karena lock tidak sinkron; verdict 7D–7F tetap valid (error TypeScript first-party), sedangkan status runtime `argon2` di tree tersebut tidak dapat dibuktikan.
- Klaim availability/backup/observability produksi tidak dapat diuji: tidak ada deployment.
