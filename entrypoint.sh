#!/bin/sh
# entrypoint.sh — Dijalankan oleh dumb-init sebelum Node.js app dimulai
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "▶  WA Gateway (Pure Mode) — Starting..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exec node dist/index.js
