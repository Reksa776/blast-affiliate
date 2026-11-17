# Phase 1 — Checkpoint 8C: Session Policy (HIGH #3)

**Status: DONE** — TTL 7 hari, idle timeout 24 jam, cookie `__Host-` di production,
rotasi saat privilege berubah, dan `last_seen_at` kini benar-benar diperbarui.
Tidak ada migration: `sessions.last_seen_at` sudah ada di schema (DATETIME(3) NOT NULL
DEFAULT `CURRENT_TIMESTAMP(3)`), jadi aturan "jangan migrate tanpa approval" tidak terpicu.

**Belum di-commit.** HEAD tetap `05cb987`.

---

## 1. Perubahan Kebijakan (`apps/web/src/lib/auth/session.ts`)

| Sebelum (audit) | Sesudah |
|---|---|
| `SESSION_TTL_MS` 30 hari | **7 hari** (`604800000` ms, `Max-Age=604800`) |
| tanpa idle timeout | **24 jam** sejak `last_seen_at`; sesi idle dihapus saat validasi |
| `last_seen_at` tidak pernah ditulis | ditulis saat create, lalu di-refresh **maksimal 1×/jam** |
| tanpa rotasi | `rotateSession()` + `revokeAllSessionsForUser()` |
| cookie `session` | `__Host-aos_session` (production) / `aos_session` (dev) |

Detail implementasi:

- `createSession()` menyetel `lastSeenAt = now` secara eksplisit (bukan mengandalkan
  default kolom), sehingga jendela idle mulai dari pembuatan.
- `validateSession()` menolak dan **menghapus** sesi yang melewati absolute expiry atau
  idle 24 jam; sesi yang di-revoke **tidak** dihapus agar jejaknya tetap ada.
- Refresh `lastSeenAt` hanya bila nilai tersimpan lebih tua dari 1 jam, memakai
  `updateMany` supaya sesi yang di-revoke bersamaan tidak melempar error.
- `rotateSession(oldToken, …)` me-revoke token lama (`revoked_at`, bukan delete) lalu
  membuat sesi baru; route mengirim cookie baru pada respons yang sama.
- `revokeAllSessionsForUser(userId)` me-revoke semua sesi hidup user tersebut.
- `sessionCookieOptions()`: `httpOnly`, `sameSite=lax`, `path=/`, `maxAge=604800`,
  `secure` hanya production, dan **tidak pernah** menyetel `Domain` (syarat `__Host-`).

## 2. Nama Cookie

Modul baru `apps/web/src/lib/auth/cookie-name.ts` (tanpa dependency, satu sumber
kebenaran untuk route, middleware, dan test):

```
production  → __Host-aos_session
selain itu  → aos_session
```

`__Host-` hanya sah bila `Secure`, `Path=/`, dan tanpa `Domain` — karena `Secure` tidak
bisa dikirim lewat http, dev memakai nama polos. Konsekuensinya dicatat sebagai deviasi
yang disengaja, bukan bug.

## 3. Rotasi Saat Privilege Berubah

| Route | Yang dirotasi | Cookie baru dikirim? |
|---|---|---|
| `PATCH /api/workspaces/:id/members/:memberId/role` | **semua sesi user yang diubah** (`revokeAllSessionsForUser`) | tidak — user itu harus login ulang |
| `POST /api/workspaces` | sesi **pembuat** (owner role baru lahir) | ya, `Set-Cookie` pada 201 |
| `POST /api/invitations/accept` | sesi **penerima** (membership baru aktif) | ya, `Set-Cookie` pada 200 |
| `POST /api/workspaces/:id/members` (invite) | **tidak** — lihat deviasi di §6 | — |

Middleware (`requireAuth`) dan logout memakai `getSessionCookieName()`, jadi pembacaan
dan penghapusan cookie selalu mengikuti nama yang aktif.

## 4. Test

Unit + integrasi DB nyata (`affiliateos_test`), tanpa mock jam: waktu digeser dengan
mengubah baris `sessions`.

| Test | Isi | Hasil |
|---|---|---|
| T1 | `createSession`: `lastSeenAt`≈now, `expiresAt`=+7 hari (tersimpan di DB) | PASS |
| T2 | `lastSeenAt` 2 jam lalu → valid dan `last_seen_at` maju | PASS |
| T3 | `lastSeenAt` 25 jam lalu → `null` + baris dihapus | PASS |
| T4 | `expiresAt` 1 jam lalu (lastSeen baru) → `null` + baris dihapus | PASS |
| T5 | `revokedAt` terisi → `null`, baris dipertahankan | PASS |
| T6 | `lastSeenAt` 30 menit → tidak ada write (throttle) | PASS |
| T7 | `rotateSession` → token lama revoked & tidak valid, token baru valid | PASS |
| T8 | `revokeAllSessionsForUser` → semua sesi user revoked | PASS |
| T9 | role change (HTTP) → semua sesi user target `revoked_at` terisi | PASS |
| T10 | login (HTTP) → `lastSeenAt` di-age 25 jam → `GET /api/auth/me` 401 + baris dihapus | PASS |
| T11 | nama cookie: `__Host-aos_session` (prod) / `aos_session` (dev) | PASS |
| T12 | atribut cookie: Max-Age 604800, Secure hanya prod, tanpa Domain; cleared Max-Age 0 | PASS |

Test HTTP lama ikut diperbarui, bukan di-skip: semua request kini memakai nama cookie
dari `getSessionCookieName()`, dan test yang membuat workspace/accept invitation
mengadopsi token hasil rotasi dari `Set-Cookie` (jika tidak, request berikutnya memang
harus 401).

### Hasil eksekusi

| Perintah | Hasil | Exit |
|---|---|---|
| `npm test --workspace @affiliateos/database` | **46 pass / 0 fail** | **0** |
| `npm test --workspace @affiliateos/web` | **283 pass / 0 fail** (12 suite file) | **0** |
| `npm run typecheck --workspace @affiliateos/web` | bersih | **0** |
| `npm run build` (root) | 11 route + `ƒ Proxy (Middleware)` | **0** |

## 5. Smoke Manual (server nyata, DB test, :3060)

| Langkah | Hasil |
|---|---|
| Reset DB test | `users_after_reset=0` |
| Register bootstrap | `register_status=201` |
| Login | `login_status=200` |
| Set-Cookie | `aos_session=<TOKEN>; Path=/; Expires=…; Max-Age=604800; HttpOnly; SameSite=lax` |
| Atribut | HttpOnly ✓, SameSite=lax ✓, Path=/ ✓, Max-Age=604800 ✓, **tanpa Domain** ✓ |
| `GET /api/auth/me` sebelum idle | `200` |
| Age sesi 25 jam di DB | `sessions_aged=1` |
| `GET /api/auth/me` sesudahnya | **`401`** |
| Baris sesi setelah penolakan | `sessions_after_idle_delete=0` |
| Cleanup | `users=0, sessions=0`, port 3060 bebas |

Login di dev mengirim `aos_session` (tanpa prefix) — benar, karena `Secure` tidak bisa
dipaksa di http; nama `__Host-` diverifikasi lewat unit test, bukan dengan memaksa
browser menolak cookie.

## 6. Deviasi (disengaja, dengan alasan)

1. **Invite tidak me-revoke sesi undangan.** Brief meminta rotasi di
   `POST .../members`, tetapi invite **tidak mengubah privilege** — privilege baru lahir
   saat invitation di-*accept*. Me-revoke di titik invite akan (a) memaksa user login
   ulang sebelum ia bisa menerima, dan (b) memberi siapa pun yang punya `member.invite`
   kemampuan memaksa-logout akun mana pun hanya dengan mengundang emailnya. Rotasi
   karena itu dilakukan di **accept invitation** (grant sebenarnya) dan pada role change.
2. **Dev memakai `aos_session`, production `__Host-aos_session`** — konsekuensi aturan
   `Secure` pada prefix, sesuai brief.
3. **`lastSeenAt` di-throttle 1 jam**, bukan ditulis setiap request: sesi aktif tetap
   hidup, tetapi biaya tulis turun dari O(request) ke O(1/jam/sesi).
4. **TTL tetap absolut 7 hari** dan tidak diperpanjang oleh aktivitas (rotasi hanya
   terjadi pada privilege change), sesuai docs/04 §3.4.

## 7. Known Limitations

- Sesi yang dibuat sebelum deploy akan dianggap idle setelah 24 jam tanpa aktivitas
  (perilaku yang diinginkan, tetapi user lama akan diminta login ulang).
- Logout hanya menghapus cookie dengan nama aktif; cookie `session` lama (pra-8C) tidak
  dibersihkan — ia diabaikan server dan kedaluwarsa sendiri.
- `__Host-` belum diuji lewat HTTPS nyata (tidak ada deployment); kebenarannya
  bergantung pada aturan browser + unit test atribut.
- Forced logout akibat role change tidak memberi tahu user (tidak ada email/UI notice);
  user hanya melihat 401 dan harus login lagi.

## 8. Tech Debt Baru

| ID | Severity | Item |
|---|---|---|
| TD-8C-R1 | LOW | Refresh `last_seen_at` menambah ≤1 write/jam/sesi; bisa dibatch/di-debounce bila trafik tinggi |
| TD-8C-R2 | LOW | Tidak ada notifikasi ke user saat sesinya dicabut karena role change |
| TD-8C-R3 | MEDIUM | Belum ada verifikasi `__Host-` di lingkungan HTTPS/production nyata |
| TD-8C-R4 | LOW | Cookie lama `session` tidak dibersihkan saat logout (hanya kedaluwarsa) |

## 9. Diff (belum di-commit)

Lihat `git diff --stat` pada laporan akhir. File inti:

```
baru  apps/web/src/lib/auth/cookie-name.ts
ubah  apps/web/src/lib/auth/session.ts
ubah  apps/web/src/lib/auth/session.test.ts
ubah  apps/web/src/lib/auth/middleware.ts
ubah  apps/web/src/lib/auth/test-fixtures.ts
ubah  apps/web/src/app/api/auth/login/route.ts
ubah  apps/web/src/app/api/auth/logout/route.ts
ubah  apps/web/src/app/api/workspaces/route.ts
ubah  apps/web/src/app/api/workspaces/[workspaceId]/members/[memberId]/role/route.ts
ubah  apps/web/src/app/api/invitations/accept/route.ts
ubah  test HTTP: auth, auth-audit, cross-tenant, workspace-audit, office-settings,
      accept-invitation, workspace-rate-limit
```

Tidak ada file migration baru. `package-lock.json` tidak berubah.
