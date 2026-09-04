# 🤖 WA Bot Assistant — Pure WhatsApp Gateway + Hermes AI

WhatsApp Gateway berkinerja tinggi yang menghubungkan **WhatsApp** secara langsung dengan **Hermes AI Agent** (via OpenRouter / NousResearch API). Dirancang dengan arsitektur **Zero-Infrastructure Dependency** (100% in-memory tanpa Redis/PostgreSQL), multi-tier role guard (RBAC), sequential message queue, anti-ban protections, serta REST API untuk outbound push message.

---

## 📑 Daftar Isi

- [Arsitektur & Aliran Data](#-arsitektur--aliran-data)
- [Fitur Utama](#-fitur-utama)
- [Manajemen Akses & Peran (RBAC)](#-manajemen-akses--peran-rbac)
- [Struktur Direktori](#-struktur-direktori)
- [Spesifikasi API Endpoint](#-spesifikasi-api-endpoint)
- [Variabel Environment (.env)](#-variabel-environment-env)
- [Panduan Instalasi & Menjalankan](#-panduan-instalasi--menjalankan)
  - [1. Mode Development (Lokal)](#1-mode-development-lokal)
  - [2. Mode Production (Docker Compose)](#2-mode-production-docker-compose)
  - [3. Deployment via Portainer](#3-deployment-via-portainer)
- [CI/CD & Deployment Otomatis](#-cicd--deployment-otomatis)
- [Troubleshooting & FAQ](#-troubleshooting--faq)

---

## 🏗️ Arsitektur & Aliran Data

```
                         ┌────────────────────────┐
                         │    WhatsApp Client     │
                         │ (whatsapp-web.js Auth) │
                         └───────────┬────────────┘
                                     │ Scan QR (Terminal / Portainer Logs)
                     ┌───────────────┴───────────────┐
                     │                               │
           INBOUND (WA → Bot)              OUTBOUND (Hermes → WA)
                     │                               │
                     ▼                               ▼
         ┌───────────────────────┐       ┌───────────────────────┐
         │   Message Listener    │       │     Express Server    │
         │   (client.on msg)     │       │   (POST /send, /health)
         └───────────┬───────────┘       └───────────┬───────────┘
                     │                               │
                     ▼                               │
         ┌───────────────────────┐                   │
         │     Filter Layer      │                   │
         │  (DM / Group / Tag)   │                   │
         └───────────┬───────────┘                   │
                     │                               │
                     ▼                               │
         ┌───────────────────────┐                   │
         │   In-Memory Guards    │                   │
         │ (Rate Limit + Dedup)  │                   │
         └───────────┬───────────┘                   │
                     │                               │
                     ▼                               │
         ┌───────────────────────┐                   │
         │   Role Resolver       │                   │
         │ (Owner / Member RBAC) │                   │
         └───────────┬───────────┘                   │
                     │                               │
                     ▼                               │
         ┌───────────────────────┐                   │
         │   In-Memory Queue     │                   │
         │ (Sequential per Chat) │                   │
         └───────────┬───────────┘                   │
                     │                               │
                     ▼                               │
         ┌───────────────────────┐                   │
         │    Hermes Adapter     │                   │
         │ (HTTP POST to Hermes  │                   │
         │ + Quoted Context)     │                   │
         └───────────┬───────────┘                   │
                     │                               │
                     ▼                               ▼
           ┌───────────────────┐           ┌───────────────────┐
           │ Reply / Quoted WA │           │ Send Push Message │
           │ (sendReply)       │           │ (client.sendMsg)  │
           └───────────────────┘           └───────────────────┘
```

---

## ✨ Fitur Utama

- ⚡ **Pure & Lightweight Gateway**: 100% In-memory state (Zero DB/Redis). Konsumsi resource minimal (~150MB RAM runtime) dengan startup instan.
- 👥 **Tag-Gated Group Response**: Bot hanya merespons di grup saat di-tag/mention (`@bot`) atau me-reply pesan bot oleh member yang diizinkan.
- 🛡️ **Role-Based Access Control (RBAC)**: Memisahkan privilege `owner` (akses penuh toolset/terminal/filesystem) dan `member` (hanya chat umum, web search, image generation).
- 💬 **Quoted Message Context Injection**: Secara otomatis menyertakan konteks pesan yang dikutip saat pengguna me-reply pesan lama.
- ⏳ **Sequential Message Queue**: Mengantre pesan per `chat_id` untuk mencegah race condition respon AI.
- 🚦 **In-Memory Rate Limiting & Deduplication**: Proteksi anti-spam pesan beruntun dan pencegahan eksekusi pesan duplikat (dedup window 1 menit).
- ⌨️ **Anti-Ban Human Behavior**: Simulasi human typing indicator saat AI sedang memproses jawaban, pemecahan pesan panjang secara otomatis (maksimal 4000 karakter per bagian), dan desktop user-agent spoofing.
- 🚀 **Hermes Outbound Push (`POST /send`)**: Endpoint aman dengan autentikasi `x-hermes-secret` agar Hermes AI dapat mengirim notifikasi terjadwal / proaktif ke WhatsApp.
- 🐳 **Production Docker Multi-Stage**: Menggunakan Bun untuk kompilasi cepat dan Node.js 22 Slim dengan Chromium terintegrasi + `dumb-init` untuk mencegah zombie process.

---

## 🔑 Manajemen Akses & Peran (RBAC)

| Peran | Privilese | Berlaku di |
|---|---|---|
| **`owner`** | Akses penuh: Chat, Web search, Image generation, Akses Filesystem, Eksekusi Perintah Terminal | DM & Grup yang diizinkan |
| **`member`** | Terbatas: Chat umum, Web search, Image generation *(Dilarang akses filesystem & terminal)* | Hanya Grup yang diizinkan |

### Aturan Filtering:
1. **Direct Message (DM)**:
   - Hanya nomor yang terdaftar pada `OWNER_NUMBER` yang akan diproses oleh bot.
   - Pesan dari nomor lain akan diabaikan secara otomatis.
2. **Grup (Group Chat)**:
   - Grup harus terdaftar pada `ALLOWED_GROUPS` (atau gunakan `*` untuk mengizinkan semua grup).
   - Pengirim harus terdaftar pada `OWNER_NUMBER` (Role: `owner`) atau `ALLOWED_USERS` (Role: `member`).
   - Bot hanya akan merespons jika nomor bot **di-mention / di-tag (`@bot`)** atau jika pesan **me-reply pesan bot**.

---

## 📁 Struktur Direktori

```
waBotAssistant/
├── src/
│   ├── auth/                  # (Opsional) Custom authentication hooks
│   ├── config/
│   │   └── env.ts             # Parser & validator konfigurasi environment (.env)
│   ├── hermes/
│   │   ├── adapter.ts         # HTTP client & payload formatter ke Hermes AI
│   │   └── types.ts           # Type definitions payload Hermes
│   ├── lib/
│   │   └── rateLimiter.ts     # In-memory rate limiter & deduplication engine
│   ├── queue/
│   │   └── messageQueue.ts    # Sequential in-memory queue per chat_id
│   ├── server/
│   │   └── pushEndpoint.ts    # Express server: /health & /send (outbound push)
│   ├── wa/
│   │   ├── client.ts          # Inisialisasi WhatsApp Web client + Puppeteer
│   │   ├── filters.ts         # Filter pesan DM & Group (tag/mention validation)
│   │   └── reply.ts           # Typing indicator loop & message chunking
│   └── index.ts               # Entrypoint utama bot
├── .env.example               # Template environment variables
├── .dockerignore              # File ignore build Docker
├── config.yaml                # Konfigurasi Hermes AI Agent (model, tools, system prompt)
├── docker-compose.yml         # Konfigurasi container hermes-agent + wa-gateway
├── Dockerfile                 # Multi-stage Dockerfile (Bun builder + Node.js 22 runtime)
├── entrypoint.sh              # Entrypoint script dengan dumb-init
├── package.json               # Manifest dependensi & scripts
├── tsconfig.json              # Konfigurasi TypeScript
└── .github/workflows/
    └── deploy.yml             # Pipeline CI/CD GitHub Actions
```

---

## 🔌 Spesifikasi API Endpoint

Bot mengekspos Express server pada port `4849` (dapat diubah via `EXPRESS_PORT`).

### 1. Health Check
Mengecek status ketersediaan gateway.

- **URL**: `GET /health`
- **Response**: `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2026-09-04T06:15:00.000Z"
}
```

### 2. Push Outbound Message
Digunakan oleh Hermes Agent atau sistem eksternal untuk mengirim pesan ke nomor/grup WhatsApp.

- **URL**: `POST /send`
- **Headers**:
  - `Content-Type: application/json`
  - `x-hermes-secret: <HERMES_SECRET_VALUE>`
- **Request Body**:
```json
{
  "chat_id": "628123456789@c.us",
  "message": "Halo! Ini adalah notifikasi otomatis dari Hermes AI."
}
```
> **Catatan format ID**:
> - Nomor pribadi: `628123456789@c.us`
> - Grup: `12036304xxxxxxxxxx@g.us`

- **Response**:
  - `200 OK`: `{"success": true}`
  - `401 Unauthorized`: `{"success": false, "error": "Unauthorized"}`
  - `400 Bad Request`: `{"success": false, "error": "Missing chat_id or message"}`
  - `500 Internal Error`: `{"success": false, "error": "<pesan error>"}`

---

## ⚙️ Variabel Environment (.env)

Salin `.env.example` ke `.env` dan sesuaikan nilainya:

```bash
cp .env.example .env
```

| Variabel | Tipe | Default | Keterangan |
|---|---|---|---|
| `HERMES_API_URL` | String | `http://wabot-hermes:8642/v1/responses` | URL endpoint Hermes Agent |
| `HERMES_API_KEY` | String | *Wajib* | API Key untuk request ke Hermes Agent |
| `HERMES_SECRET` | String | *Wajib* | Secret token untuk otorisasi `POST /send` |
| `EXPRESS_PORT` | Number | `4849` | Port server Express |
| `OWNER_NUMBER` | String | *Wajib* | Nomor WhatsApp pemilik (contoh: `628123456789,628987654321`) |
| `ALLOWED_USERS` | String | `""` | Daftar nomor member yang diizinkan tag bot di grup (pisahkan koma) |
| `ALLOWED_GROUPS` | String | `""` | ID grup yang diizinkan (pisahkan koma, atau isi `*` untuk semua) |
| `PUPPETEER_EXECUTABLE_PATH` | String | `/usr/bin/chromium` | Path binary Chromium (otomatis di Docker) |

---

## 🚀 Panduan Instalasi & Menjalankan

### 1. Mode Development (Lokal)

Pastikan [Bun](https://bun.sh) atau [Node.js v20+](https://nodejs.org) sudah terpasang.

```bash
# 1. Masuk ke direktori projek
cd waBotAssistant

# 2. Install dependensi
bun install
# atau: npm install

# 3. Jalankan development server dengan auto-reload
bun run dev
# atau: npm run dev
```

QR Code akan muncul di terminal. Scan menggunakan aplikasi WhatsApp di HP Anda.

---

### 2. Mode Production (Docker Compose)

Pastikan Docker & Docker Compose sudah terpasang.

```bash
# 1. Jalankan stack (hermes-agent + wa-gateway)
docker compose up -d

# 2. Pantau log untuk melakukan scan QR Code WhatsApp
docker compose logs -f wa-gateway
```

Setelah QR code di-scan dan status menunjukkan `[WA] Client ready!`, bot siap digunakan.

---

### 3. Deployment via Portainer

1. Buka dashboard **Portainer** $\rightarrow$ pilih environment Anda.
2. Masuk ke menu **Stacks** $\rightarrow$ Klik **Add stack**.
3. Beri nama stack (misal: `wabot-assistant`).
4. Tempelkan isi file [docker-compose.yml](file:///c:/Users/ferdi/Documents/ferdinand_dev/PersonalProject/wa-projek/waBotAssistant/docker-compose.yml) ke Web editor.
5. Pada bagian **Environment variables**, tambahkan variabel:
   - `HERMES_API_KEY`
   - `HERMES_SECRET`
   - `OWNER_NUMBER`
   - `ALLOWED_USERS`
   - `ALLOWED_GROUPS`
6. Klik **Deploy the stack**.
7. Buka menu **Containers** $\rightarrow$ klik ikon **Logs** pada container `wabot-gateway` untuk melakukan scan QR Code.

---

## 🔄 CI/CD & Deployment Otomatis

Projek ini dilengkapi GitHub Actions workflow (`.github/workflows/deploy.yml`) yang otomatis melakukan build Docker image, push ke Docker Hub, dan deploy ke VPS via SSH saat push ke branch `production`.

### Konfigurasi GitHub Repository Secrets:

Tambahkan secrets berikut pada repository GitHub (**Settings $\rightarrow$ Secrets and variables $\rightarrow$ Actions**):

- `DOCKERHUB_USERNAME`: Username Docker Hub Anda
- `DOCKERHUB_TOKEN`: Personal Access Token Docker Hub
- `SSH_HOST`: IP Publik / Domain VPS
- `SSH_USERNAME`: User login VPS (misal: `root` atau `ubuntu`)
- `SSH_KEY`: Private SSH Key (RSA / ED25519)
- `SSH_PORT`: Port SSH (default: `22`)

---

## ❓ Troubleshooting & FAQ

<details>
<summary><b>1. QR Code tidak terbaca / terpotong di Terminal?</b></summary>

- Perbesar ukuran jendela terminal Anda atau perkecil font terminal.
- Jika menggunakan Docker, gunakan perintah `docker compose logs wa-gateway` dengan ukuran terminal penuh.
</details>

<details>
<summary><b>2. Apakah sesi WhatsApp tersimpan setelah container di-restart?</b></summary>

Ya. Sesi WhatsApp disimpan dalam Docker volume `wabot-wa-auth` (`/app/.wwebjs_auth`). Sesi tidak akan hilang selama volume tersebut tidak dihapus.
</details>

<details>
<summary><b>3. Bagaimana cara menambahkan anggota baru ke grup bot?</b></summary>

Tambahkan nomor WhatsApp anggota ke variabel `ALLOWED_USERS` pada file `.env` (atau di Portainer Stack Environment), kemudian restart/update stack container.
</details>

<details>
<summary><b>4. Error Puppeteer / Chromium zombie processes?</b></summary>

Dockerfile telah menggunakan `dumb-init` sebagai PID 1 dan flag Chromium anti-sandbox/no-zygote yang secara otomatis membersihkan zombie process dan mencegah memory leak.
</details>

---

## 📄 Lisensi

Projek ini dilisensikan di bawah lisensi [ISC](LICENSE).