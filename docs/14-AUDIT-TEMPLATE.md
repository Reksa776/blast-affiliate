# 14 — AUDIT TEMPLATE (RE-AUDIT PER CHECKPOINT)

> Template for an independent re-audit of any checkpoint. One whole block, from
> `BEGIN TEMPLATE` to `END TEMPLATE`. Save each filled audit as
> `docs/AUDIT-CHECKPOINT-<N>-YYYY-MM-DD.md`.

```text
BEGIN TEMPLATE
TASK: AUDIT CHECKPOINT <NOMOR> AFFILIATEOS

Kamu auditor independen. Audit progres checkpoint <NOMOR> secara objektif. JANGAN percaya laporan checkpoint. Verifikasi ulang semuanya.
ATURAN
    JANGAN tandai PASS tanpa bukti file, baris, atau output command.
    JANGAN anggap "file ada" sama dengan "fitur selesai".
    JANGAN anggap mock sama dengan integrasi live.
    Kalau tidak bisa verifikasi, tulis UNVERIFIED dengan alasan.
    Laporkan red flag, termasuk yang tidak diminta.
LANGKAH AUDIT
    Git: jalankan git log --oneline -20, git status, git tag -l, dan git diff --stat <checkpoint-sebelumnya>..HEAD. Verifikasi ada commit dan tag per checkpoint.
    Test: jalankan npm test, npm run typecheck, npx prisma validate, dan npx prisma migrate status. Tampilkan exit code dan ringkasan.
    Database: query SELECT table_name FROM information_schema.TABLES WHERE table_schema='affiliateos'. Bandingkan dengan target checkpoint. Verifikasi grant dengan SHOW GRANTS FOR 'affiliateos_app'@'localhost'. Pastikan audit_logs TIDAK punya UPDATE atau DELETE.
    Kode: hitung baris non-generated per paket. Verifikasi setiap modul yang diklaim selesai punya implementasi, test, dan wiring (route atau worker).
    Exit criteria checkpoint: baca docs/05-ROADMAP.md untuk checkpoint ini, verifikasi satu per satu dengan bukti.
    Dokumentasi: cek docs/PHASE-<N>-CHECKPOINT-<N>.md ada dan lengkap, memuat implementation report, file yang berubah, migration, test, known limitations, dan prompt fase berikut.
    Kepatuhan aturan wajib dari audit 2026-11-17 bagian 8:
        tenant_id diambil dari session server, bukan body request
        token TikTok dienkripsi
        app secret tidak pernah dikirim ke browser
        idempotency key untuk job dan outreach
        webhook signature validation
        rate limiting per user, tenant, dan shop
        audit log append-only (dicek dari grant DB)
        OAuth state random, one-time, dan punya expiry
    Red flag scan: grep TODO dan FIXME di area kritis, cek endpoint TikTok hardcoded, kuota hardcoded, test yang di-skip, dan mock yang diklaim live.
FORMAT OUTPUT
    Executive summary, 3 sampai 5 baris.
    Status per task checkpoint dalam tabel: task, status, bukti.
    Red flag baru dengan severity CRITICAL, HIGH, MEDIUM, atau LOW.
    Regresi dari checkpoint sebelumnya, kalau ada.
    Verdict: checkpoint LULUS, PARTIAL, atau GAGAL, plus 3 alasan.
    Rekomendasi checkpoint berikutnya, maksimal 5 item.
SIMPAN SEBAGAI

docs/AUDIT-CHECKPOINT-<N>-YYYY-MM-DD.md
END TEMPLATE
```
