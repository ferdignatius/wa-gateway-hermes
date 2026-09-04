# ── Stage 1: Build (Menggunakan Bun) ─────────────────────────────────────────
FROM oven/bun:1-slim AS builder

WORKDIR /app

# Copy package files dan bun.lock
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ── Stage 2: Production (Node.js 22 + Chromium) ──────────────────────────────
# Menggunakan Node.js 22 untuk runtime produksi guna menjamin stabilitas Puppeteer
# dan Chrome DevTools WebSocket protocol pada whatsapp-web.js.
FROM node:22-slim AS production

# Install dumb-init + Chromium + curl (untuk docker healthcheck)
# (fonts-ipafont-gothic & fonts-wqy-zenhei untuk render emoji/karakter khusus WA)
RUN apt-get update && apt-get install -y --no-install-recommends --fix-missing \
    dumb-init \
    chromium \
    curl \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

# Konfigurasi Environment Puppeteer & App
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    EXPRESS_PORT=4849

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Menyalin node_modules dari builder (diinstall super-cepat via Bun)
COPY --from=builder /app/node_modules ./node_modules

# ── App artifacts ──────────────────────────────────────────────────────────
COPY --from=builder /app/dist ./dist

# ── Permission & Security ──────────────────────────────────────────────────
# Buat direktori mount-point volume SEBELUM ganti USER agar Docker
# menginisialisasi named volume dengan kepemilikan node (bukan root).
RUN mkdir -p .wwebjs_auth .wwebjs_cache \
    && chown -R node:node /app

# Copy entrypoint script dengan kepemilikan node
COPY --chown=node:node entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Jalankan container dengan user non-root demi keamanan
USER node

# Expose port internal untuk diakses via proxy-tier oleh Nginx Proxy Manager
EXPOSE 4849

# dumb-init sebagai PID 1 agar Chromium zombie processes dibersihkan
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./entrypoint.sh"]
