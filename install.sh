#!/usr/bin/env bash
# MAXIS KOT — one-line installer for Debian/Ubuntu (Proxmox LXC or any server)
# Usage: bash <(curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/maxis/main/install.sh)
set -euo pipefail

REPO_URL="https://github.com/YOUR_USERNAME/maxis.git"   # <── change this
APP_DIR="/opt/maxis"
PORT="${PORT:-3000}"
SERVICE="maxis"

RED='\033[0;31m'; BLUE='\033[0;34m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { echo -e "${BLUE}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✔ $*${NC}"; }
error() { echo -e "${RED}✘ $*${NC}"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "Run as root (sudo bash install.sh)"

# ── Dependencies ──────────────────────────────────────────────────────────────
info "Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential python3

# Node.js 20 via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
ok "Node $(node -v) ready"

# ── Clone / update repo ───────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing install..."
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$APP_DIR"
npm ci --prefer-offline

info "Building frontend..."
npm run build
ok "Build complete"

# ── Data directory ────────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/data"

# ── Systemd service ───────────────────────────────────────────────────────────
info "Installing systemd service..."
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=MAXIS KOT Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"
ok "Service enabled and started"

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   MAXIS is running!                      ║${NC}"
echo -e "${GREEN}║   http://${IP}:${PORT}                   ║${NC}"
echo -e "${GREEN}║   Default login: Admin / 0000            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Manage service:  systemctl [start|stop|restart|status] $SERVICE"
echo "  View logs:       journalctl -u $SERVICE -f"
echo "  Update:          bash $APP_DIR/install.sh"
