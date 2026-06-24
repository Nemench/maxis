#!/usr/bin/env bash
# MAXIS KOT — update script
# Run from anywhere: bash /opt/maxis/update.sh
set -euo pipefail

APP_DIR="/opt/maxis"
SERVICE="maxis"

echo "[MAXIS] Pulling latest code..."
cd "$APP_DIR"
git pull

echo "[MAXIS] Rebuilding frontend..."
npm run build

echo "[MAXIS] Restarting service..."
systemctl restart "$SERVICE"

echo "[MAXIS] Done. Service status:"
systemctl status "$SERVICE" --no-pager -l | head -8
