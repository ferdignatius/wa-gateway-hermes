# WA Bot Assistant — WA Gateway + Hermes AI

WhatsApp Bot yang terintegrasi dengan **Hermes Agent AI** (via OpenRouter), database **PostgreSQL**, caching & dedup via **Redis**, dan dilengkapi **REST + SSE API** untuk Admin Panel berbasis Next.js.

---

## 🏗️ Arsitektur Sistem & Aliran Data

```
                       ┌────────────────────────┐
                       │   WhatsApp Client      │
                       │ (whatsapp-web.js Auth) │
                       └───────────┬────────────┘
                                   │ scan QR
                    ┌──────────────┴──────────────┐
                    │                             │
          INBOUND (WA → Bot)             OUTBOUND (Hermes → WA)
                    │                             │
                    ▼                             ▼
        ┌───────────────────────┐     ┌───────────────────────┐
        │   Message Listener    │     │    Express Server     │
        │   (client.on msg)     │     │  (REST API + SSE)     │
        └───────────┬───────────┘     └───────────┬───────────┘
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │     Filter Layer      │                 │
        │ (DM/group/tag/dedup)  │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   Redis Guards        │                 │
        │ (Rate Limit + Dedup)  │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   Role Resolver       │                 │
        │ (Prisma DB Lookup)    │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   In-Memory Queue     │                 │
        │ (Sequential per Chat) │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             ▼
        ┌───────────────────────┐     ┌───────────────────────┐
        │    Hermes Adapter     │     │      Admin Panel      │
        │ (POST to Hermes API   │◄────┤     (Next.js 16)      │
        │ + System Instruction) │     │  (SSE Status + CRUD)  │
        └───────────┬───────────┘     └───────────────────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ Reply / Quoted    │
          │ (sendReply)       │
          └───────────────────┘
```

---

## 🔑 Manajemen Peran (RBAC)

| Role | Akses |
|------|-------|
| **owner** | Akses penuh: semua tools, web search, image gen, akses filesystem/server |
| **member** | Hanya chat umum, web search, image gen; dilarang akses filesystem/server |

DM hanya bisa diproses oleh user dengan role **owner**. Pesan grup diproses untuk semua user (owner/member) di grup yang terdaftar di database.

---

## 🛠️ Fitur Utama

1. **Anti-Ban Human Behavior** — delay manusiawi, auto-typing indicator, split pesan otomatis.
2. **Sequential Message Queue** — antrian in-memory per `chat_id` agar tidak ada race condition.
3. **Redis Rate Limiter & Dedup** — batas kecepatan pesan per user + deduplikasi pesan duplikat.
4. **Database-Driven Authorization** — user, grup, dan admin dikelola via Admin Panel tanpa restart.
5. **SSE Real-time Status** — QR code dan status koneksi WA di-*stream* langsung ke Admin Panel.
6. **Forgot Password via OTP WhatsApp** — reset password Admin Panel lewat OTP yang dikirim ke nomor WhatsApp owner.
7. **Automatic Log Pruner** — menghapus log aktivitas yang lebih dari 30 hari secara otomatis setiap 24 jam.
8. **Docker Ready (Multi-Stack)** — berjalan sebagai bagian dari stack apps, terhubung ke external `proxy-tier` dan `data-tier` networks.
9. **CI/CD GitHub Actions** — pipeline otomatis build & deploy ke VPS saat push ke branch `production`.

---

## 📁 Struktur Folder

```
waBotAssistant/
├── prisma/
│   ├── schema.prisma          # Skema database PostgreSQL (User, AdminUser, AllowedGroup, ActivityLog)
│   ├── prisma.config.ts       # Konfigurasi Prisma v7 (env loader)
│   ├── seed.js                # Seeding akun admin & WhatsApp owner pertama
│   └── migrations/            # Riwayat migrasi database
├── src/
│   ├── config/
│   │   └── env.ts             # Loader & validasi environment variables
│   ├── hermes/
│   │   ├── adapter.ts         # HTTP adapter ke Hermes API
│   │   └── types.ts           # HermesPayload type definitions
│   ├── lib/
│   │   ├── prisma.ts          # Singleton PrismaClient
│   │   ├── redis.ts           # Singleton ioredis client
│   │   └── rateLimiter.ts     # Rate limit & dedup logic (Redis-backed)
│   ├── queue/
│   │   └── messageQueue.ts    # Sequential in-memory queue per chat ID
│   ├── server/
│   │   ├── adminAuth.ts       # JWT middleware untuk Admin API
│   │   ├── adminRouter.ts     # REST Admin API (Users, Groups, Logs, Auth, OTP)
│   │   └── pushEndpoint.ts    # Express app: /send, /health, SSE /stream
│   ├── wa/
│   │   ├── client.ts          # Init whatsapp-web.js + QR/auth event handlers
│   │   ├── filters.ts         # Filter DM & group message logic
│   │   └── reply.ts           # sendReply + startTypingLoop
│   └── index.ts               # Entry point: WA listener + HTTP server + log pruner
├── .env.example               # Template environment variables
├── config.yaml                # Konfigurasi Hermes Agent AI (tools, model, system prompt)
├── docker-compose.yml         # Multi-container: hermes-agent + wa-gateway
├── Dockerfile                 # Image build (Puppeteer + Chromium compatible)
├── entrypoint.sh              # Docker startup: migrate → seed → run
└── .github/workflows/         # CI/CD GitHub Actions (build + push + SSH deploy)
```

---

## 🗄️ Skema Database

| Model | Deskripsi |
|-------|-----------|
| `User` | WhatsApp user (owner/member) yang diotorisasi |
| `AdminUser` | Akun login Admin Panel + field OTP reset password |
| `AllowedGroup` | Grup WhatsApp yang diizinkan berinteraksi dengan bot |
| `ActivityLog` | Log seluruh percakapan bot (message, reply, status, error) |

---

## 🚀 Cara Setup & Instalasi

### Langkah 1 — Konfigurasi `seed.js` (**WAJIB** sebelum pertama kali jalan)

> [!IMPORTANT]
> Buka berkas `prisma/seed.js` dan isi kredensial Anda sebelum menjalankan apapun:

```js
const defaultUsername = 'admin';           // Username login Admin Panel
const defaultPassword = 'admin123';        // Password awal — ganti segera setelah login!
const ownerWhatsAppNumber = '628xxxxxxxxxx'; // Nomor WA owner (format internasional, tanpa +)
```

> [!TIP]
> Nomor `628xx...` akan otomatis dikonversi ke format JID `628xx...@c.us` dan didaftarkan sebagai user **owner** pertama di database. Nomor ini juga yang menerima OTP reset password.

---

### Langkah 2 — Konfigurasi Environment Variables

```bash
cp .env.example .env
```

| Variabel | Keterangan |
|----------|-----------|
| `CORE_DB_USER` | Username PostgreSQL (dari STACK 4 CORE) |
| `CORE_DB_PASSWORD` | Password PostgreSQL |
| `REDIS_URL` | URL Redis (default: `redis://redis-queue:6379`) |
| `HERMES_API_URL` | URL internal Hermes Agent (default: `http://wabot-hermes:8689/v1/responses`) |
| `HERMES_API_KEY` | API Key untuk Hermes Agent |
| `HERMES_SECRET` | Secret untuk validasi webhook dari Hermes |
| `OPENROUTER_API_KEY` | API Key OpenRouter (untuk LLM di Hermes) |
| `EXPRESS_PORT` | Port Express server (default: `4849`) |
| `JWT_SECRET` | Secret untuk JWT Admin Panel (generate dengan `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`) |
| `ALLOWED_ORIGIN` | URL Admin Panel yang diizinkan CORS (contoh: `https://your-admin-panel.vercel.app`) |

> [!WARNING]
> Jangan pernah commit `.env` ke Git. Berkas ini sudah ada di `.gitignore`.

---

### 📦 Metode A: Docker Compose (Production — Multi-Stack)

> [!IMPORTANT]
> Stack ini (`STACK 3 - APPS`) mengasumsikan `postgres-master` dan `redis-queue` sudah berjalan di **STACK 4 (CORE)**, serta external networks `proxy-tier` dan `data-tier` sudah dibuat.

#### 1. Build & push image ke registry

```bash
docker build -t ferdignatius/wa-gateway:latest .
docker push ferdignatius/wa-gateway:latest
```

#### 2. Jalankan stack

```bash
docker compose up -d
```

Saat pertama dijalankan, `entrypoint.sh` otomatis menjalankan:
1. `prisma migrate deploy` — menerapkan schema database
2. `prisma db seed` — membuat akun admin & user owner
3. Menjalankan aplikasi gateway

#### 3. Pantau log startup

```bash
docker compose logs -f wa-gateway
```

Pastikan muncul:
```
✅ Admin user created/updated: admin
✅ WhatsApp owner created/updated: 628xxxxxxxxxx@c.us
[Server] HTTP running on port 4849 (with SSE support)
[WA] QR Code generated — waiting for scan...
```

#### 4. Scan QR Code WhatsApp

Buka Admin Panel, masuk ke halaman **Dashboard**, dan scan QR code yang muncul.

---

### 💻 Metode B: Lokal/Manual (Development)

#### 1. Install dependensi

```bash
pnpm install
```

#### 2. Setup database lokal

Pastikan PostgreSQL & Redis lokal berjalan, lalu sesuaikan URL di `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/wagateway?schema=public
REDIS_URL=redis://localhost:6379
```

Jalankan migrasi & seeding:

```bash
pnpm run db:migrate
pnpm run db:seed
```

#### 3. Jalankan aplikasi

```bash
# Development (hot reload)
pnpm run dev

# Production
pnpm run build && pnpm start
```

#### 4. Prisma Studio (opsional)

```bash
pnpm run db:studio
```

---

## 🔄 Reset Password Admin Panel

### A. Lewat Fitur "Lupa Password?" (tanpa akses server)

1. Buka halaman login Admin Panel.
2. Klik **Lupa Password?**.
3. Masukkan username admin → klik **Kirim OTP ke WhatsApp**.
4. Kode OTP 6 digit dikirim ke nomor WhatsApp owner.
5. Masukkan OTP + password baru → klik **Reset Password**.

> OTP berlaku **5 menit** dan hangus setelah **5 percobaan salah**.

### B. Lewat Seed Ulang

Edit `defaultPassword` di `prisma/seed.js`, lalu:

```bash
pnpm run db:seed
# Atau di Docker:
docker compose exec wa-gateway node prisma/seed.js
```

---

## 🔄 CI/CD (GitHub Actions)

Pipeline otomatis berjalan saat push ke branch `production` via `.github/workflows/deploy.yml`.

### Secrets yang wajib diisi di GitHub

| Secret | Keterangan |
|--------|-----------|
| `DOCKERHUB_USERNAME` | Username Docker Hub |
| `DOCKERHUB_TOKEN` | Personal Access Token Docker Hub |
| `SSH_HOST` | IP/Domain VPS |
| `SSH_USERNAME` | Username SSH server |
| `SSH_KEY` | Isi file `id_rsa` (private key SSH) |
| `SSH_PORT` | Port SSH (default: `22`) |

Sesuaikan path direktori di `.github/workflows/deploy.yml`, lalu:

```bash
git push origin production
```

---

## 🔗 Terkait

- **Admin Panel (Frontend):** lihat folder `wa-admin-panel/`
- **Hermes Agent config:** lihat `config.yaml` untuk konfigurasi tools, model LLM, dan system prompt