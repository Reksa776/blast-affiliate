# AffiliateOS

AffiliateOS adalah aplikasi internal untuk mengelola database kreator TikTok Shop, campaign affiliate, dan kerja tim. Aplikasi dapat di-host sendiri. Aplikasi ini belum berupa SaaS berlangganan dan belum terhubung ke TikTok Shop API.

> **Status fitur penting:** fitur blast saat ini menyiapkan pesan personal untuk disalin, lalu operator mengirimnya sendiri melalui channel pilihan. AffiliateOS belum mengirim undangan ke TikTok, tidak membaca hasil dari TikTok, dan tidak melakukan retry otomatis. Status berhasil/gagal dicatat oleh operator.

## Daftar isi

- [Fitur yang tersedia](#fitur-yang-tersedia)
- [Prasyarat production](#prasyarat-production)
- [Deploy production di VPS](#deploy-production-di-vps)
- [Database, akun, migrasi, dan backup](#database-akun-migrasi-dan-backup)
- [Update versi aplikasi](#update-versi-aplikasi)
- [Cara menggunakan aplikasi](#cara-menggunakan-aplikasi)
- [Health check dan troubleshooting](#health-check-dan-troubleshooting)
- [Batasan yang diketahui](#batasan-yang-diketahui)
- [Development](#development)

## Fitur yang tersedia

- **Akun dan akses:** login, sesi, proteksi CSRF, role berbasis workspace, audit log, dan rate limit.
- **Workspace dan tim:** buat workspace, kelola anggota dan role, serta pengaturan nama, alamat, zona waktu, dan jam kerja.
- **Creator CRM:** tambah, cari, filter, edit, dan hapus data kreator; status pipeline; catatan; tag; PIC/BD owner; blacklist; impor dan ekspor CSV.
- **Campaign:** jadwal/tanggal, status, anggaran, label toko, daftar kreator, dan brief berversi.
- **Undangan manual:** personalisasi pesan hingga 100 kreator per batch, salin pesan, dan catat status terkirim atau gagal. Kreator dengan status gagal dapat dipilih kembali untuk dicoba secara manual.
- **Audit:** catatan aktivitas yang relevan dapat dilihat oleh role yang memiliki izin audit.

Data CRM dan campaign diinput manual dan terpisah per workspace. Angka performa, produk, dan data toko belum disinkronkan dari TikTok.

## Prasyarat production

- Linux VPS/server yang dikelola sendiri, dengan domain dan HTTPS.
- Node.js **24 atau lebih baru** dan npm yang cocok dengan lockfile.
- MariaDB dengan database/schema `affiliateos` yang sudah dibuat.
- Nginx atau reverse proxy HTTPS lain di depan Next.js.
- Akun database runtime terpisah dari akun migrasi. Jangan menjalankan aplikasi sebagai MariaDB `root`.
- Backup database sebelum migrasi dan prosedur pemulihan yang pernah dicoba.

Contoh di bawah mengasumsikan Ubuntu/Debian, checkout aplikasi di `/opt/affiliateos`, domain `affiliateos.example.com`, dan port lokal `3000`. Sesuaikan lokasi, domain, username Linux, serta pengelolaan TLS dengan servermu.

## Deploy production di VPS

### 1. Siapkan server dan checkout kode

Pasang Node.js 24+, npm, MariaDB client, Nginx, dan Git sesuai metode yang kamu gunakan. Buat user Linux khusus untuk menjalankan aplikasi, lalu clone repository:

```bash
sudo adduser --system --group --no-create-home affiliateos
sudo install -d -o <DEPLOY-USER> -g affiliateos /opt/affiliateos
git clone <URL-REPOSITORY> /opt/affiliateos
cd /opt/affiliateos
```

`<DEPLOY-USER>` adalah akun operator yang melakukan release; service berjalan dengan user Linux terbatas `affiliateos`. Jangan masukkan file `.env`, dump database, token, atau credential ke Git maupun image build.

### 2. Buat konfigurasi rahasia

```bash
cd /opt/affiliateos
cp .env.example .env
chmod 600 .env
nano .env
```

Isi nilai sesuai environment. Bentuk URL database:

```dotenv
DATABASE_URL="mysql://affiliateos_app:<PASSWORD-URL-ENCODED>@127.0.0.1:3306/affiliateos"
MIGRATE_DATABASE_URL="mysql://affiliateos_migrate:<PASSWORD-URL-ENCODED>@127.0.0.1:3306/affiliateos"
SHADOW_DATABASE_URL="mysql://affiliateos_shadow:<PASSWORD-URL-ENCODED>@127.0.0.1:3306/affiliateos_shadow"
TRUST_PROXY=true
```

`DATABASE_URL` dipakai web/worker. `MIGRATE_DATABASE_URL` hanya untuk migrasi. `SHADOW_DATABASE_URL` hanya untuk Prisma development/migration tooling; database shadow harus terpisah dari database aplikasi. Prisma config saat ini meminta variabel ini tersedia saat menjalankan command CLI. File `.env` di root dipakai oleh command CLI saat build/migrasi dan juga memuat credential deployment, jadi batasi permission-nya ke operator deploy. **Jangan berikan file itu ke proses web.** Buat file runtime tersendiri `/etc/affiliateos/web.env` yang hanya berisi `DATABASE_URL`, `TRUST_PROXY`, dan pool override yang diperlukan.

Gunakan password acak yang berbeda untuk tiap akun, URL-encode karakter khusus pada password (`@`, `:`, `/`, `%`, dan lainnya), dan batasi akses database ke host aplikasi. `TRUST_PROXY=true` hanya jika reverse proxy di depan aplikasi benar-benar menimpa header IP client. Jangan memasukkan App key/secret TikTok di sini: integrasi TikTok belum tersedia di aplikasi.

### 3. Siapkan database dan hak akses

Buat database `affiliateos`, database shadow terpisah, serta akun runtime, migration, dan shadow melalui DBA/MariaDB admin. Ikuti prinsip least privilege di [docs/10-DATABASE-SECURITY-SEPARATION.md](docs/10-DATABASE-SECURITY-SEPARATION.md):

- Akun **runtime** hanya mendapat hak per-tabel yang dibutuhkan aplikasi. `audit_logs` bersifat insert/select dari sisi aplikasi.
- Akun **migration** mendapat DDL/DML hanya pada database aplikasi.
- Akun **shadow** hanya boleh mengakses database shadow.
- Jangan memberi runtime hak DDL, `GRANT OPTION`, atau akses ke schema lain.

File [docs/sql/0002-p0.3-per-table-grants.sql](docs/sql/0002-p0.3-per-table-grants.sql) adalah draft/template dan perlu ditinjau serta disesuaikan dengan akun/host database production. File [docs/sql/0003-local-crm-campaign-grants.sql](docs/sql/0003-local-crm-campaign-grants.sql) hanya untuk akun lokal `affiliateos_app@localhost`; **jangan jalankan file tersebut mentah-mentah di production**. Setelah migration menambah tabel, berikan grant runtime yang sesuai untuk tabel baru.

### 4. Install dependency dan build

Pastikan `.env` sudah lengkap agar Prisma CLI dapat membaca konfigurasi database.

```bash
cd /opt/affiliateos
npm ci
npm run build
```

Build root membuat package permissions, Prisma Client/database package, worker, dan web production build.

### 5. Backup, cek, dan jalankan migration

Ambil backup sebelum menerapkan migration. Contoh berikut meminta password secara interaktif:

```bash
mariadb-dump -u <DB_ADMIN> -p --single-transaction affiliateos > /path/backup/affiliateos-before-migration.sql
```

Lalu cek migration yang tertunda dan deploy:

```bash
npm run prisma:status
npm run prisma:deploy
npm run prisma:status
```

`prisma:deploy` menerapkan semua migration yang belum tercatat. Migration repository saat ini mencakup fondasi, office settings, Creator CRM, campaign lokal, serta pencatatan kegagalan undangan. Pada database baru semua migration akan dijalankan; pada database yang sudah aktif hanya migration yang belum diterapkan yang berjalan.

Setelah migration, cek dan lengkapi grant per-tabel akun runtime berdasarkan tabel yang benar-benar ada. Jangan menjalankan deployment migration menggunakan URL akun runtime.

### 6. Isi permission catalog

Setelah build dan migration selesai, seed katalog permission global:

```bash
node packages/database/dist/src/scripts/seed-rbac.js
```

Perintah ini idempotent. Role workspace akan dibuat otomatis saat workspace pertama kali dibuat. Pastikan command sukses sebelum aplikasi dibuka.

### 7. Jalankan aplikasi sebagai service

Buat service systemd, misalnya `/etc/systemd/system/affiliateos.service`:

```ini
[Unit]
Description=AffiliateOS web
After=network.target mariadb.service

[Service]
Type=simple
User=affiliateos
Group=affiliateos
WorkingDirectory=/opt/affiliateos
Environment=NODE_ENV=production
EnvironmentFile=/etc/affiliateos/web.env
ExecStart=/usr/bin/npm run start --workspace @affiliateos/web -- --hostname 127.0.0.1 --port 3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Ganti `/usr/bin/npm` dengan lokasi npm yang benar di server (`command -v npm`). Buat `/etc/affiliateos/web.env` dengan owner `root`, group `affiliateos`, dan permission `640` agar hanya root dan user service yang dapat membacanya. File ini hanya berisi credential runtime. Jangan tambahkan `MIGRATE_DATABASE_URL` atau `SHADOW_DATABASE_URL` ke environment web. Simpan `.env` deployment dengan owner operator dan permission `600`; user service tidak perlu dapat membacanya. Pastikan source dan hasil build dapat dibaca service user.

Kalau service diletakkan di belakang Nginx, atur Nginx untuk **menimpa** `X-Forwarded-For`/`X-Real-IP` dari koneksi masuk, lalu teruskan host dan protocol asli. Karena `TRUST_PROXY=true` mempercayai header tersebut untuk rate limit, jangan aktifkan bila proxy tidak terkontrol. Konfigurasi TLS Nginx harus memakai sertifikat valid dan meneruskan request ke `http://127.0.0.1:3000`. Jangan mengekspos port 3000 atau port MariaDB secara publik.

Aktifkan dan jalankan service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now affiliateos
sudo systemctl status affiliateos
```

Setelah DNS dan reverse proxy HTTPS selesai, buka `https://affiliateos.example.com`.

### 8. Tutup pendaftaran awal

Route `/register` hanya untuk bootstrap akun pertama. Ia otomatis menolak pendaftaran setelah user pertama ada. Buat akun tersebut sendiri, gunakan password kuat minimal 12 karakter, lalu segera buat workspace. Sebelum akun pertama dibuat, batasi akses publik ke aplikasi (misalnya firewall/IP allowlist); setelah bootstrap berhasil, route pendaftaran tertutup otomatis.

## Database, akun, migrasi, dan backup

### Matriks URL per proses

| Proses | `DATABASE_URL` | `MIGRATE_DATABASE_URL` | `SHADOW_DATABASE_URL` |
|---|---|---|---|
| Web/worker runtime | Akun runtime | Tidak dipakai | Tidak dipakai |
| `prisma:deploy` / status | Tersedia untuk env loader | Akun migration (lebih diutamakan) | URL schema shadow untuk konfigurasi Prisma |
| Seed permission | Akun runtime | Tidak diperlukan | Tidak diperlukan |

`prisma.config.ts` masih punya fallback ke `DATABASE_URL` bila `MIGRATE_DATABASE_URL` kosong. Di production isi dan pakai akun migration yang terpisah; jangan mengandalkan fallback tersebut.

### Aturan migration

1. Terapkan perubahan schema lewat folder migration yang committed di `packages/database/prisma/migrations/`.
2. Sebelum update production, ambil backup dan cek `npm run prisma:status`.
3. Deploy dengan `npm run prisma:deploy`; jangan menggunakan `prisma migrate dev` di production.
4. Setelahnya, cek status migration lagi, cek readiness, dan pastikan grant tabel runtime mencakup tabel baru.
5. Jangan mengedit migration yang sudah diterapkan. Untuk koreksi, buat migration baru.
6. Jika deployment gagal, jangan menghapus baris migration atau menebak SQL rollback. Pulihkan backup atau buat perbaikan terencana setelah memahami keadaan schema.

Contoh restore (menghapus/mengganti data database target; pastikan target benar):

```bash
mariadb -u <DB_ADMIN> -p affiliateos < /path/backup/affiliateos-before-migration.sql
```

Simpan backup terenkripsi di lokasi terpisah, tetapkan retensi, dan lakukan uji restore berkala. Jangan menyimpan backup di folder web yang dapat diakses publik.

## Update versi aplikasi

Jalankan sebagai prosedur release terjadwal:

```bash
cd /opt/affiliateos
sudo systemctl stop affiliateos
git fetch --all
git checkout <TAG-ATAU-COMMIT-RELEASE>
npm ci
npm run build
npm run prisma:status
npm run prisma:deploy
node packages/database/dist/src/scripts/seed-rbac.js
sudo systemctl start affiliateos
sudo systemctl status affiliateos
```

Gunakan backup database sebelum migration. Untuk downtime minimal, deploy dengan release directory/blue-green setelah prosedur itu diuji di staging. Tidak ada mekanisme rollback otomatis.

## Cara menggunakan aplikasi

### 1. Buat akun pertama dan workspace

1. Buka `/register`, buat akun owner pertama (password minimal 12 karakter).
2. Masuk lewat `/sign-in`.
3. Dari halaman **Workspaces**, pilih **Buat workspace**. User pembuat otomatis menjadi **Workspace Owner**.
4. Buka workspace. Dashboard menampilkan ringkasan kreator, campaign, anggota, audit, serta jam kerja.

Kalau akun sudah pernah dibuat, `/register` memang ditutup. Gunakan akun yang ada atau undangan workspace.

### 2. Isi Creator CRM

1. Buka menu **Creators / Creator CRM**.
2. Pilih **Tambah kreator** lalu isi username TikTok dan nama tampilan. Followers dan catatan profil opsional.
3. Kelola pipeline status, detail kreator, catatan, tag, dan PIC sesuai proses tim.
4. Gunakan pencarian/filter untuk menemukan kreator.
5. **Import CSV** menerima kolom wajib `username` dan `displayName`; `followerCount` dan `bio` opsional; maksimal 500 baris per impor. **Export CSV** tersedia untuk role yang punya izin ekspor.
6. Gunakan blacklist untuk menandai kreator yang tidak boleh dihubungi. Kreator blacklist tidak dapat dipilih untuk undangan campaign.

Masukkan username tanpa atau dengan `@`; periksa data hasil impor agar tidak ada kreator duplikat.

### 3. Buat campaign dan brief

1. Buka **Campaigns** lalu buat campaign.
2. Isi nama, tanggal, status, anggaran/mata uang, dan label toko bila diperlukan.
3. Buka detail campaign untuk mengelola kreator dan brief.
4. Simpan brief dengan judul dan isi (deliverables, CTA, timeline, serta arahan konten). Setiap simpan membuat versi baru; versi sebelumnya tetap terlihat.

Campaign saat ini adalah catatan perencanaan internal. Menyimpan campaign di AffiliateOS tidak membuat campaign di TikTok Shop.

### 4. Siapkan dan kirim undangan secara manual

1. Di detail campaign, pilih hingga 100 kreator yang tersedia. Kreator harus sudah ada di CRM dan tidak sedang diblacklist.
2. Isi template pesan. Variabel yang bisa dipakai: `{{nama}}`, `{{username}}`, `{{campaign}}`, dan `{{brand}}`.
3. Gunakan preview, lalu klik **Salin semua pesan**. Kirim pesan melalui channel pilihanmu di luar AffiliateOS.
4. Setelah benar-benar mengirim, centang konfirmasi pengiriman dan pilih **Catat undangan terkirim**. Status dan jumlah percobaan tercatat.
5. Jika pengiriman manual gagal, pilih kreator terkait, isi catatan error jika perlu, centang konfirmasi gagal, lalu pilih **Catat gagal**.
6. Untuk retry, kirim lagi secara manual lalu catat sebagai terkirim. Affiliate yang gagal dapat dipilih lagi; percobaan bertambah dan catatan error dibersihkan saat hasil sukses dicatat.

Jangan tandai terkirim sebelum benar-benar mengirim. Aplikasi tidak memeriksa apakah pesan diterima, dan tidak mengulang otomatis.

### 5. Anggota, role, dan undangan workspace

- **Members** menampilkan anggota, role, dan undangan workspace.
- Owner/admin yang memiliki izin dapat mengundang anggota dengan email dan memilih role. Role default: Owner, Admin, Affiliate Manager, Business Development, Analyst, dan Viewer.
- Penerima menerima link undangan, membuat atau masuk ke akun, lalu menerima undangan sebelum masa berlaku habis.

**Khusus production:** layanan email belum dikonfigurasi. Di development, UI menampilkan link undangan untuk dibagikan manual. Di production saat ini endpoint belum mengirim email dan tidak memunculkan token/link; undangan tidak dapat diselesaikan oleh anggota baru sampai pengiriman email atau alur distribusi undangan production diimplementasikan. Jangan mengandalkan fitur undang anggota untuk onboarding production multi-user dulu.

### 6. Pengaturan kantor dan audit

- **Office settings:** ubah nama workspace, alamat, zona waktu, dan jam kerja. Ini baru data pengaturan; belum ada attendance atau penjadwalan.
- **Audit:** owner/admin atau role dengan `audit.read` dapat melihat aktivitas yang dicatat. Audit log bukan pengganti backup.

## Health check dan troubleshooting

- `GET /api/health` → cek koneksi database (`200` sehat, `503` tidak tersedia).
- `GET /api/health/ready` → cek koneksi database **dan** kelengkapan permission catalog (`200` siap, `503` belum siap).
- Log service: `sudo journalctl -u affiliateos -n 200 --no-pager`.
- Status service: `sudo systemctl status affiliateos`.

| Gejala | Yang diperiksa |
|---|---|
| Tidak bisa login / error database | `DATABASE_URL`, status MariaDB, grant runtime, dan `journalctl`. Jangan kirim URL/password ke chat. |
| Readiness `503` karena permission catalog | Jalankan `node packages/database/dist/src/scripts/seed-rbac.js` dengan runtime DB URL lalu cek readiness lagi. |
| Tabel tidak ditemukan | Cek `npm run prisma:status`; jalankan migration menggunakan akun migration, lalu berikan grant per-tabel untuk runtime. |
| Error `Access denied` sesudah migration | Cek host account MariaDB dan `SHOW GRANTS`; pastikan grant tabel baru benar-benar diberikan ke akun/host yang dipakai `DATABASE_URL`. |
| Undangan campaign tidak terkirim otomatis | Memang belum ada integrasi pengiriman TikTok; salin template dan kirim manual. |
| Link undangan anggota tidak tersedia di production | Email atau mekanisme distribusi undangan production belum diimplementasikan. |

## Batasan yang diketahui

- **Belum ada TikTok Shop OAuth/API integration.** Shop connection/token schema bukan berarti OAuth, refresh token, sync, atau API sudah berjalan.
- **Belum ada blast asli ke TikTok.** Campaign invitations hanya membuat teks personal dan menyimpan hasil yang dicatat operator.
- **Belum ada email service** untuk undangan workspace, reset password, atau notifikasi.
- Worker belum memproses queue bisnis. Order, produk, analytics live, auto-sync, dan retry job belum tersedia.
- Performa toko/kreator tidak otomatis berasal dari TikTok; data yang belum diintegrasikan harus dianggap manual atau belum tersedia.

## Development

Persyaratan lokal sama: Node.js 24+ dan MariaDB. Siapkan `.env` dari `.env.example`, akun database development, serta database shadow. Jangan gunakan database production untuk development/test.

```bash
cp .env.example .env
chmod 600 .env
npm ci
npm run prisma:deploy
npm run build
node packages/database/dist/src/scripts/seed-rbac.js
npm run dev
```

Buka `http://localhost:3000` atau alamat yang ditampilkan. Script dan command lain:

- `npm run dev:web` — Next.js web saja.
- `npm run dev:worker` — worker placeholder.
- `npm run validate` — validasi Prisma schema.
- `npm run prisma:status` — status migration.
- `npm run typecheck` — typecheck seluruh workspace.
- `npm test` — test package permissions/database. Web punya script terpisah: `npm run test --workspace @affiliateos/web` (DB integration test memerlukan `TEST_DATABASE_URL` yang terisolasi).

Dokumen arsitektur, keamanan, dan rencana API: [docs/01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md), [docs/04-SECURITY-PLAN.md](docs/04-SECURITY-PLAN.md), [docs/10-DATABASE-SECURITY-SEPARATION.md](docs/10-DATABASE-SECURITY-SEPARATION.md), [docs/03-TIKTOK-API-CAPABILITY-MATRIX.md](docs/03-TIKTOK-API-CAPABILITY-MATRIX.md), dan [docs/05-ROADMAP.md](docs/05-ROADMAP.md).
