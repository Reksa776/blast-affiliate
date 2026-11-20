# AffiliateOS

AffiliateOS adalah aplikasi internal untuk operasional affiliate TikTok Shop. Aplikasi ini bisa dijalankan di server yang dikelola sendiri. Belum ada langganan SaaS atau billing di dalam aplikasinya; biaya server/database dan akses layanan eksternal tetap mengikuti penyedia masing-masing.

## Fitur yang tersedia

- Akun, sesi, CSRF, workspace, anggota, role, audit log, dan pembatasan request.
- Penerimaan undangan dapat membuat akun anggota pertama kali. Di development link dapat disalin dan dibagikan manual; layanan email belum terpasang.
- Creator CRM: tambah, cari, filter dan edit kreator; pipeline status; catatan; tag; PIC/BD owner; blacklist; impor dan ekspor CSV.
- Campaign lokal: kalender/status, anggaran, daftar kreator, dan brief berversi. Siapkan undangan personal hingga 100 kreator sekaligus, salin pesan, catat hasil berhasil/gagal, lalu coba ulang secara manual.
- Data creator/campaign tersimpan per workspace. Angka performa dan data toko belum berasal dari TikTok.

## Prasyarat

- Node.js 24 atau lebih baru.
- MariaDB yang sudah dibuat, dengan akun runtime dan akun migrasi sesuai `docs/10-DATABASE-SECURITY-SEPARATION.md`.
- `DATABASE_URL`, `MIGRATE_DATABASE_URL`, dan `SHADOW_DATABASE_URL` disetel di `.env` lokal. Jangan commit file `.env`.

## Menjalankan lokal

```bash
cp .env.example .env
npm install
npm run build
npm run prisma:deploy
node packages/database/dist/src/scripts/seed-rbac.js
```

Migration CRM dan campaign membuat tabel bisnis yang sebelumnya hanya didefinisikan di schema. Setelah migration, berikan hak per-tabel untuk 14 tabel baru ke akun runtime memakai `docs/sql/0003-local-crm-campaign-grants.sql`; file ini hanya menargetkan `affiliateos_app@localhost`, tanpa membuat akun atau mengganti password. Perintahnya memerlukan MariaDB admin/`GRANT OPTION`. Runbook lengkap `docs/sql/0002-p0.3-per-table-grants.sql` tetap draft untuk konfigurasi least privilege menyeluruh. Jangan mengganti hak per-tabel dengan grant seluruh schema.

`prisma:deploy` mengubah database; arahkan `.env` ke database yang benar dan siapkan backup sesuai prosedur operator sebelum menjalankannya.

```bash
npm run dev
```

Buka URL lokal Next.js yang ditampilkan, buat akun pertama di `/register`, masuk, lalu buat workspace.

Worker saat ini hanya memeriksa kesehatan koneksi database. Undangan kreator massal menyiapkan teks personal untuk disalin dan mencatat hasil/percobaan; aplikasi tidak mengirim atau mendeteksi kegagalan secara otomatis. Queue, sinkronisasi TikTok, pengiriman email, order, outreach otomatis, dan analytics live belum tersedia. Campaign ditandai lokal sampai koneksi TikTok benar-benar dikonfigurasi dan diizinkan.

## Pengembangan

- `npm run dev:web` — aplikasi web.
- `npm run dev:worker` — worker placeholder.
- `npm run typecheck` — cek tipe workspace.
- `npm test` — test package permissions dan database; test web dijalankan dengan `npm run test --workspace @affiliateos/web`.

Lihat [roadmap](docs/05-ROADMAP.md) dan [matrix kemampuan TikTok](docs/03-TIKTOK-API-CAPABILITY-MATRIX.md) untuk fase integrasi dan prasyarat eksternal.
