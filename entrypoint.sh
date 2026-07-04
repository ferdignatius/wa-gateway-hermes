#!/bin/sh
# entrypoint.sh — Dijalankan oleh dumb-init sebelum Node.js app dimulai
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "▶  WA Gateway — Startup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Jalankan migrasi database (idempotent, aman dijalankan tiap restart)
echo "[1/3] Running Prisma database migration..."
node_modules/.bin/prisma migrate deploy

echo "[2/3] Seeding default database data..."
node_modules/.bin/prisma db seed

echo "[3/3] Starting application server..."
exec node dist/index.js
