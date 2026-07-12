#!/usr/bin/env bash
# NemenchPos — one-line installer for Debian/Ubuntu (Proxmox LXC or any server)
# Usage: curl -sSL https://raw.githubusercontent.com/Nemench/NemenchPos/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/Nemench/NemenchPos.git"
APP_DIR="/opt/nemenchpos"
PORT="${PORT:-3000}"
SERVICE="nemenchpos"
# Optional multi-tenant control-plane sync (see server/controlPlaneSync.ts)
# — if unset, this instance just never syncs and runs as a fully offline,
# standalone install (the default/existing behavior, unaffected either way).
NEMENCHPOS_CONTROL_PLANE_URL="${NEMENCHPOS_CONTROL_PLANE_URL:-}"
NEMENCHPOS_CONTROL_API_KEY="${NEMENCHPOS_CONTROL_API_KEY:-}"
# WhatsApp Cloud API (CRM automation — see server/whatsapp/). All optional:
# unset, the outbox worker just fails every send attempt harmlessly and the
# inbound webhook 403s Meta's verification handshake. whatsapp_number_id
# itself is NOT set here — it comes down from the control-plane business
# profile (see server/whatsapp/metaClient.ts); only real per-instance
# secrets live here.
WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN:-}"
WHATSAPP_WEBHOOK_VERIFY_TOKEN="${WHATSAPP_WEBHOOK_VERIFY_TOKEN:-}"
WHATSAPP_APP_SECRET="${WHATSAPP_APP_SECRET:-}"
# Email order notifications via SMTP (see server/email/). All optional:
# unset, the outbox worker just fails every send attempt harmlessly (order
# flow itself is never affected either way). Any normal business email
# account's SMTP details work here, or point this at a self-hosted mail
# server if you'd rather not use a third party. EMAIL_FROM_ADDRESS is the
# address customers see as the sender — most providers require it to match
# (or be authorized for) EMAIL_SMTP_USER.
EMAIL_SMTP_HOST="${EMAIL_SMTP_HOST:-}"
EMAIL_SMTP_PORT="${EMAIL_SMTP_PORT:-587}"
EMAIL_SMTP_USER="${EMAIL_SMTP_USER:-}"
EMAIL_SMTP_PASS="${EMAIL_SMTP_PASS:-}"
EMAIL_FROM_ADDRESS="${EMAIL_FROM_ADDRESS:-}"
# Real, publicly-reachable web address (e.g. https://yourshop.com) used to
# build image/unsubscribe links inside emails. Without this, the logo and
# any campaign images are left out of emails rather than embedded broken —
# mail clients strip inline data: images and can't reach a LAN address.
# Also settable from the app itself (Settings → Email notifications →
# Public URL); this env var is just an alternate way to set the same value.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

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
apt-get install -y -qq curl git build-essential python3 cups-client avahi-utils

# ── Caddy (HTTPS reverse proxy) ───────────────────────────────────────────────
# Clean up any leftover files from a previous failed install attempt
rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
rm -f /etc/apt/sources.list.d/caddy-stable.list

if ! command -v caddy &>/dev/null; then
  info "Installing Caddy (automatic HTTPS)..."
  # Download binary directly from GitHub — no GPG keys or apt repos needed
  CADDY_VER=$(curl -fsSL "https://api.github.com/repos/caddyserver/caddy/releases/latest" \
    | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/' | head -1)
  if [ -z "$CADDY_VER" ]; then
    warn "Could not fetch Caddy version — skipping HTTPS setup"
    warn "Install manually later: https://caddyserver.com/docs/install"
  else
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin caddy
    chmod +x /usr/local/bin/caddy

    # Caddy needs its own user to bind ports 80/443 safely
    id caddy &>/dev/null || useradd --system --home /var/lib/caddy --shell /sbin/nologin caddy
    mkdir -p /var/lib/caddy /etc/caddy
    chown -R caddy:caddy /var/lib/caddy

    # Systemd unit (mirrors the official Caddy package service file)
    cat > /etc/systemd/system/caddy.service <<'CADDY_SVC'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true

[Install]
WantedBy=multi-user.target
CADDY_SVC

    systemctl daemon-reload
    ok "Caddy v${CADDY_VER} installed"
  fi
else
  ok "Caddy already installed ($(caddy version 2>/dev/null || echo unknown))"
fi

# Create Caddyfile if not already configured for NemenchPos
CADDYFILE="/etc/caddy/Caddyfile"
if ! grep -qi "nemenchpos\|$PORT" "$CADDYFILE" 2>/dev/null; then
  info "Writing Caddy config..."
  cat > "$CADDYFILE" <<CADDY
# NemenchPos — HTTPS reverse proxy
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
Description=NemenchPos KOT Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=NEMENCHPOS_CONTROL_PLANE_URL=${NEMENCHPOS_CONTROL_PLANE_URL:-}
Environment=NEMENCHPOS_CONTROL_API_KEY=${NEMENCHPOS_CONTROL_API_KEY:-}
Environment=WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN:-}
Environment=WHATSAPP_WEBHOOK_VERIFY_TOKEN=${WHATSAPP_WEBHOOK_VERIFY_TOKEN:-}
Environment=WHATSAPP_APP_SECRET=${WHATSAPP_APP_SECRET:-}
Environment=EMAIL_SMTP_HOST=${EMAIL_SMTP_HOST:-}
Environment=EMAIL_SMTP_PORT=${EMAIL_SMTP_PORT:-}
Environment=EMAIL_SMTP_USER=${EMAIL_SMTP_USER:-}
Environment=EMAIL_SMTP_PASS=${EMAIL_SMTP_PASS:-}
Environment=EMAIL_FROM_ADDRESS=${EMAIL_FROM_ADDRESS:-}
Environment=PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
ok "NemenchPos service started"

# ── Done ──────────────────────────────────────────────────────────────────────
# Box width/padding is computed from actual content (not hardcoded spaces),
# so this stays aligned regardless of how long $IP/$PORT happen to be.
IP=$(hostname -I | awk '{print $1}')
BOX_WIDTH=56
box_line() { printf "${GREEN}║ %-${BOX_WIDTH}s ║${NC}\n" "$1"; }
echo ""
echo -e "${GREEN}╔$(printf '═%.0s' $(seq 1 $((BOX_WIDTH + 2))))╗${NC}"
box_line "NemenchPos is running!"
box_line ""
box_line "Local:   http://${IP}:${PORT}"
box_line "Default: Admin / 0000  (change after first login)"
echo -e "${GREEN}╚$(printf '═%.0s' $(seq 1 $((BOX_WIDTH + 2))))╝${NC}"
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
