# WA Bot Assistant — Pure WhatsApp Gateway + Hermes AI

WhatsApp Gateway yang menghubungkan chat WhatsApp dengan **Hermes Agent AI** (via OpenRouter), dilengkapi in-memory rate limiting & deduplication, sequential message queue, dan HTTP endpoint untuk push outbound dari Hermes.

---

## 🏗️ Arsitektur Sistem & Aliran Data

```
                       ┌────────────────────────┐
                       │   WhatsApp Client      │
                       │ (whatsapp-web.js Auth) │
                       └───────────┬────────────┘
                                   │ scan QR via Terminal / Portainer Logs
                    ┌──────────────┴──────────────┐
                    │                             │
          INBOUND (WA → Bot)             OUTBOUND (Hermes → WA)
                    │                             │
                    ▼                             ▼
        ┌───────────────────────┐     ┌───────────────────────┐
        │   Message Listener    │     │    Express Server     │
        │   (client.on msg)     │     │  (POST /send, /health)│
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
        │   In-Memory Guards    │                 │
        │ (Rate Limit + Dedup)  │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   Role Resolver       │                 │
        │ (.env OWNER_NUMBER)   │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │   In-Memory Queue     │                 │
        │ (Sequential per Chat) │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             │
        ┌───────────────────────┐                 │
        │    Hermes Adapter     │                 │
        │ (POST to Hermes API   │                 │
        │ + System Instruction) │                 │
        └───────────┬───────────┘                 │
                    │                             │
                    ▼                             ▼
          ┌───────────────────┐         ┌───────────────────┐
          │ Reply / Quoted    │         │ Send WA Message   │
          │ (sendReply)       │         │ (client.sendMsg)  │
          └───────────────────┘         └───────────────────┘
```

---

## 🔑 Manajemen Peran (RBAC)

| Role | Akses |
|------|-------|
| **owner** | Akses penuh: semua tools, web search, image gen, akses filesystem/server |
| **member** | Hanya chat umum, web search, image gen; dilarang akses filesystem/server |

* **Direct Message (DM)**: Hanya nomor yang terdaftar di `OWNER_NUMBER` yang akan dilayani oleh bot.
* **Group**: Jika pengirim terdaftar di `OWNER_NUMBER` maka otomatis mendapat role `[OWNER]`, sedangkan anggota grup lainnya otomatis mendapat role `[MEMBER]`.

---

## 🛠️ Fitur Utama

1. **Pure & Lightweight Gateway** — 100% Zero-infrastructure dependencies (tanpa PostgreSQL maupun Redis), startup instan, dan hemat RAM.
2. **Anti-Ban Human Behavior** — delay manusiawi, auto-typing indicator, split pesan otomatis.
3. **Sequential Message Queue** — antrian in-memory per `chat_id` agar tidak terjadi race condition.
4. **In-Memory Rate Limiter & Dedup** — proteksi spam (rate limit) + deduplikasi pesan duplikat super-cepat.
5. **Outbound Push Endpoint (`POST /send`)** — memungkinkan Hermes AI mengirim pesan WA secara proaktif / terjadwal.
6. **Docker & Portainer Ready** — multi-container `hermes-agent` + `wa-gateway` siap deploy ke VPS/Portainer.
7. **CI/CD GitHub Actions** — pipeline otomatis build & deploy ke VPS saat push ke branch `production`.

---

## 📁 Struktur Folder

```
waBotAssistant/
├── src/
│   ├── config/
│   │   └── env.ts             # Loader & validasi environment variables (.env)
│   ├── hermes/
│   │   ├── adapter.ts         # HTTP adapter ke Hermes API
│   │   └── types.ts           # HermesPayload type definitions
│   ├── lib/
│   │   └── rateLimiter.ts     # In-memory rate limit & dedup logic
│   ├── queue/
│   │   └── messageQueue.ts    # Sequential in-memory queue per chat ID
│   ├── server/
│   │   └── pushEndpoint.ts    # Express app: /send (Hermes outbound), /health
│   ├── wa/
│   │   ├── client.ts          # Init whatsapp-web.js + QR/auth event handlers
│   │   ├── filters.ts         # Filter DM & group message logic
│   │   └── reply.ts           # sendReply + startTypingLoop
│   └── index.ts               # Entry point: WA listener + HTTP server
├── .env.example               # Template environment variables
├── config.yaml                # Konfigurasi Hermes Agent AI (tools, model, system prompt)
├── docker-compose.yml         # Multi-container: hermes-agent + wa-gateway
├── Dockerfile                 # Image build (Puppeteer + Chromium compatible)
├── entrypoint.sh              # Docker startup script
└── .github/workflows/         # CI/CD GitHub Actions (build + push + SSH deploy)
```

---

## 🚀 Cara Setup & Konfigurasi

### 1. Konfigurasi Environment Variables

```bash
cp .env.example .env
```

Sesuaikan nilai di `.env`:

| Variabel | Keterangan |
|----------|-----------|
| `HERMES_API_URL` | URL internal Hermes Agent (default: `http://wabot-hermes:8642/v1/responses`) |
| `HERMES_API_KEY` | API Key untuk autentikasi ke Hermes Agent |
| `HERMES_SECRET` | Secret untuk validasi webhook outbound dari Hermes |
| `EXPRESS_PORT` | Port Express server (default: `4849`) |
| `OWNER_NUMBER` | Nomor WhatsApp Owner (contoh: `628123456789`, pisahkan koma untuk multiple) |
| `ALLOWED_GROUPS` | ID grup WhatsApp yang diizinkan (opsional, kosongkan/isi `*` untuk semua grup) |

---

### 📦 Menjalankan via Docker Compose (Production / VPS)

```bash
# 1. Jalankan stack
docker compose up -d

# 2. Pantau log & scan QR Code WhatsApp
docker compose logs -f wa-gateway
```

Scan QR Code yang muncul di terminal menggunakan aplikasi WhatsApp di HP Anda.

---

### 🌐 Pengelolaan via Portainer

Jika mengelola via **Portainer**:
1. **Deploy Stack**: Buka menu **Stacks** $\rightarrow$ Tambahkan stack baru $\rightarrow$ Masukkan isi `docker-compose.yml` dan konfigurasi environment variables di bagian bawah editor.
2. **Scan QR Code**: Buka menu **Containers** $\rightarrow$ Klik ikon **Logs** pada container `wabot-gateway` untuk melihat QR Code saat pertama kali login.
3. **Edit Nomor Owner / Grup**:
   * Buka **Stacks** $\rightarrow$ Pilih stack $\rightarrow$ Tab **Editor** $\rightarrow$ Ubah variabel `OWNER_NUMBER` atau `ALLOWED_GROUPS` $\rightarrow$ Klik **"Update the stack"**.
   * Container akan otomatis me-restart dalam hitungan detik dengan konfigurasi terbaru.

---

### 💻 Menjalankan secara Lokal (Development)

```bash
# 1. Install dependensi
bun install

# 2. Jalankan development server (hot-reload)
bun run dev

# 3. Build & Run Production
bun run build
bun start
```

---

## 🔄 CI/CD (GitHub Actions)

Pipeline otomatis berjalan saat push ke branch `production` via `.github/workflows/deploy.yml`.

### Secrets di GitHub Repository
* `DOCKERHUB_USERNAME`
* `DOCKERHUB_TOKEN`
* `SSH_HOST`
* `SSH_USERNAME`
* `SSH_KEY`
* `SSH_PORT`

---

## 🔗 Terkait
- **Hermes Agent config:** lihat `config.yaml` untuk konfigurasi tools, model LLM, dan system prompt.