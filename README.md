# WA Bot Assistant (Hermes + WA Gateway + Admin Panel)

Aplikasi WhatsApp Bot Assistant yang terintegrasi dengan **Hermes Agent AI** (menggunakan Responses API), database **PostgreSQL via Prisma**, dan dilengkapi dengan **Next.js Web Admin Panel** untuk manajemen user, monitoring log, dan status koneksi WhatsApp.

---

## 🏗️ Arsitektur Sistem & Aliran Data (Flow)

```
                       ┌────────────────────────┐
                       │   WhatsApp Client      │
                       │ (whatsapp-web.js Auth) │
                       └───────────┬────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
          INBOUND (WA → Bot)             OUTBOUND (Hermes → WA)
                    │                             │
                    ▼                             ▼
        ┌───────────────────────┐     ┌───────────────────────┐
        │   Message Listener    │     │    Express Server     │
        │   (client.on msg)     │     │  (POST /send endpoint)│
        └───────────┬───────────┘     └───────────┬───────────┘
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │     Filter Layer      │                 │
        │ (DM/tag/bot-loop/#aii)│                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │     Role Resolver     │                 │
        │ (Prisma DB Lookup)    │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   In-Memory Queue     │                 │
        │ (Sequential processing│                 │
        │     per Chat ID)      │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             ▼
        ┌───────────────────────┐     ┌───────────────────────┐
        │    Hermes Adapter     │     │      Admin Panel      │
        │ (POST to Hermes API   │◄────┤     (Next.js 16)      │
        │ + System Instruction) │     │ (SSE Status & REST API)│
        └───────────┬───────────┘     └───────────────────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ Kirim Balasan /   │
          │  Quoted Message   │
          └───────────────────┘
```

---

## 🔑 Manajemen Peran & Hak Akses (RBAC)

| Role | Akses |
|------|-------|
| **owner** | Akses penuh ke semua perintah, tools, konfigurasi bot |
| **member** | Hanya chat umum, web search, image gen; dilarang akses server/filesystem |

---

## 🛠️ Fitur Utama

1. **Anti-Ban Human Behavior** — delay manusiawi, auto-typing, dan split pesan otomatis.
2. **Sequential Message Queue** — antrian per `chat_id` untuk menghindari race condition.
3. **Database-Driven Users** — otorisasi user dinamis via Admin Panel tanpa restart.
4. **SSE Real-time Broadcast** — status QR dan koneksi WA streaming ke Admin Panel.
5. **Nginx & Docker Ready** — Docker Compose multiservice + Nginx reverse proxy.
6. **Automatic Log Pruner** — hapus log > 30 hari otomatis setiap 24 jam.
7. **Forgot Password via OTP WhatsApp** — reset password Admin Panel lewat OTP yang dikirim ke nomor WhatsApp owner.

---

## 📁 Struktur Folder Proyek

```
waBotAssistant/
├── prisma/
│   ├── schema.prisma         # Definisi skema database PostgreSQL
│   ├── seed.js               # Script seeding akun admin & WhatsApp owner awal
│   └── migrations/           # Riwayat migrasi database
├── src/
│   ├── config/
│   │   └── env.ts            # Loader & validasi environment variables
│   ├── hermes/               # Adapter Hermes API & type definitions
│   ├── lib/
│   │   └── prisma.ts         # Singleton PrismaClient
│   ├── queue/                # Sequential message queue per chat ID
│   ├── server/
│   │   ├── adminAuth.ts      # JWT Authentication Middleware
│   │   ├── adminRouter.ts    # REST Admin API (Users, Logs, Status, Auth OTP)
│   │   └── pushEndpoint.ts   # Express server & endpoint /send
│   └── index.ts              # Entry point utama aplikasi
├── .env.example              # Template environment variables
├── docker-compose.yml        # Konfigurasi multi-container Docker
├── Dockerfile                # Instruksi build container (Puppeteer-friendly)
└── entrypoint.sh             # Script startup Docker (migrate + seed + run)
```

---

## 🚀 Cara Setup & Instalasi

### Langkah 1 — Konfigurasi `seed.js` (WAJIB sebelum pertama kali jalan)

> [!IMPORTANT]
> Ini adalah langkah paling penting. Buka berkas `prisma/seed.js` dan isi kredensial Anda:

```js
// prisma/seed.js
const defaultUsername = 'admin';           // Username untuk login ke Admin Panel
const defaultPassword = 'admin123';        // Password awal Admin Panel (ganti segera setelah login!)
const ownerWhatsAppNumber = '628xxxxxxxxxx'; // Nomor WA Anda (internasional, tanpa +)
                                             // Nomor ini akan menerima OTP reset password
                                             // dan didaftarkan sebagai owner bot pertama
```

> [!TIP]
> Jika `ownerWhatsAppNumber` Anda berformat `628xx...`, nomor tersebut otomatis dikonversi ke format JID `628xx...@c.us` dan didaftarkan sebagai user **owner** pertama di database.

---

### Langkah 2 — Konfigurasi Environment Variables

Salin berkas `.env.example` menjadi `.env` dan sesuaikan nilainya:

```bash
cp .env.example .env
```

Variabel yang wajib diisi:

```env
# ── PostgreSQL ────────────────────────────────────────────────────────────────
POSTGRES_USER=admin
POSTGRES_PASSWORD=ganti_dengan_password_kuat
POSTGRES_DB=wagateway
DATABASE_URL=postgresql://admin:ganti_dengan_password_kuat@postgres-db:5432/wagateway?schema=public

# ── Hermes Agent ──────────────────────────────────────────────────────────────
HERMES_API_URL=http://hermes-agent:8689/v1/responses
HERMES_API_KEY=isi_dengan_api_key_hermes_anda
HERMES_SECRET=isi_dengan_secret_random_panjang

# ── Express Server ────────────────────────────────────────────────────────────
EXPRESS_PORT=4849

# ── JWT Secret (Admin Panel Auth) ─────────────────────────────────────────────
# Generate dengan: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=isi_dengan_jwt_secret_panjang_dan_random

# ── CORS ──────────────────────────────────────────────────────────────────────
ALLOWED_ORIGIN=https://admin.domain-kamu.com
```

> [!WARNING]
> Jangan pernah commit berkas `.env` ke Git. Berkas ini sudah tercantum di `.gitignore`.

---

### 📦 Metode A: Docker Compose (Direkomendasikan untuk Production)

#### 1. Jalankan seluruh container

```bash
docker compose up -d --build
```

> Saat pertama kali dijalankan, `entrypoint.sh` otomatis menjalankan:
> 1. `prisma migrate deploy` — menerapkan schema database terbaru
> 2. `prisma db seed` — membuat akun admin & owner WhatsApp sesuai konfigurasi `seed.js`
> 3. Menjalankan aplikasi gateway

#### 2. Pantau log startup

```bash
docker compose logs -f wa-gateway
```

Pastikan muncul pesan seperti:
```
✅ Admin user created/updated: admin
✅ WhatsApp owner created/updated: 628xxxxxxxxxx@c.us
[Server] HTTP running on port 4849
```

#### 3. Scan QR Code WhatsApp

Buka Admin Panel di browser, masuk ke halaman **Dashboard**, dan scan QR code yang muncul menggunakan aplikasi WhatsApp Anda.

---

### 💻 Metode B: Lokal/Manual (Development)

#### 1. Install dependensi

```bash
pnpm install
# atau: npm install
```

#### 2. Setup database

Pastikan PostgreSQL lokal berjalan, lalu sesuaikan `DATABASE_URL` di `.env` ke `localhost`.

```bash
# Jalankan migrasi
npx prisma migrate deploy

# Jalankan seeding (buat admin & owner awal)
pnpm run db:seed
```

#### 3. Jalankan aplikasi

```bash
# Mode development
pnpm run dev

# Atau build production
pnpm run build && pnpm start
```

---

## 🔄 Mengganti Password Admin Panel

Ada dua cara mengganti password admin setelah instalasi:

### A. Lewat Fitur "Lupa Password?" di Login Page
1. Buka halaman login Admin Panel.
2. Klik **Lupa Password?**.
3. Masukkan username admin Anda.
4. Kode OTP 6 digit akan dikirim ke nomor WhatsApp owner yang terdaftar.
5. Masukkan OTP + password baru, klik **Reset Password**.

> OTP berlaku selama **5 menit** dan hangus setelah **5 percobaan salah**.

### B. Lewat Seed Ulang
Edit `defaultPassword` di `prisma/seed.js`, lalu jalankan:
```bash
pnpm run db:seed
# Atau di Docker:
docker compose exec wa-gateway node prisma/seed.js
```

---

## 🔄 Setup CI/CD (GitHub Actions)

Pipeline otomatis berjalan saat push ke branch `production` melalui `.github/workflows/deploy.yml`.

### Konfigurasi Secrets di GitHub

Buka **Settings → Secrets and variables → Actions** di repositori GitHub, tambahkan:

| Secret | Keterangan |
|--------|-----------|
| `DOCKERHUB_USERNAME` | Username Docker Hub Anda |
| `DOCKERHUB_TOKEN` | Personal Access Token Docker Hub |
| `SSH_HOST` | IP Publik/Domain VPS |
| `SSH_USERNAME` | Username SSH server |
| `SSH_KEY` | Isi berkas `id_rsa` (Private Key SSH) |
| `SSH_PORT` | Port SSH (default: `22`) |

Sesuaikan path direktori proyek di VPS pada berkas `.github/workflows/deploy.yml`:
```yaml
script: |
  cd /path/to/your/project-on-server
  docker compose pull && docker compose up -d
```

Lalu push ke branch `production` untuk memulai deployment:
```bash
git push origin production
```