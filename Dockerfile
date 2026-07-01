# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --config.network-timeout=600000 --config.fetch-retries=5 --network-concurrency=1

COPY prisma ./prisma/
# Generate Prisma Client di stage builder
RUN pnpm exec prisma generate

COPY . .
RUN pnpm run build

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-slim AS production

# Install dumb-init + Chromium
# (fonts-ipafont-gothic & fonts-wqy-zenhei untuk render emoji/karakter khusus WA)
# apt secara otomatis menarik seluruh shared libraries Chromium — tidak perlu eksplisit
RUN apt-get update && apt-get install -y --no-install-recommends --fix-missing \
    dumb-init \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

# Konfigurasi Environment Puppeteer
# CATATAN: binaryTargets Prisma dikonfigurasi di prisma/schema.prisma, bukan di sini
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files dan install hanya production dependencies
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --prod --frozen-lockfile --config.network-timeout=600000 --config.fetch-retries=5 --network-concurrency=1

# ── Prisma: Copy engine binaries + client ──────────────────────────────────
# Salin engine biner yang sudah di-generate di builder (openssl 3.x / bullseye)
COPY --from=builder /app/node_modules/.prisma        ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# ── App artifacts ──────────────────────────────────────────────────────────
# Copy hasil compile dan skema database
COPY --from=builder /app/dist   ./dist
COPY --from=builder /app/prisma ./prisma

# ── Permission & Security ──────────────────────────────────────────────────
# Buat direktori mount-point volume SEBELUM ganti USER agar Docker
# menginisialisasi named volume dengan kepemilikan node (bukan root).
# Ini mencegah EACCES error saat container pertama kali dijalankan.
RUN mkdir -p .wwebjs_auth .wwebjs_cache \
    && chown -R node:node /app

# Copy entrypoint script dengan kepemilikan node
COPY --chown=node:node entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Jalankan container dengan user non-root demi keamanan
USER node

EXPOSE 4849

# dumb-init sebagai PID 1 agar Chromium zombie processes dibersihkan
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# entrypoint.sh menjalankan prisma migrate deploy lalu node dist/index.js
CMD ["./entrypoint.sh"]
