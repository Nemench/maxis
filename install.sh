#!/usr/bin/env bash
# MAXIS KOT — one-line installer for Debian/Ubuntu (Proxmox LXC or any server)
# Usage: curl -sSL https://raw.githubusercontent.com/Nemench/maxis/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/Nemench/maxis.git"
APP_DIR="/opt/maxis"
PORT="${PORT:-3000}"
SERVICE="maxis"

RED='\033[0;31m'; BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${BLUE}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✔ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
error() { echo -e "${RED}✘ $*${NC}"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "Run as root (sudo bash install.sh)"

# ── System dependencies ───────────────────────────────────────────────────────
info "Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl git build-essential python3 \
  cups-client avahi-utils \
  debian-keyring debian-archive-keyring apt-transport-https

# ── Caddy (HTTPS reverse proxy) ───────────────────────────────────────────────
if ! command -v caddy &>/dev/null; then
  info "Installing Caddy (automatic HTTPS)..."
  curl -1sLf 'https://dl.cloudflare.com/cloudflare-pkg/gpg/caddy-stable.gpg' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudflare.com/cloudflare-pkg/install/caddy/stable/deb/any-version/main.list' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "Caddy installed"
else
  ok "Caddy already installed ($(caddy version))"
fi

# Create Caddyfile if not already configured for MAXIS
CADDYFILE="/etc/caddy/Caddyfile"
if ! grep -q "maxis\|$PORT" "$CADDYFILE" 2>/dev/null; then
  info "Writing Caddy config..."
  cat > "$CADDYFILE" <<CADDY
# MAXIS KOT — HTTPS reverse proxy
# Replace "yourdomain.com" with your actual domain name, then:
#   systemctl reload caddy
#
# Caddy will automatically get a free Let's Encrypt certificate.
# Your router must forward ports 80 and 443 to this server.

yourdomain.com {
    reverse_proxy localhost:${PORT}
}
CADDY
  warn "Caddy config written to $CADDYFILE"
  warn "Edit it with your real domain, then run: systemctl reload caddy"
fi

systemctl enable caddy
systemctl start caddy 2>/dev/null || true

# ── Node.js 20 ────────────────────────────────────────────────────────────────
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
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
ok "MAXIS service started"

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   MAXIS KOT is running!                              ║${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
echo -e "${GREEN}║   Local:   http://${IP}:${PORT}                      ║${NC}"
echo -e "${GREEN}║   Default: Admin / 0000  (change after first login)  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}  ── HTTPS setup (required for internet access) ─────────────${NC}"
echo    "  1. Point a domain name at this server's public IP"
echo    "  2. Forward ports 80 and 443 on your router to this server"
echo    "  3. Edit /etc/caddy/Caddyfile — replace 'yourdomain.com' with your domain"
echo    "  4. Run: systemctl reload caddy"
echo    "  Caddy will automatically get a free SSL certificate."
echo ""
echo    "  Manage service:  systemctl [start|stop|restart|status] $SERVICE"
echo    "  View logs:       journalctl -u $SERVICE -f"
echo    "  Update:          bash $APP_DIR/install.sh"
